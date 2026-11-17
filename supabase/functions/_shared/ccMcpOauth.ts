/**
 * OAuth 2.1 (PKCE S256) + Dynamic Client Registration for the Control Center MCP.
 * Opaque tokens are stored as SHA-256 hashes. Consent is a Control Center owner
 * session. No static connector bearer is accepted or issued.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export const CC_MCP_SCOPE = "control_center";
export const CC_MCP_ACTOR = "control_center_mcp";
export const ACCESS_TOKEN_TTL_SEC = 3600;
export const REFRESH_TOKEN_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

const CLAUDE_HOSTS = new Set(["claude.ai", "www.claude.ai", "claude.com", "www.claude.com"]);
const OPENAI_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com", "chat.openai.com", "www.chat.openai.com"]);

export function mcpPublicBaseUrl(): string {
  const explicit = (Deno.env.get("CC_MCP_PUBLIC_URL") || "").trim().replace(/\/$/, "");
  if (explicit) return explicit;
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").trim().replace(/\/$/, "");
  return `${supabaseUrl}/functions/v1/control-center-mcp`;
}

export function mcpResourceUrl(base = mcpPublicBaseUrl()): string {
  return `${base}/mcp`;
}

export function consentAppUrl(): string {
  return (
    (Deno.env.get("CC_PUBLIC_APP_URL") || "").trim().replace(/\/$/, "") ||
    "https://fendi-control-center.lovable.app"
  );
}

export function protectedResourceMetadata(base = mcpPublicBaseUrl()) {
  return {
    resource: mcpResourceUrl(base),
    authorization_servers: [base],
    scopes_supported: [CC_MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/fendifrost-dot/fendi-control-center/blob/main/docs/CONTROL_CENTER_MCP.md",
  };
}

export function authorizationServerMetadata(base = mcpPublicBaseUrl()) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [CC_MCP_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    authorization_response_iss_parameter_supported: true,
  };
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkceS256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Board actor stored on writes and used to match muse-alerts subscribers. */
export function actorLabelFromClientName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("chatgpt") || lower.includes("openai")) return "chatgpt";
  if (lower.includes("claude")) return "claude";
  const slug = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return slug;
  return "mcp-client";
}

function openaiCallbackPath(pathname: string): boolean {
  if (pathname === "/connector_platform_oauth_redirect") return true;
  if (/^\/connector\/oauth\/[A-Za-z0-9_-]{1,200}$/.test(pathname)) return true;
  if (pathname === "/aip/oauth/callback") return true;
  if (/^\/aip\/plugin-[A-Za-z0-9_-]{1,128}\/oauth\/callback$/.test(pathname)) return true;
  return false;
}

/**
 * Redirect allowlist.
 * ChatGPT (OpenAI connector docs, checked 2026-11-17): with RFC 9207 issuer
 * identification, the stable callback is
 * https://chatgpt.com/connector_platform_oauth_redirect. Without it, ChatGPT
 * uses https://chatgpt.com/connector/oauth/{callback_id}. chat.openai.com keeps
 * the same paths plus the older /aip plugin callback.
 * Claude: any https path on claude.ai / claude.com (and their subdomains).
 * Loopback http is for a local MCP inspector only.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.pathname.includes("\\") || url.pathname.includes("..")) return false;
  const host = url.hostname.toLowerCase();
  if (url.protocol === "http:") {
    return (host === "127.0.0.1" || host === "localhost") && url.port !== "";
  }
  if (url.protocol !== "https:") return false;
  if (CLAUDE_HOSTS.has(host) || host.endsWith(".claude.ai") || host.endsWith(".claude.com")) return true;
  if (OPENAI_HOSTS.has(host)) return openaiCallbackPath(url.pathname);
  return false;
}

export function consentPageUrl(appUrl: string, params: Record<string, string>): string {
  const url = new URL(`${appUrl.replace(/\/$/, "")}/oauth/mcp-authorize`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** RFC 9207: every authorize redirect carries the exact issuer string. */
export function authorizationRedirect(
  redirectUri: string,
  params: Record<string, string>,
  issuer: string,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  url.searchParams.set("iss", issuer);
  return url.toString();
}

export function resourceMatches(resource: string | null | undefined, base = mcpPublicBaseUrl()): boolean {
  if (resource === null || resource === undefined || resource === "") return true;
  return resource === mcpResourceUrl(base);
}

function oauthError(error: string, description: string, status: number) {
  return { status, data: { error, error_description: description } };
}

export async function registerClient(
  sb: SupabaseClient,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!redirectUris.length) {
    return oauthError("invalid_client_metadata", "redirect_uris required", 400);
  }
  if (!redirectUris.every(isAllowedRedirectUri)) {
    return oauthError("invalid_redirect_uri", "redirect_uri is not on the allowlist", 400);
  }
  const requestedMethod = body.token_endpoint_auth_method == null
    ? "none"
    : String(body.token_endpoint_auth_method);
  if (requestedMethod !== "none" && requestedMethod !== "client_secret_post") {
    return oauthError("invalid_client_metadata", "token_endpoint_auth_method must be none or client_secret_post", 400);
  }
  if (body.grant_types !== undefined) {
    if (!Array.isArray(body.grant_types) || body.grant_types.length === 0) {
      return oauthError("invalid_client_metadata", "grant_types must include authorization_code", 400);
    }
    const grants = body.grant_types.map(String);
    if (!grants.includes("authorization_code") || grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
      return oauthError("invalid_client_metadata", "only authorization_code and refresh_token are supported", 400);
    }
  }
  if (body.response_types !== undefined) {
    const types = Array.isArray(body.response_types) ? body.response_types.map(String) : [];
    if (types.length !== 1 || types[0] !== "code") {
      return oauthError("invalid_client_metadata", "response_types must be code", 400);
    }
  }
  const clientName = body.client_name != null ? String(body.client_name).slice(0, 120) : "Control Center MCP";
  const actorLabel = actorLabelFromClientName(clientName);
  const clientId = `cc-mcp-${randomToken(8)}`;
  const confidential = requestedMethod === "client_secret_post";
  const clientSecret = confidential ? randomToken(24) : null;
  const { error } = await sb.from("cc_mcp_oauth_clients").insert({
    client_id: clientId,
    client_secret_hash: clientSecret ? await sha256Hex(clientSecret) : null,
    client_name: clientName,
    actor_label: actorLabel,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: requestedMethod,
  });
  if (error) return oauthError("server_error", "client registration failed", 500);
  const data: Record<string, unknown> = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: requestedMethod,
    client_name: clientName,
    scope: CC_MCP_SCOPE,
  };
  if (clientSecret) data.client_secret = clientSecret;
  return { status: 201, data };
}

export async function authorizeOwnerSession(
  sb: SupabaseClient,
  authorizationHeader: string | null,
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  if (!authorizationHeader?.toLowerCase().startsWith("bearer ")) {
    return { ok: false, error: "owner_session_required" };
  }
  const token = authorizationHeader.slice(7).trim();
  if (!token || token.length > 8192) return { ok: false, error: "owner_session_required" };
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return { ok: false, error: "invalid_session" };
  const { data: owner, error: ownerError } = await sb
    .from("control_center_owners")
    .select("user_id")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (ownerError) return { ok: false, error: "owner_check_failed" };
  if (!owner) return { ok: false, error: "only_owner_may_authorize" };
  return { ok: true, userId: data.user.id };
}

async function loadClient(sb: SupabaseClient, clientId: string) {
  const { data } = await sb
    .from("cc_mcp_oauth_clients")
    .select("client_id, client_secret_hash, redirect_uris, token_endpoint_auth_method, actor_label")
    .eq("client_id", clientId)
    .maybeSingle();
  return data;
}

export async function clientAllowsRedirect(
  sb: SupabaseClient,
  clientId: string,
  redirectUri: string,
): Promise<boolean> {
  if (!isAllowedRedirectUri(redirectUri)) return false;
  const client = await loadClient(sb, clientId);
  if (!client) return false;
  return ((client.redirect_uris as string[]) ?? []).includes(redirectUri);
}

export async function issueAuthCode(
  sb: SupabaseClient,
  opts: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope: string;
    resource: string | null;
    authorizedByUserId: string;
  },
): Promise<{ status: number; data: Record<string, unknown> }> {
  if (opts.codeChallengeMethod !== "S256" || !opts.codeChallenge || opts.codeChallenge.length > 256) {
    return oauthError("invalid_request", "S256 PKCE code_challenge required", 400);
  }
  if (opts.scope && opts.scope !== CC_MCP_SCOPE) return oauthError("invalid_scope", "scope must be control_center", 400);
  if (!opts.authorizedByUserId) return oauthError("access_denied", "owner approval required", 403);
  if (!resourceMatches(opts.resource)) return oauthError("invalid_target", "resource does not match this server", 400);
  if (!isAllowedRedirectUri(opts.redirectUri)) {
    return oauthError("invalid_request", "redirect_uri is not on the allowlist", 400);
  }
  const client = await loadClient(sb, opts.clientId);
  if (!client) return oauthError("invalid_client", "unknown client", 400);
  const uris = (client.redirect_uris as string[]) ?? [];
  if (!uris.includes(opts.redirectUri)) {
    return oauthError("invalid_request", "redirect_uri mismatch", 400);
  }
  const code = randomToken(24);
  const { error } = await sb.from("cc_mcp_oauth_codes").insert({
    code_hash: await sha256Hex(code),
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    scope: CC_MCP_SCOPE,
    resource: opts.resource || null,
    authorized_by_user_id: opts.authorizedByUserId,
    expires_at: new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString(),
  });
  if (error) return oauthError("server_error", "authorization code was not stored", 500);
  await cleanupExpiredOAuthRecords(sb);
  return { status: 200, data: { code } };
}

async function clientAuthenticates(
  client: { client_secret_hash: string | null; token_endpoint_auth_method: string },
  clientSecret: string,
): Promise<boolean> {
  if (client.token_endpoint_auth_method === "none") return true;
  if (!client.client_secret_hash || !clientSecret) return false;
  return timingSafeEqual(await sha256Hex(clientSecret), client.client_secret_hash);
}

export async function exchangeToken(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  base = mcpPublicBaseUrl(),
): Promise<{ status: number; data: Record<string, unknown> }> {
  const grant = String(body.grant_type ?? "");
  const clientId = String(body.client_id ?? "").trim();
  const clientSecret = body.client_secret != null ? String(body.client_secret) : "";
  if (!clientId || clientId.length > 200) return oauthError("invalid_client", "unknown client", 401);
  const client = await loadClient(sb, clientId);
  if (!client) return oauthError("invalid_client", "unknown client", 401);
  if (!await clientAuthenticates(client, clientSecret)) {
    return oauthError("invalid_client", "client authentication failed", 401);
  }
  const requestedResource = body.resource != null && String(body.resource) !== "" ? String(body.resource) : null;
  if (!resourceMatches(requestedResource, base)) {
    return oauthError("invalid_target", "resource does not match this server", 400);
  }

  if (grant === "authorization_code") {
    const code = String(body.code ?? "");
    const redirectUri = String(body.redirect_uri ?? "");
    const verifier = String(body.code_verifier ?? "");
    if (!code || !verifier || code.length > 512 || verifier.length > 256) {
      return oauthError("invalid_request", "code and code_verifier required", 400);
    }
    if (!isAllowedRedirectUri(redirectUri)) {
      return oauthError("invalid_grant", "redirect_uri is not on the allowlist", 400);
    }
    const access = randomToken(32);
    const refresh = randomToken(32);
    const accessExpires = new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000);
    const refreshExpires = new Date(Date.now() + REFRESH_TOKEN_MAX_LIFETIME_MS);
    const { data: rpcData, error: rpcErr } = await sb.rpc("cc_mcp_consume_oauth_code", {
      p_code_hash: await sha256Hex(code),
      p_client_id: clientId,
      p_redirect_uri: redirectUri,
      p_expected_challenge: await pkceS256Challenge(verifier),
      p_resource: requestedResource,
      p_access_token_hash: await sha256Hex(access),
      p_refresh_token_hash: await sha256Hex(refresh),
      p_access_expires_at: accessExpires.toISOString(),
      p_refresh_expires_at: refreshExpires.toISOString(),
    });
    if (rpcErr) {
      if (/could not find|does not exist|PGRST202/i.test(rpcErr.message)) {
        return oauthError("server_error", "cc_mcp_consume_oauth_code is not installed", 503);
      }
      return oauthError("server_error", "token exchange failed", 500);
    }
    const result = (rpcData ?? {}) as Record<string, unknown>;
    if (!result.ok) {
      return oauthError(String(result.code ?? "invalid_grant"), String(result.error ?? "invalid_grant"), 400);
    }
    return {
      status: 200,
      data: {
        access_token: access,
        token_type: "bearer",
        expires_in: ACCESS_TOKEN_TTL_SEC,
        refresh_token: refresh,
        scope: CC_MCP_SCOPE,
        refresh_expires_in: Math.floor(REFRESH_TOKEN_MAX_LIFETIME_MS / 1000),
      },
    };
  }

  if (grant === "refresh_token") {
    const refresh = String(body.refresh_token ?? "");
    if (!refresh || refresh.length > 512) return oauthError("invalid_request", "refresh_token required", 400);
    const access = randomToken(32);
    const newRefresh = randomToken(32);
    const accessExpires = new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000);
    const { data: rpcData, error: rpcErr } = await sb.rpc("cc_mcp_rotate_oauth_refresh", {
      p_refresh_token_hash: await sha256Hex(refresh),
      p_client_id: clientId,
      p_resource: requestedResource,
      p_new_access_token_hash: await sha256Hex(access),
      p_new_refresh_token_hash: await sha256Hex(newRefresh),
      p_access_expires_at: accessExpires.toISOString(),
    });
    if (rpcErr) {
      if (/could not find|does not exist|PGRST202/i.test(rpcErr.message)) {
        return oauthError("server_error", "cc_mcp_rotate_oauth_refresh is not installed", 503);
      }
      return oauthError("server_error", "refresh failed", 500);
    }
    const result = (rpcData ?? {}) as Record<string, unknown>;
    if (!result.ok) {
      return oauthError(String(result.code ?? "invalid_grant"), String(result.error ?? "invalid_grant"), 400);
    }
    const refreshExpAt = result.refresh_expires_at
      ? new Date(String(result.refresh_expires_at)).getTime()
      : Date.now();
    return {
      status: 200,
      data: {
        access_token: access,
        token_type: "bearer",
        expires_in: ACCESS_TOKEN_TTL_SEC,
        refresh_token: newRefresh,
        scope: CC_MCP_SCOPE,
        refresh_expires_in: Math.max(0, Math.floor((refreshExpAt - Date.now()) / 1000)),
      },
    };
  }

  return oauthError("unsupported_grant_type", "grant_type is not supported", 400);
}

export async function revokeToken(
  sb: SupabaseClient,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const token = String(body.token ?? "").trim();
  if (!token || token.length > 512) return oauthError("invalid_request", "token required", 400);
  const hash = await sha256Hex(token);
  const now = new Date().toISOString();
  await sb.from("cc_mcp_oauth_tokens").update({ revoked_at: now }).eq("token_hash", hash);
  await sb.from("cc_mcp_oauth_tokens").update({ revoked_at: now }).eq("refresh_token_hash", hash);
  return { status: 200, data: {} };
}

export async function cleanupExpiredOAuthRecords(sb: SupabaseClient): Promise<void> {
  try {
    await sb.rpc("cc_mcp_oauth_cleanup_expired");
  } catch {
    await sb.from("cc_mcp_oauth_codes").delete().lt("expires_at", new Date().toISOString());
  }
}

export interface BearerActor {
  actorKind: string;
  actorLabel: string;
  scope: string;
  clientId: string;
}

export async function resolveBearerActor(
  sb: SupabaseClient,
  authorizationHeader: string | null,
): Promise<{ ok: true; actor: BearerActor } | { ok: false; error: string }> {
  if (!authorizationHeader?.toLowerCase().startsWith("bearer ")) {
    return { ok: false, error: "missing_bearer" };
  }
  const token = authorizationHeader.slice(7).trim();
  if (!token || token.length > 512) return { ok: false, error: "missing_bearer" };
  const { data } = await sb
    .from("cc_mcp_oauth_tokens")
    .select("actor_kind, actor_label, scope, client_id, resource, expires_at, revoked_at")
    .eq("token_hash", await sha256Hex(token))
    .maybeSingle();
  if (!data || data.revoked_at) return { ok: false, error: "invalid_token" };
  if (new Date(String(data.expires_at)).getTime() < Date.now()) return { ok: false, error: "token_expired" };
  if (String(data.actor_kind ?? "") !== CC_MCP_ACTOR) return { ok: false, error: "invalid_token" };
  if (String(data.scope ?? "") !== CC_MCP_SCOPE) return { ok: false, error: "invalid_token" };
  if (!resourceMatches(data.resource == null ? null : String(data.resource))) {
    return { ok: false, error: "invalid_token" };
  }
  const actorLabel = String(data.actor_label ?? "");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(actorLabel)) return { ok: false, error: "invalid_token" };
  return {
    ok: true,
    actor: {
      actorKind: CC_MCP_ACTOR,
      actorLabel,
      scope: CC_MCP_SCOPE,
      clientId: String(data.client_id ?? ""),
    },
  };
}

const SECRET_ENV_KEYS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "MUSE_API_TOKEN",
  "MUSE_IG_RECEIPT_SECRET",
  "MUSE_ALERT_SEAL_KEY",
];

export function configuredSecrets(): string[] {
  return SECRET_ENV_KEYS.map((key) => (Deno.env.get(key) ?? "").trim()).filter((value) => value.length >= 8);
}

/** Replace known secret values. Never log the input. */
export function scrubSecrets(value: unknown, secrets = configuredSecrets()): unknown {
  const live = secrets.filter((secret) => secret.length >= 8);
  if (live.length === 0) return value;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return { error: "unserializable" };
  }
  if (!live.some((secret) => text.includes(secret))) return value;
  for (const secret of live) text = text.split(secret).join("[redacted]");
  try {
    return JSON.parse(text);
  } catch {
    return { error: "redacted" };
  }
}

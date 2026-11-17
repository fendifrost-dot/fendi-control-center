/**
 * Remote MCP for the Control Center Muse board.
 *
 * Streamable HTTP JSON-RPC: POST /mcp
 * OAuth 2.1 + PKCE S256 + dynamic client registration.
 * Consent is the Control Center owner session. No static bearer token.
 *
 * Tools call the same Muse read, workboard write, and alert functions as
 * muse-executive, muse-workboard, and muse-alerts.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  authorizationRedirect,
  authorizationServerMetadata,
  authorizeOwnerSession,
  CC_MCP_SCOPE,
  clientAllowsRedirect,
  consentAppUrl,
  consentPageUrl,
  exchangeToken,
  issueAuthCode,
  mcpPublicBaseUrl,
  mcpResourceUrl,
  protectedResourceMetadata,
  registerClient,
  resolveBearerActor,
  resourceMatches,
  revokeToken,
  scrubSecrets,
} from "../_shared/ccMcpOauth.ts";
import {
  CC_MCP_INSTRUCTIONS,
  CC_MCP_TOOLS,
  CC_MCP_TOOL_NAMES,
  retryAfterSeconds,
  runControlCenterTool,
} from "../_shared/ccMcpTools.ts";
import { databaseTimeoutBody, isDatabaseTimeout, MUSE_DB_TIMEOUT_MS } from "../_shared/museTokenAuth.ts";

const PROTOCOL = "2025-03-26";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, accept, apikey, mcp-protocol-version, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "WWW-Authenticate, MCP-Protocol-Version",
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

function sbAdmin() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return createClient(url, key, {
    auth: { persistSession: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(MUSE_DB_TIMEOUT_MS) }),
    },
  });
}

function pathOf(req: Request): string {
  const url = new URL(req.url);
  let path = url.pathname;
  const marker = "/control-center-mcp";
  const idx = path.indexOf(marker);
  if (idx >= 0) path = path.slice(idx + marker.length) || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  return path.replace(/\/$/, "") || "/";
}

function unauthorized(): Response {
  const metadata = `${mcpPublicBaseUrl()}/.well-known/oauth-protected-resource`;
  return json(401, { error: "unauthorized", error_description: "bearer token required" }, {
    "WWW-Authenticate": `Bearer realm="control-center", resource_metadata="${metadata}", scope="${CC_MCP_SCOPE}"`,
  });
}

function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (url.protocol === "https:") {
      return host === "chatgpt.com" || host === "chat.openai.com" || host === "claude.ai" || host === "claude.com"
        || host.endsWith(".claude.ai") || host.endsWith(".claude.com")
        || host === "fendi-control-center.lovable.app" || host.endsWith(".lovable.app");
    }
    return url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1");
  } catch {
    return false;
  }
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid_body");
    }
    return parsed as Record<string, unknown>;
  }
  const form = await req.formData();
  const body: Record<string, unknown> = {};
  form.forEach((value, key) => {
    body[key] = String(value);
  });
  return body;
}

function rpcResult(id: unknown, status: number, body: unknown, session: string | null): Response {
  const payload = {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: body,
      isError: status >= 400,
    },
  };
  const extra: Record<string, string> = { "MCP-Protocol-Version": PROTOCOL };
  if (session) extra["Mcp-Session-Id"] = session;
  if (status === 429) extra["Retry-After"] = retryAfterSeconds();
  return json(200, payload, extra);
}

async function handleMcp(req: Request): Promise<Response> {
  if (!originAllowed(req)) return json(403, { error: "forbidden_origin" });
  const session = req.headers.get("mcp-session-id");
  if (req.method === "DELETE") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
  if (req.method === "GET") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });

  const sb = sbAdmin();
  const bearer = await resolveBearerActor(sb, req.headers.get("authorization"));
  if (!bearer.ok) return unauthorized();

  let rpc: Record<string, unknown>;
  try {
    rpc = await readBody(req);
  } catch {
    return json(400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }
  const id = rpc.id ?? null;
  const method = String(rpc.method ?? "");
  const params = (typeof rpc.params === "object" && rpc.params && !Array.isArray(rpc.params)
    ? rpc.params
    : {}) as Record<string, unknown>;

  if (method === "initialize") {
    const requested = String(params.protocolVersion ?? PROTOCOL);
    return json(200, {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: requested === "2025-06-18" ? requested : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "control-center-mcp", version: "1.0.0" },
        instructions: CC_MCP_INSTRUCTIONS,
      },
    }, { "MCP-Protocol-Version": PROTOCOL });
  }
  if (method === "notifications/initialized" || method === "ping") {
    if (rpc.id === undefined) return new Response(null, { status: 202, headers: corsHeaders });
    return json(200, { jsonrpc: "2.0", id, result: {} });
  }
  if (method === "tools/list") {
    return json(200, { jsonrpc: "2.0", id, result: { tools: CC_MCP_TOOLS } });
  }
  if (method === "tools/call") {
    const name = String(params.name ?? "");
    const args = (typeof params.arguments === "object" && params.arguments && !Array.isArray(params.arguments)
      ? params.arguments
      : {}) as Record<string, unknown>;
    const result = await runControlCenterTool(name, args, sb, bearer.actor);
    return rpcResult(id, result.status, scrubSecrets(result.body), session);
  }
  return json(200, {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  const path = pathOf(req);
  const sb = sbAdmin();
  const base = mcpPublicBaseUrl();

  try {
    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
      return json(200, protectedResourceMetadata(base));
    }
    if (
      path === "/.well-known/oauth-authorization-server"
      || path === "/.well-known/openid-configuration"
      || path === "/.well-known/oauth-authorization-server/mcp"
    ) {
      return json(200, authorizationServerMetadata(base));
    }
    if (path === "/" || path === "/health") {
      return json(200, {
        ok: true,
        service: "control-center-mcp",
        oauth: true,
        consent: "control_center_owner",
        mcp: mcpResourceUrl(base),
        tools: CC_MCP_TOOL_NAMES,
      });
    }
    if (path === "/oauth/register" && req.method === "POST") {
      const result = await registerClient(sb, await readBody(req));
      return json(result.status, result.data);
    }
    if (path === "/oauth/revoke" && req.method === "POST") {
      const result = await revokeToken(sb, await readBody(req));
      return json(result.status, result.data);
    }
    if (path === "/oauth/authorize") {
      const url = new URL(req.url);
      if (req.method === "GET") {
        const clientId = url.searchParams.get("client_id") || "";
        const redirectUri = url.searchParams.get("redirect_uri") || "";
        const state = url.searchParams.get("state") || "";
        const challenge = url.searchParams.get("code_challenge") || "";
        const method = url.searchParams.get("code_challenge_method") || "";
        const scope = url.searchParams.get("scope") || CC_MCP_SCOPE;
        const resource = url.searchParams.get("resource") || "";
        const allowed = await clientAllowsRedirect(sb, clientId, redirectUri);
        if (!allowed) {
          return json(400, { error: "invalid_request", error_description: "client or redirect_uri rejected" });
        }
        if (method !== "S256" || !challenge || !resourceMatches(resource || null, base) || (scope && scope !== CC_MCP_SCOPE)) {
          const error = !challenge || method !== "S256"
            ? "invalid_request"
            : scope !== CC_MCP_SCOPE
            ? "invalid_scope"
            : "invalid_target";
          const location = authorizationRedirect(redirectUri, { error, state }, base);
          return new Response(null, {
            status: 302,
            headers: { ...corsHeaders, Location: location, "Cache-Control": "no-store" },
          });
        }
        const consent = consentPageUrl(consentAppUrl(), {
          client_id: clientId,
          redirect_uri: redirectUri,
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope,
          resource,
        });
        return new Response(null, {
          status: 302,
          headers: { ...corsHeaders, Location: consent, "Cache-Control": "no-store" },
        });
      }
      if (req.method === "POST") {
        const fields = await readBody(req);
        const asText = (key: string) => fields[key] == null ? "" : String(fields[key]);
        const redirectUri = asText("redirect_uri");
        const state = asText("state");
        const allowed = await clientAllowsRedirect(sb, asText("client_id"), redirectUri);
        if (!allowed) return json(400, { error: "invalid_request", error_description: "client or redirect_uri rejected" });
        if (asText("decision") === "cancel") {
          return json(200, {
            redirect_to: authorizationRedirect(redirectUri, { error: "access_denied", state }, base),
          });
        }
        const authz = await authorizeOwnerSession(sb, req.headers.get("authorization"));
        if (!authz.ok) return json(403, { error: "access_denied", error_description: authz.error });
        const resource = asText("resource");
        const issued = await issueAuthCode(sb, {
          clientId: asText("client_id"),
          redirectUri,
          codeChallenge: asText("code_challenge"),
          codeChallengeMethod: asText("code_challenge_method") || "S256",
          scope: asText("scope") || CC_MCP_SCOPE,
          resource: resource || null,
          authorizedByUserId: authz.userId,
        });
        if (issued.status !== 200) return json(issued.status, issued.data);
        return json(200, {
          redirect_to: authorizationRedirect(redirectUri, {
            code: String(issued.data.code),
            state,
          }, base),
        });
      }
    }
    if (path === "/oauth/token" && req.method === "POST") {
      const result = await exchangeToken(sb, await readBody(req), base);
      return json(result.status, result.data);
    }
    if (path === "/mcp") return handleMcp(req);
    return json(404, { error: "not_found" });
  } catch (error) {
    if (isDatabaseTimeout(error)) return json(503, databaseTimeoutBody());
    console.error("control_center_mcp_failed");
    return json(500, { error: "server_error" });
  }
});

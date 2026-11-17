import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  actorLabelFromClientName,
  authorizationRedirect,
  authorizationServerMetadata,
  isAllowedRedirectUri,
  pkceS256Challenge,
  protectedResourceMetadata,
  registerClient,
  resourceMatches,
  scrubSecrets,
} from "./ccMcpOauth.ts";

const BASE = "https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/control-center-mcp";

Deno.test("authorization metadata advertises PKCE, DCR, and issuer identification", () => {
  const metadata = authorizationServerMetadata(BASE);
  assertEquals(metadata.issuer, BASE);
  assertEquals(metadata.authorization_response_iss_parameter_supported, true);
  assertEquals(metadata.code_challenge_methods_supported, ["S256"]);
  assertEquals(metadata.registration_endpoint, `${BASE}/oauth/register`);
  assertEquals(metadata.token_endpoint_auth_methods_supported, ["none", "client_secret_post"]);
  assert(!("client_secret" in metadata));
  const resource = protectedResourceMetadata(BASE);
  assertEquals(resource.resource, `${BASE}/mcp`);
  assertEquals(resource.authorization_servers, [BASE]);
});

Deno.test("redirect allowlist matches the current ChatGPT and Claude callbacks", () => {
  const allowed = [
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://www.chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector/oauth/cb_abc-123",
    "https://chat.openai.com/connector/oauth/cb_abc-123",
    "https://chat.openai.com/aip/plugin-abc_1/oauth/callback",
    "https://chat.openai.com/aip/oauth/callback",
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "https://www.claude.ai/api/mcp/auth_callback",
    "https://api.claude.com/callback",
    "http://127.0.0.1:8787/callback",
    "http://localhost:3000/oauth/callback",
  ];
  for (const uri of allowed) assert(isAllowedRedirectUri(uri), uri);

  const rejected = [
    "https://chatgpt.com/other",
    "https://chatgpt.com.evil.com/connector_platform_oauth_redirect",
    "https://evilchatgpt.com/connector_platform_oauth_redirect",
    "http://chatgpt.com/connector_platform_oauth_redirect",
    "https://user:pass@chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector_platform_oauth_redirect#code",
    "https://claude.ai.evil.com/callback",
    "http://localhost/callback",
    "https://example.com/callback",
    "javascript:alert(1)",
  ];
  for (const uri of rejected) assert(!isAllowedRedirectUri(uri), uri);
});

Deno.test("authorize redirects carry the exact issuer", () => {
  const target = authorizationRedirect(
    "https://chatgpt.com/connector_platform_oauth_redirect",
    { code: "abc", state: "xyz" },
    BASE,
  );
  const url = new URL(target);
  assertEquals(url.searchParams.get("iss"), BASE);
  assertEquals(url.searchParams.get("code"), "abc");
  assertEquals(url.searchParams.get("state"), "xyz");
  assertEquals(url.origin + url.pathname, "https://chatgpt.com/connector_platform_oauth_redirect");
});

Deno.test("PKCE S256 matches the RFC 7636 vector", async () => {
  const challenge = await pkceS256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
  assertEquals(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

Deno.test("client names map to stable board actors", () => {
  assertEquals(actorLabelFromClientName("ChatGPT"), "chatgpt");
  assertEquals(actorLabelFromClientName("Claude"), "claude");
  assertEquals(actorLabelFromClientName("OpenAI Codex"), "chatgpt");
  assertEquals(actorLabelFromClientName("!!!"), "mcp-client");
});

Deno.test("resource must be this MCP endpoint when the client sends one", () => {
  assert(resourceMatches(null, BASE));
  assert(resourceMatches(`${BASE}/mcp`, BASE));
  assert(!resourceMatches("https://example.com/mcp", BASE));
  assert(!resourceMatches(`${BASE}/mcp/`, BASE));
});

Deno.test("public registration does not issue or store a client secret", async () => {
  const inserts: Record<string, unknown>[] = [];
  const sb = {
    from() {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  const result = await registerClient(sb as never, {
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  assertEquals(result.status, 201);
  assertEquals(result.data.token_endpoint_auth_method, "none");
  assert(!("client_secret" in result.data));
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].client_secret_hash, null);
  assertEquals(inserts[0].actor_label, "chatgpt");
  assert(!JSON.stringify(result.data).includes("client_secret_hash"));
});

Deno.test("a rejected redirect is not stored", async () => {
  let inserted = false;
  const sb = {
    from() {
      return {
        insert() {
          inserted = true;
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  const result = await registerClient(sb as never, {
    redirect_uris: ["https://evil.example/callback"],
    token_endpoint_auth_method: "none",
  });
  assertEquals(result.status, 400);
  assertEquals(inserted, false);
  assertEquals(result.data.error, "invalid_redirect_uri");
});

Deno.test("scrubSecrets removes secret values and keeps the rest", () => {
  const secret = "super-secret-value-123456";
  const cleaned = scrubSecrets({
    ok: true,
    message: `note ${secret} end`,
    nested: { token: secret },
  }, [secret]) as { message: string; nested: { token: string } };
  assert(!JSON.stringify(cleaned).includes(secret));
  assertStringIncludes(cleaned.message, "[redacted]");
  assertEquals(cleaned.nested.token, "[redacted]");
});

Deno.test("oauth migration locks the tables down", async () => {
  const sql = await Deno.readTextFile(new URL(
    "../../migrations/20261117120000_control_center_mcp_oauth.sql",
    import.meta.url,
  ));
  for (const table of ["cc_mcp_oauth_clients", "cc_mcp_oauth_codes", "cc_mcp_oauth_tokens"]) {
    assertStringIncludes(sql, `alter table public.${table} enable row level security`);
    assertStringIncludes(sql, `revoke all on public.${table} from public, anon, authenticated`);
  }
  assertEquals(sql.match(/grant\s+[^\n]+to\s+(anon|authenticated|public)\b/gi), null);
  assertStringIncludes(sql, "security definer");
  assertStringIncludes(sql, "set search_path = public");
  assertStringIncludes(sql, "grant execute on function public.cc_mcp_consume_oauth_code");
  assertStringIncludes(sql, "to service_role");
  assert(!sql.includes("client_secret text"));
  assertStringIncludes(sql, "client_secret_hash");
});

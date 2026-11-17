import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assessTokenRow,
  authenticateMuseToken,
  databaseTimeoutBody,
  isDatabaseTimeout,
  MUSE_DB_TIMEOUT_MS,
} from "./museTokenAuth.ts";

const SERVICE = "service-role-key";
const URL = "https://example.supabase.co";

function requestsOf(fetchImpl: typeof fetch & { requests?: Array<{ url: string; method: string; body: string | null }> }) {
  return fetchImpl.requests ?? [];
}

function scriptedFetch(handler: (url: string, init: RequestInit | undefined) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>): typeof fetch {
  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : null;
    requests.push({ url, method: init?.method ?? "GET", body });
    const result = await handler(url, init);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch & { requests: typeof requests };
  fetchImpl.requests = requests;
  return fetchImpl;
}

Deno.test("a missing token never calls the database", async () => {
  let called = false;
  const fetchImpl = (() => {
    called = true;
    return Promise.reject(new Error("fetch should not run"));
  }) as typeof fetch;
  const auth = await authenticateMuseToken({
    supabaseUrl: URL,
    serviceKey: SERVICE,
    token: "  ",
    fetchImpl,
  });
  assertEquals(called, false);
  assertEquals(auth.ok, false);
  if (!auth.ok) {
    assertEquals(auth.status, 401);
    assertEquals(auth.message, "missing token");
  }
});

Deno.test("the service-role key is rejected before a query", async () => {
  let called = false;
  const fetchImpl = (() => {
    called = true;
    return Promise.reject(new Error("fetch should not run"));
  }) as typeof fetch;
  const auth = await authenticateMuseToken({
    supabaseUrl: URL,
    serviceKey: SERVICE,
    token: SERVICE,
    fetchImpl,
  });
  assertEquals(called, false);
  assertEquals(auth.ok, false);
  if (!auth.ok) assertEquals(auth.message, "service-role key rejected");
});

Deno.test("the env bootstrap token skips the table", async () => {
  let called = false;
  const fetchImpl = (() => {
    called = true;
    return Promise.reject(new Error("fetch should not run"));
  }) as typeof fetch;
  const auth = await authenticateMuseToken({
    supabaseUrl: URL,
    serviceKey: SERVICE,
    token: "env-secret",
    envToken: "env-secret",
    fetchImpl,
  });
  assertEquals(called, false);
  assertEquals(auth, { ok: true, label: "env-bootstrap", scopes: ["read"], source: "env" });
});

Deno.test("a resolved row does not issue a second write", async () => {
  const fetchImpl = scriptedFetch(() => ({
    status: 200,
    body: [{ label: "grok-bot", scopes: ["read", "workboard:write"], expires_at: null, revoked_at: null }],
  }));
  const auth = await authenticateMuseToken({
    supabaseUrl: URL,
    serviceKey: SERVICE,
    token: "plain-token",
    fetchImpl,
    nowMs: Date.parse("2026-11-17T12:00:00Z"),
  });
  assertEquals(auth.ok, true);
  if (auth.ok) {
    assertEquals(auth.label, "grok-bot");
    assertEquals(auth.scopes, ["read", "workboard:write"]);
    assertEquals(auth.source, "table");
  }
  const requests = requestsOf(fetchImpl);
  assertEquals(requests.length, 1);
  assertEquals(requests[0].method, "POST");
  assertEquals(requests[0].url, `${URL}/rest/v1/rpc/muse_resolve_api_token`);
  assertEquals(requests[0].body?.includes("plain-token"), false);
});

Deno.test("an unknown hash is a 401, not a database failure", async () => {
  const fetchImpl = scriptedFetch(() => ({ status: 200, body: [] }));
  const auth = await authenticateMuseToken({
    supabaseUrl: URL,
    serviceKey: SERVICE,
    token: "nobody",
    fetchImpl,
  });
  assertEquals(auth.ok, false);
  if (!auth.ok) {
    assertEquals(auth.status, 401);
    assertEquals(auth.message, "unknown token");
  }
});

Deno.test("revoked and expired rows stay 401 and keep the label", () => {
  const revoked = assessTokenRow({
    label: "enki",
    scopes: ["read"],
    expires_at: null,
    revoked_at: "2026-11-01T00:00:00Z",
  }, Date.parse("2026-11-17T00:00:00Z"));
  assertEquals(revoked.ok, false);
  if (!revoked.ok) {
    assertEquals(revoked.message, "token revoked");
    assertEquals(revoked.label, "enki");
  }
  const expired = assessTokenRow({
    label: "enki",
    scopes: ["read"],
    expires_at: "2026-11-01T00:00:00Z",
    revoked_at: null,
  }, Date.parse("2026-11-17T00:00:00Z"));
  assertEquals(expired.ok, false);
  if (!expired.ok) assertEquals(expired.message, "token expired");
});

Deno.test("a missing resolver falls back to a read and does not update last_used_at", async () => {
  const fetchImpl = scriptedFetch((url) => {
    if (url.includes("/rpc/")) {
      return {
        status: 404,
        body: { code: "PGRST202", message: "Could not find the function public.muse_resolve_api_token" },
      };
    }
    return {
      status: 200,
      body: [{ label: "claude-code", scopes: ["read"], expires_at: null, revoked_at: null }],
    };
  });
  const auth = await authenticateMuseToken({
    supabaseUrl: URL,
    serviceKey: SERVICE,
    token: "fallback-token",
    fetchImpl,
  });
  assertEquals(auth.ok, true);
  if (auth.ok) assertEquals(auth.label, "claude-code");
  const requests = requestsOf(fetchImpl);
  assertEquals(requests.length, 2);
  assertEquals(requests[1].method, "GET");
  assertEquals(requests[1].url.includes("select=label,scopes,expires_at,revoked_at"), true);
  assertEquals(requests.some((request) => request.method === "PATCH" || request.method === "PUT"), false);
  assertEquals(requests[1].url.includes("fallback-token"), false);
});

Deno.test("an aborted lookup is a timeout 503 with no partial token", async () => {
  const fetchImpl = (() => Promise.reject(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }))) as typeof fetch;
  const auth = await authenticateMuseToken({
    supabaseUrl: URL,
    serviceKey: SERVICE,
    token: "slow",
    fetchImpl,
  });
  assertEquals(auth.ok, false);
  if (!auth.ok) {
    assertEquals(auth.status, 503);
    assertEquals(auth.error, "database_timeout");
    assertEquals(auth.message, databaseTimeoutBody().message);
  }
});

Deno.test("statement timeout codes and abort names are timeouts", () => {
  assertEquals(isDatabaseTimeout({ code: "57014", message: "canceling statement due to statement timeout" }), true);
  assertEquals(isDatabaseTimeout({ code: "55P03", message: "canceling statement due to lock timeout" }), true);
  assertEquals(isDatabaseTimeout(Object.assign(new Error("aborted"), { name: "AbortError" })), true);
  assertEquals(isDatabaseTimeout({ message: "unknown token" }), false);
  assertEquals(MUSE_DB_TIMEOUT_MS, 8000);
});

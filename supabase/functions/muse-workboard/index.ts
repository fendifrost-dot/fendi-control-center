import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  authenticateMuseToken,
  databaseTimeoutBody,
  isDatabaseTimeout,
  MUSE_DB_TIMEOUT_MS,
} from "../_shared/museTokenAuth.ts";
import { performWorkboardWrite } from "../_shared/museWorkboardWrite.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, x-muse-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function tokenFrom(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim() || null;
  return req.headers.get("x-muse-token")?.trim() || null;
}

function createDb() {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(MUSE_DB_TIMEOUT_MS) }),
    },
  });
}

async function authenticate(token: string | null) {
  const auth = await authenticateMuseToken({
    supabaseUrl: SUPABASE_URL,
    serviceKey: SERVICE_KEY,
    token,
  });
  if (!auth.ok) return auth;
  if (!auth.scopes.includes("workboard:write")) {
    return {
      ok: false as const,
      status: 401 as const,
      error: "unauthorized" as const,
      message: "token lacks workboard:write scope",
      label: auth.label,
    };
  }
  return auth;
}

serve(async (req) => {
  try {
    return await handle(req);
  } catch (error) {
    if (isDatabaseTimeout(error)) return json(databaseTimeoutBody(), 503);
    console.error("muse_workboard_unhandled");
    return json({ ok: false, error: "database_unavailable", message: "The database request failed." }, 503);
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const db = createDb();
  const auth = await authenticate(tokenFrom(req));
  if (!auth.ok) {
    if (auth.status === 503) return json({ ok: false, error: auth.error, message: auth.message }, 503);
    return json({ error: "unauthorized", message: auth.message }, 401);
  }
  const requestKey = (req.headers.get("idempotency-key") ?? "").trim();
  if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(requestKey)) return json({ error: "invalid_idempotency_key" }, 400);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const result = await performWorkboardWrite(db, { actor: auth.label, requestKey, body });
  return json(result.body, result.status);
}

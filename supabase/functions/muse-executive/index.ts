/**
 * muse-executive — read-only executive data surface for Muse.
 *
 * Security posture (see docs/MUSE_EXECUTIVE_LAYER.md):
 *   * GET only. Every other method is rejected before any data access.
 *   * Bearer token auth against sha256 hashes in public.muse_api_tokens,
 *     with an env bootstrap token for first use. No Supabase key is accepted
 *     as a Muse credential, and none is ever returned.
 *   * No arbitrary SQL and no caller-supplied table names: the resource map in
 *     contract.ts is a closed allowlist of curated views.
 *   * Fixed-window rate limit per token.
 *   * Every request is audited, allowed or not.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { authenticateMuseToken } from "../_shared/museTokenAuth.ts";
import {
  RESOURCES,
  IG_SEND_QUEUE_RESOURCE,
  hubSendQueueRequest,
  igSendQueueEnvelope,
} from "./contract.ts";
import {
  EXECUTIVE_RATE_LIMIT_REQUESTS,
  EXECUTIVE_RATE_LIMIT_WINDOW_SECONDS,
  executiveRateLimitBody,
  executiveRateLimited,
  readExecutiveResource,
} from "../_shared/museExecutiveRead.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-muse-token",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
/**
 * Bootstrap credential so the API is usable before a hashed token is minted.
 * Trimmed to match presentedToken(): secrets pasted into a dashboard often carry a
 * trailing newline or space, which would otherwise make the comparison impossible.
 */
const ENV_TOKEN = (Deno.env.get("MUSE_API_TOKEN") ?? "").trim();

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Client IP is hashed, never stored raw. */
async function hashIp(req: Request): Promise<string | null> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (!ip) return null;
  return (await sha256Hex(ip)).slice(0, 32);
}

function presentedToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim() || null;
  return req.headers.get("x-muse-token")?.trim() || null;
}

interface AuthResult {
  ok: boolean;
  label: string | null;
  reason?: string;
  status?: 401 | 503;
}

async function authenticate(token: string | null): Promise<AuthResult> {
  const auth = await authenticateMuseToken({
    supabaseUrl: SUPABASE_URL,
    serviceKey: SUPABASE_SERVICE_ROLE_KEY,
    token,
    envToken: ENV_TOKEN,
  });
  if (!auth.ok) {
    if (auth.status === 503) return { ok: false, label: null, status: 503, reason: auth.message };
    if (auth.message === "service-role key rejected") {
      return { ok: false, label: null, reason: "service-role key rejected as a Muse token" };
    }
    return { ok: false, label: auth.label, reason: auth.message };
  }
  if (auth.source !== "env" && !auth.scopes.includes("read")) {
    return { ok: false, label: auth.label, reason: "token lacks read scope" };
  }
  return { ok: true, label: auth.label };
}

async function audit(
  supabase: SupabaseClient,
  req: Request,
  entry: { token_label: string | null; resource: string; http_status: number; note?: string },
) {
  try {
    await supabase.from("muse_access_audit").insert({
      token_label: entry.token_label,
      resource: entry.resource,
      method: req.method,
      http_status: entry.http_status,
      ip_hash: await hashIp(req),
      user_agent: req.headers.get("user-agent")?.slice(0, 200) ?? null,
      note: entry.note ?? null,
    });
  } catch {
    // Auditing is best effort: it must never take the read surface down.
  }
}

/** "/functions/v1/muse-executive/executive/brief" -> "brief" */
function resolveResource(url: URL): string | null {
  const fromQuery = url.searchParams.get("resource");
  if (fromQuery) return fromQuery.trim().toLowerCase();

  const parts = url.pathname.split("/").filter(Boolean);
  const fnIndex = parts.indexOf("muse-executive");
  const tail = fnIndex >= 0 ? parts.slice(fnIndex + 1) : parts;
  const withoutPrefix = tail[0] === "executive" ? tail.slice(1) : tail;
  return withoutPrefix[0]?.toLowerCase() ?? null;
}

async function fetchIgSendQueue(url: URL): Promise<{ status: number; body: Record<string, unknown>; note?: string }> {
  const secret = (Deno.env.get("MUSE_IG_RECEIPT_SECRET") ?? "").trim();
  const hubUrl = (Deno.env.get("FANFUEL_HUB_URL") ?? "").trim();
  if (!secret) return { status: 503, note: "MUSE_IG_RECEIPT_SECRET missing", body: { error: "not_configured", message: "MUSE_IG_RECEIPT_SECRET is not configured on this project." } };
  if (!hubUrl) return { status: 503, note: "FANFUEL_HUB_URL missing", body: { error: "not_configured", message: "FANFUEL_HUB_URL is not configured on this project." } };
  let request: ReturnType<typeof hubSendQueueRequest>;
  try {
    request = hubSendQueueRequest({ hubUrl, secret, limit: Number(url.searchParams.get("limit") ?? 100) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "bad hub configuration";
    return { status: 503, note: message.slice(0, 300), body: { error: "not_configured", message } };
  }
  let response: Response;
  try {
    response = await fetch(request.url, request.init);
  } catch {
    return { status: 502, note: "hub request failed", body: { error: "hub_unreachable", message: "FanFuel Hub request failed. Nothing was sent." } };
  }
  const text = await response.text();
  let hubBody: unknown;
  try {
    hubBody = JSON.parse(text);
  } catch {
    hubBody = { ok: false, error: "hub returned a non-json response" };
  }
  return igSendQueueEnvelope(response.status, hubBody, secret);
}

function indexPayload() {
  return {
    service: "muse-executive",
    contract: "v1",
    access: "read-only (GET)",
    authentication: "Bearer token (sha256-hashed in muse_api_tokens) or X-Muse-Token",
    rate_limit: `${EXECUTIVE_RATE_LIMIT_REQUESTS} requests / ${EXECUTIVE_RATE_LIMIT_WINDOW_SECONDS}s per token`,
    resources: Object.values(RESOURCES).map((r) => ({
      path: `/executive/${r.resource}`,
      authoritative_source: r.authoritative_source,
      filters: [...Object.keys(r.filters ?? {}), ...(r.sinceColumn ? ["since"] : [])],
      max_limit: r.maxLimit,
    })).concat([{
      path: `/executive/${IG_SEND_QUEUE_RESOURCE}`,
      authoritative_source: "FanFuel Hub control-center-api list_ig_dm_send_queue (live read)",
      filters: ["limit"],
      max_limit: 250,
    }]),
    status_vocabulary: [
      "KNOWN",
      "AVAILABLE_NOT_CONNECTED",
      "SOURCE_EXISTS_ACCESS_NEEDED",
      "NOT_MEASURED",
      "UNKNOWN",
      "NEEDS_VERIFICATION",
    ],
    verification_states: ["CLAIMED", "ARTIFACT_VERIFIED", "SYSTEM_VERIFIED", "LIVE_VERIFIED"],
    classifications: [
      "FENDI_DECISION",
      "MUSE_ANALYSIS",
      "DELEGATE_TO_AGENT",
      "AUTOMATED_SYSTEM",
      "HUMAN_OWNER",
      "WAITING",
    ],
    notes: [
      "Muse stores executive interpretation only; domain systems retain ownership of truth.",
      "A commit in GitHub never implies a deployment: read /executive/verifications.",
      "An empty section means nothing real was recorded, not that everything is fine.",
      "Same-day agent posts (Instagram send packs, empty-queue notes) are GET /executive/workboard. The last 48 hours also appear in /executive/brief section workboard, field detail. Scope required: read.",
      "Instagram DMs: Claude composes in the Hub, Grok approves, Muse sends. GET /executive/ig-send-queue is the live list of approved, unsent DMs with the exact text and handle; after sending, record the receipt with muse-workboard record_ig_dm_receipt.",
    ],
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const url = new URL(req.url);
  const resourceName = resolveResource(url) ?? "";

  // 1. Method guard before anything else: this surface cannot mutate state.
  if (req.method !== "GET") {
    await audit(supabase, req, {
      token_label: null,
      resource: resourceName || "(none)",
      http_status: 405,
      note: `method ${req.method} rejected: muse-executive is read-only`,
    });
    return json(
      {
        error: "method_not_allowed",
        message: "muse-executive is read-only. Only GET is accepted.",
        hint: "Write and action capability must route through existing Control Hub execution mechanisms.",
      },
      405,
      { Allow: "GET, OPTIONS" },
    );
  }

  // 2. Authenticate.
  const auth = await authenticate(presentedToken(req));
  if (!auth.ok) {
    if (auth.status === 503) {
      return json({ ok: false, error: "database_timeout", message: auth.reason ?? "The database did not answer within 8 seconds." }, 503);
    }
    await audit(supabase, req, {
      token_label: auth.label,
      resource: resourceName || "(none)",
      http_status: 401,
      note: auth.reason,
    });
    return json({ error: "unauthorized", message: auth.reason ?? "authentication required" }, 401);
  }
  const label = auth.label ?? "unknown";

  // 3. Rate limit.
  if (await executiveRateLimited(supabase, label)) {
    await audit(supabase, req, {
      token_label: label,
      resource: resourceName || "(none)",
      http_status: 429,
      note: "rate limit exceeded",
    });
    return json(
      executiveRateLimitBody(),
      429,
      { "Retry-After": String(EXECUTIVE_RATE_LIMIT_WINDOW_SECONDS) },
    );
  }

  // 3b. Live pass-through: the approved Instagram send queue on FanFuel Hub.
  // The Hub owns drafts and approvals, so nothing is copied into a muse_ view.
  // The Muse secret is read from the environment here and never returned.
  if (resourceName === IG_SEND_QUEUE_RESOURCE) {
    const out = await fetchIgSendQueue(url);
    await audit(supabase, req, { token_label: label, resource: resourceName, http_status: out.status, note: out.note });
    return json(out.body, out.status);
  }

  // 4. Index.
  if (!resourceName || resourceName === "index") {
    await audit(supabase, req, { token_label: label, resource: "index", http_status: 200 });
    return json(indexPayload());
  }

  // 5–6. Closed allowlist and validated read. Shared with control-center-mcp.
  const read = await readExecutiveResource(supabase, resourceName, url.searchParams);
  await audit(supabase, req, {
    token_label: label,
    resource: resourceName,
    http_status: read.status,
    note: read.note ?? (read.status === 404 ? "unknown resource" : undefined),
  });
  return json(read.body, read.status);
});

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
import {
  RESOURCES,
  redact,
  newestTimestamp,
  freshnessMinutes,
  rollUpStatus,
  type ExecutiveEnvelope,
} from "./contract.ts";

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

const RATE_LIMIT_REQUESTS = Number(Deno.env.get("MUSE_RATE_LIMIT") ?? "60");
const RATE_LIMIT_WINDOW_SECONDS = 60;

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

/** Constant-time comparison so the bootstrap token cannot be probed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
}

async function authenticate(supabase: SupabaseClient, token: string | null): Promise<AuthResult> {
  if (!token) return { ok: false, label: null, reason: "missing token" };

  // A Supabase key must never work as a Muse credential.
  if (token === SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, label: null, reason: "service-role key rejected as a Muse token" };
  }

  if (ENV_TOKEN && timingSafeEqual(token, ENV_TOKEN)) {
    return { ok: true, label: "env-bootstrap" };
  }

  const hash = await sha256Hex(token);
  const { data, error } = await supabase
    .from("muse_api_tokens")
    .select("id, label, scopes, expires_at, revoked_at")
    .eq("token_sha256", hash)
    .maybeSingle();

  if (error) return { ok: false, label: null, reason: "token lookup failed" };
  if (!data) return { ok: false, label: null, reason: "unknown token" };
  if (data.revoked_at) return { ok: false, label: data.label, reason: "token revoked" };
  if (data.expires_at && Date.parse(data.expires_at) < Date.now()) {
    return { ok: false, label: data.label, reason: "token expired" };
  }
  if (!(data.scopes ?? []).includes("read")) {
    return { ok: false, label: data.label, reason: "token lacks read scope" };
  }

  // Best-effort usage stamp; a failure here must not deny a valid request.
  await supabase
    .from("muse_api_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);

  return { ok: true, label: data.label };
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

/** Fixed window over the audit trail — no extra state to keep. */
async function rateLimited(supabase: SupabaseClient, label: string): Promise<boolean> {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_SECONDS * 1000).toISOString();
  const { count, error } = await supabase
    .from("muse_access_audit")
    .select("id", { count: "exact", head: true })
    .eq("token_label", label)
    .gte("at", since);
  if (error) return false;
  return (count ?? 0) >= RATE_LIMIT_REQUESTS;
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

function indexPayload() {
  return {
    service: "muse-executive",
    contract: "v1",
    access: "read-only (GET)",
    authentication: "Bearer token (sha256-hashed in muse_api_tokens) or X-Muse-Token",
    rate_limit: `${RATE_LIMIT_REQUESTS} requests / ${RATE_LIMIT_WINDOW_SECONDS}s per token`,
    resources: Object.values(RESOURCES).map((r) => ({
      path: `/executive/${r.resource}`,
      authoritative_source: r.authoritative_source,
      filters: Object.keys(r.filters ?? {}),
      max_limit: r.maxLimit,
    })),
    status_vocabulary: [
      "KNOWN",
      "AVAILABLE_NOT_CONNECTED",
      "SOURCE_EXISTS_ACCESS_NEEDED",
      "NOT_MEASURED",
      "UNKNOWN",
      "NEEDS_VERIFICATION",
    ],
    verification_states: ["CLAIMED", "ARTIFACT_VERIFIED", "SYSTEM_VERIFIED", "LIVE_VERIFIED"],
    improvement_lifecycle: [
      "PROPOSED", "SELECTED", "IN_EXECUTION", "VERIFICATION", "MEASURING", "DECIDED", "CLOSED", "REJECTED",
    ],
    task_states: [
      "ASSIGNED", "IN_PROGRESS", "WAITING", "BLOCKED", "IMPLEMENTED", "VERIFICATION", "COMPLETE", "CANCELLED",
    ],
    verdicts: ["PENDING", "KEEP", "REVISE", "REVERSE", "INCONCLUSIVE"],
    owner_attention: ["NONE", "INFORM", "APPROVAL", "DECISION", "DIRECT_INVOLVEMENT"],
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
      "State changes are not made here. They go through the muse_transition_* / muse_verify database functions via Control Hub execution paths.",
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
  const auth = await authenticate(supabase, presentedToken(req));
  if (!auth.ok) {
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
  if (await rateLimited(supabase, label)) {
    await audit(supabase, req, {
      token_label: label,
      resource: resourceName || "(none)",
      http_status: 429,
      note: "rate limit exceeded",
    });
    return json(
      { error: "rate_limited", message: `Limit is ${RATE_LIMIT_REQUESTS} requests per ${RATE_LIMIT_WINDOW_SECONDS}s.` },
      429,
      { "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS) },
    );
  }

  // 4. Index.
  if (!resourceName || resourceName === "index") {
    await audit(supabase, req, { token_label: label, resource: "index", http_status: 200 });
    return json(indexPayload());
  }

  // 5. Closed allowlist — no dynamic table access.
  const spec = RESOURCES[resourceName];
  if (!spec) {
    await audit(supabase, req, {
      token_label: label,
      resource: resourceName,
      http_status: 404,
      note: "unknown resource",
    });
    return json(
      {
        error: "unknown_resource",
        message: `No executive resource named "${resourceName}".`,
        available: Object.keys(RESOURCES),
      },
      404,
    );
  }

  // 6. Read, with validated paging and filters only.
  const requestedLimit = Number(url.searchParams.get("limit") ?? spec.defaultLimit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(1, Math.trunc(requestedLimit)), spec.maxLimit)
    : spec.defaultLimit;

  let query = supabase.from(spec.view).select("*").limit(limit);
  if (spec.orderBy) {
    query = query.order(spec.orderBy.column, { ascending: spec.orderBy.ascending, nullsFirst: false });
  }

  const appliedFilters: Record<string, string> = {};
  for (const [param, column] of Object.entries(spec.filters ?? {})) {
    const raw = url.searchParams.get(param);
    if (raw === null) continue;
    // Filter values are compared for equality only, and constrained to a safe
    // character set so nothing resembling a PostgREST operator can be injected.
    const value = raw.trim().slice(0, 100);
    if (!/^[A-Za-z0-9_.:\- ]+$/.test(value)) {
      await audit(supabase, req, {
        token_label: label,
        resource: resourceName,
        http_status: 400,
        note: `rejected filter value for ${param}`,
      });
      return json({ error: "invalid_filter", message: `Filter "${param}" contains unsupported characters.` }, 400);
    }
    query = query.eq(column, value);
    appliedFilters[param] = value;
  }

  const { data, error } = await query;
  if (error) {
    await audit(supabase, req, {
      token_label: label,
      resource: resourceName,
      http_status: 503,
      note: `read failed: ${error.message}`.slice(0, 300),
    });
    return json(
      {
        error: "read_failed",
        message: "The executive view could not be read.",
        resource: resourceName,
        // Surfaces the "schema present in GitHub but not live" case honestly.
        hint: "If this persists, the Muse migration may not be applied to the live database yet.",
      },
      503,
    );
  }

  const rows = redact((data ?? []) as Record<string, unknown>[]);
  const dataTimestamp = newestTimestamp(rows, spec.timestampColumn);
  const { status, confidence, human_verification_required } = rollUpStatus(rows);

  const envelope: ExecutiveEnvelope<Record<string, unknown>> = {
    resource: spec.resource,
    generated_at: new Date().toISOString(),
    data_timestamp: dataTimestamp,
    authoritative_source: spec.authoritative_source,
    freshness_minutes: freshnessMinutes(dataTimestamp),
    confidence,
    status,
    human_verification_required,
    evidence: [`view:public.${spec.view}`, "project:wkzwcfmvnwolgrdpnygc"],
    row_count: rows.length,
    data: rows,
  };

  if (rows.length === 0) {
    envelope.notes = [
      "No rows. This means nothing was recorded for this resource, not that nothing is wrong.",
    ];
  }
  if (Object.keys(appliedFilters).length > 0) {
    envelope.notes = [...(envelope.notes ?? []), `filters applied: ${JSON.stringify(appliedFilters)}`];
  }

  await audit(supabase, req, { token_label: label, resource: resourceName, http_status: 200 });
  return json(envelope);
});

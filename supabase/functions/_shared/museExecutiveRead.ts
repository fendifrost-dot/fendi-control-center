/**
 * Closed-allowlist read used by muse-executive and the Control Center MCP.
 * Callers authenticate first. This module never sees a bearer token.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  RESOURCES,
  redact,
  newestTimestamp,
  freshnessMinutes,
  rollUpStatus,
  parseSince,
  filterValueRejection,
  appliedFilterValue,
  classifyExecutiveReadError,
  type ExecutiveEnvelope,
} from "../muse-executive/contract.ts";

export const EXECUTIVE_RATE_LIMIT_REQUESTS = Number(Deno.env.get("MUSE_RATE_LIMIT") ?? "60");
export const EXECUTIVE_RATE_LIMIT_WINDOW_SECONDS = 60;

export function executiveRateLimitBody(): Record<string, unknown> {
  return {
    error: "rate_limited",
    message: `Limit is ${EXECUTIVE_RATE_LIMIT_REQUESTS} requests per ${EXECUTIVE_RATE_LIMIT_WINDOW_SECONDS}s.`,
  };
}

/** Fixed window over the audit trail — no extra state to keep. */
export async function executiveRateLimited(supabase: SupabaseClient, label: string): Promise<boolean> {
  const since = new Date(Date.now() - EXECUTIVE_RATE_LIMIT_WINDOW_SECONDS * 1000).toISOString();
  const { count, error } = await supabase
    .from("muse_access_audit")
    .select("id", { count: "exact", head: true })
    .eq("token_label", label)
    .gte("at", since);
  if (error) return false;
  return (count ?? 0) >= EXECUTIVE_RATE_LIMIT_REQUESTS;
}

export async function readExecutiveResource(
  supabase: SupabaseClient,
  resourceName: string,
  searchParams: URLSearchParams,
): Promise<{ status: number; body: Record<string, unknown>; note?: string }> {
  const spec = RESOURCES[resourceName];
  if (!spec) {
    return {
      status: 404,
      body: {
        error: "unknown_resource",
        message: `No executive resource named "${resourceName}".`,
        available: Object.keys(RESOURCES),
      },
    };
  }

  const requestedLimit = Number(searchParams.get("limit") ?? spec.defaultLimit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(1, Math.trunc(requestedLimit)), spec.maxLimit)
    : spec.defaultLimit;

  const appliedFilters: Record<string, string> = {};
  const equality: { column: string; value: string }[] = [];
  for (const [param, column] of Object.entries(spec.filters ?? {})) {
    const raw = searchParams.get(param);
    if (raw === null) continue;
    const rejection = filterValueRejection(param, column, raw);
    if (rejection) return { status: 400, body: rejection, note: `rejected filter value for ${param}` };
    const value = appliedFilterValue(param, column, raw);
    equality.push({ column, value });
    appliedFilters[param] = value;
  }

  let since: string | null = null;
  if (spec.sinceColumn && searchParams.has("since")) {
    try {
      since = parseSince(searchParams.get("since"));
    } catch (e) {
      const message = e instanceof Error ? e.message : "invalid since";
      return { status: 400, body: { error: "invalid_filter", message }, note: message.slice(0, 300) };
    }
    if (since) appliedFilters.since = since;
  }

  let query = supabase.from(spec.view).select("*").limit(limit);
  if (spec.orderBy) {
    query = query.order(spec.orderBy.column, { ascending: spec.orderBy.ascending, nullsFirst: false });
  }
  for (const filter of equality) query = query.eq(filter.column, filter.value);
  if (since && spec.sinceColumn) query = query.gte(spec.sinceColumn, since);

  const { data, error } = await query;
  if (error) {
    const classified = classifyExecutiveReadError(error, appliedFilters, resourceName);
    return {
      status: classified.status,
      body: classified.body,
      note: `read failed (${classified.status}): ${error.code ?? "none"} ${error.message}`.slice(0, 300),
    };
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

  return { status: 200, body: envelope as unknown as Record<string, unknown> };
}

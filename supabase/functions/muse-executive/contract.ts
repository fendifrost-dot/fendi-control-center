/**
 * Muse executive read contract.
 *
 * Provider-neutral and stable: Muse addresses semantic resources, never table
 * names, so the underlying views can be reshaped without breaking the consumer.
 *
 * Read-only by construction — there is no write path in this module.
 */

export type DataStatus =
  | "KNOWN"
  | "AVAILABLE_NOT_CONNECTED"
  | "SOURCE_EXISTS_ACCESS_NEEDED"
  | "NOT_MEASURED"
  | "UNKNOWN"
  | "NEEDS_VERIFICATION";

export type Confidence = "HIGH" | "MEDIUM" | "LOW";

/** Every executive resource answers with this envelope. */
export interface ExecutiveEnvelope<T> {
  resource: string;
  /** When this response was produced. */
  generated_at: string;
  /** Newest timestamp among the underlying rows; null when nothing is dated. */
  data_timestamp: string | null;
  authoritative_source: string;
  /** Age of `data_timestamp` in minutes, or null when unknown. */
  freshness_minutes: number | null;
  confidence: Confidence;
  status: DataStatus;
  human_verification_required: boolean;
  /** Where the numbers came from, so Muse can cite rather than assert. */
  evidence: string[];
  row_count: number;
  data: T[];
  /** Populated when part of the answer is unavailable. */
  notes?: string[];
}

export interface ResourceSpec {
  /** Semantic path segment, e.g. "open-loops". */
  resource: string;
  /** The curated read view backing it. Never user-supplied. */
  view: string;
  authoritative_source: string;
  /** Column used to compute freshness, if any. */
  timestampColumn: string | null;
  /** Default ordering (column, ascending). */
  orderBy?: { column: string; ascending: boolean };
  /** Columns a caller may filter on, with the query-string name. */
  filters?: Record<string, string>;
  defaultLimit: number;
  maxLimit: number;
}

/**
 * The complete, closed set of readable resources. A request for anything not in
 * this map is a 404 — there is no dynamic table or SQL access.
 */
export const RESOURCES: Record<string, ResourceSpec> = {
  brief: {
    resource: "brief",
    view: "muse_executive_brief",
    authoritative_source: "Control Hub Muse layer (derived from domain systems)",
    timestampColumn: "as_of",
    orderBy: { column: "rank", ascending: true },
    filters: { section: "section", domain: "domain_key" },
    defaultLimit: 200,
    maxLimit: 500,
  },
  portfolio: {
    resource: "portfolio",
    view: "muse_portfolio_map",
    authoritative_source: "Control Hub Muse layer (per-domain source of truth declared in muse_source_authority)",
    timestampColumn: "as_of",
    orderBy: { column: "sort_order", ascending: true },
    filters: { domain: "domain_key" },
    defaultLimit: 50,
    maxLimit: 200,
  },
  "open-loops": {
    resource: "open-loops",
    view: "muse_open_loops_live",
    authoritative_source: "Control Hub Muse layer; resolution derived from domain systems",
    timestampColumn: "last_evidence_at",
    orderBy: { column: "priority", ascending: true },
    filters: { domain: "domain_key", state: "state", priority: "priority", category: "category" },
    defaultLimit: 200,
    maxLimit: 500,
  },
  decisions: {
    resource: "decisions",
    view: "muse_decisions_required",
    authoritative_source: "Control Hub Muse decision register",
    timestampColumn: "created_at",
    orderBy: { column: "decision_required_by", ascending: true },
    filters: { domain: "domain_key" },
    defaultLimit: 100,
    maxLimit: 300,
  },
  kpis: {
    resource: "kpis",
    view: "muse_kpi_summary",
    authoritative_source: "Domain systems via Control Hub; unmeasured metrics report status only",
    timestampColumn: "data_timestamp",
    orderBy: { column: "sort_order", ascending: true },
    filters: { domain: "domain_key", metric: "metric_key" },
    defaultLimit: 200,
    maxLimit: 500,
  },
  systems: {
    resource: "systems",
    view: "muse_system_health",
    authoritative_source: "Live telemetry from the tables that own each fact",
    timestampColumn: "latest_activity_at",
    orderBy: { column: "sort_order", ascending: true },
    filters: { domain: "domain_key", status: "status" },
    defaultLimit: 100,
    maxLimit: 300,
  },
  sources: {
    resource: "sources",
    view: "muse_source_authority_state",
    authoritative_source: "Control Hub Muse source authority register",
    timestampColumn: "last_verified_at",
    orderBy: { column: "domain_key", ascending: true },
    filters: { domain: "domain_key" },
    defaultLimit: 200,
    maxLimit: 500,
  },
  conflicts: {
    resource: "conflicts",
    view: "muse_source_conflicts_open",
    authoritative_source: "Control Hub Muse conflict register (both sides preserved)",
    timestampColumn: "detected_at",
    orderBy: { column: "detected_at", ascending: false },
    filters: { domain: "domain_key" },
    defaultLimit: 100,
    maxLimit: 300,
  },
  improvements: {
    resource: "improvements",
    view: "muse_improvement_ledger",
    authoritative_source: "Control Hub Muse 1% improvement ledger",
    timestampColumn: "created_at",
    orderBy: { column: "review_at", ascending: true },
    filters: { domain: "domain_key", verdict: "verdict", status: "status" },
    defaultLimit: 100,
    maxLimit: 300,
  },
  verifications: {
    resource: "verifications",
    view: "muse_verifications",
    authoritative_source: "Control Hub Muse verification ledger; GitHub remains code truth",
    timestampColumn: "claimed_at",
    orderBy: { column: "claimed_at", ascending: false },
    filters: { state: "verification_state" },
    defaultLimit: 100,
    maxLimit: 300,
  },
};

/** Keys whose values are never returned, whatever a view happens to expose. */
const REDACT_KEY = /(secret|token|api[_-]?key|password|passwd|credential|bearer|jwt|authorization|service[_-]?role)/i;

/**
 * Defence in depth: strip credential-shaped fields from any payload before it
 * leaves the function, so a future view change cannot leak one by accident.
 */
export function redact<T>(rows: T[]): T[] {
  return rows.map((row) => {
    if (row === null || typeof row !== "object") return row;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (REDACT_KEY.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = v && typeof v === "object" && !Array.isArray(v)
        ? redact([v])[0]
        : v;
    }
    return out as T;
  });
}

/** Newest value of `column` across rows, as an ISO string. */
export function newestTimestamp(rows: Record<string, unknown>[], column: string | null): string | null {
  if (!column) return null;
  let newest: number | null = null;
  for (const row of rows) {
    const raw = row[column];
    if (typeof raw !== "string") continue;
    const t = Date.parse(raw);
    if (Number.isNaN(t)) continue;
    if (newest === null || t > newest) newest = t;
  }
  return newest === null ? null : new Date(newest).toISOString();
}

export function freshnessMinutes(dataTimestamp: string | null, now = Date.now()): number | null {
  if (!dataTimestamp) return null;
  const t = Date.parse(dataTimestamp);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 60000));
}

/**
 * Roll per-row honesty up to the envelope. The weakest row wins: a resource is
 * only KNOWN when nothing inside it is unverified or unmeasured.
 */
export function rollUpStatus(rows: Record<string, unknown>[]): {
  status: DataStatus;
  confidence: Confidence;
  human_verification_required: boolean;
} {
  const order: DataStatus[] = [
    "KNOWN",
    "NEEDS_VERIFICATION",
    "AVAILABLE_NOT_CONNECTED",
    "SOURCE_EXISTS_ACCESS_NEEDED",
    "NOT_MEASURED",
    "UNKNOWN",
  ];
  let worstIndex = 0;
  let needsHuman = false;
  let sawStatus = false;

  for (const row of rows) {
    const s = row["data_status"];
    if (typeof s === "string") {
      const i = order.indexOf(s as DataStatus);
      if (i >= 0) {
        sawStatus = true;
        if (i > worstIndex) worstIndex = i;
      }
    }
    if (row["human_verification_required"] === true) needsHuman = true;
  }

  if (rows.length === 0) {
    // No rows is not "known good" — it is simply nothing to report.
    return { status: "NOT_MEASURED", confidence: "LOW", human_verification_required: false };
  }

  const status = sawStatus ? order[worstIndex] : "KNOWN";
  const confidence: Confidence =
    status === "KNOWN" ? "HIGH" : status === "NEEDS_VERIFICATION" ? "MEDIUM" : "LOW";

  return { status, confidence, human_verification_required: needsHuman || status !== "KNOWN" };
}

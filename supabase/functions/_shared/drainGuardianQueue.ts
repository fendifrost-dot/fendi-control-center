/**
 * Drain worker core for `pending_guardian_events` → Credit Guardian
 * `ingest-hub-event`. The Hub Telegram attachment handler (PR #10) writes
 * structured event rows to `pending_guardian_events`; this worker pulls them
 * off the queue, signs each request with HMAC-SHA256 of the body, POSTs to
 * Guardian, and updates the row's lifecycle status based on the response.
 *
 * I/O is fully injected via `DrainDeps` so unit tests run with in-memory fakes
 * (no network, no Supabase). The thin edge-function wrapper at
 * `supabase/functions/drain-guardian-queue/index.ts` plugs in the live deps.
 */

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Shape of a row returned by the `claim_pending_guardian_events` RPC. Matches
 * the columns selected by that function in
 * docs/migrations/MIGRATION-drain-worker-status.sql.
 */
export interface PendingGuardianEventRow {
  id: string;
  correlation_id: string;
  source: "photo" | "document" | "email" | "manual";
  file_unique_id: string;
  client_name: string;
  cg_client_id: string | null;
  event_type: "responses_received" | "outcomes_observed" | "completed_actions";
  bureau: string;
  bureau_canonical: string;
  round: number | null;
  drive_file_id: string;
  drive_file_name: string;
  drive_path: string;
  ocr_text: string | null;
  retry_count: number;
}

/**
 * Body Guardian's `ingest-hub-event` accepts. Keys are documented on the
 * Guardian side (A4) — this is the canonical request shape.
 */
export interface GuardianIngestRequest {
  correlation_id: string;
  client_id?: string;
  client_name_hint?: string;
  bureau?: string;
  round?: number;
  event_type: PendingGuardianEventRow["event_type"];
  summary: string;
  drive_path?: string;
  drive_url?: string;
  mime_type?: string;
  ocr_text?: string;
}

/** What the worker writes back to the queue row after a tick. */
export type RowOutcome =
  | { kind: "completed"; guardian_event_id: string | null; idempotent: boolean }
  | { kind: "needs_operator"; candidates: unknown }
  | { kind: "failed"; error_message: string }
  | { kind: "auth_failed"; error_message: string }
  | {
    kind: "retry_queued";
    next_retry_at: string;
    retry_count: number;
    error_message: string;
  };

/** Aggregate counters returned by `runDrainTick`. */
export interface DrainTickResult {
  scanned: number;
  completed: number;
  needs_operator: number;
  failed: number;
  auth_failed: number;
  retry_queued: number;
  unexpected_errors: number;
}

/** Logger shape — defaults to `console`, tests pass a capture buffer. */
export interface DrainLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/** Injected I/O surface. */
export interface DrainDeps {
  /** Atomically claim up to `limit` pending rows (RPC `claim_pending_guardian_events`). */
  claimRows: (limit: number, now: Date) => Promise<PendingGuardianEventRow[]>;
  /** POST signed body to Guardian. Returns raw HTTP info — no parsing here. */
  postToGuardian: (body: string, signatureHex: string) => Promise<{
    status: number;
    body: string;
  }>;
  /** Apply a terminal/retry update to a queue row by id. */
  updateRow: (
    id: string,
    patch: {
      status?:
        | "pending"
        | "completed"
        | "needs_operator"
        | "failed"
        | "auth_failed";
      guardian_event_id?: string | null;
      clarification_needed?: unknown;
      error_message?: string | null;
      retry_count?: number;
      next_retry_at?: string | null;
      delivered_at?: string | null;
    },
  ) => Promise<void>;
  /** Shared HMAC secret. */
  signatureSecret: string;
  /** Stable now() — tests inject a fixed clock. */
  now: () => Date;
  logger?: DrainLogger;
}

// ----------------------------------------------------------------------------
// HMAC signing
// ----------------------------------------------------------------------------

/**
 * Sign `body` with HMAC-SHA256 keyed by `secret`. Returned as lowercase hex.
 * The Guardian side accepts the signature with or without a `sha256=` prefix;
 * we send the bare hex for consistency with the existing telegram-webhook
 * style (no prefix).
 */
export async function signHubRequest(
  body: string,
  secret: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// ----------------------------------------------------------------------------
// Backoff
// ----------------------------------------------------------------------------

export const MAX_RETRIES = 5;
export const DRAIN_BATCH_DEFAULT = 10;

/**
 * Exponential backoff in seconds for the Nth retry (1-indexed). 30s, 60s,
 * 2m, 4m, 8m, capped at 8m. Pure function — no clock, easy to test.
 */
export function backoffSeconds(retryCount: number): number {
  if (retryCount < 1) return 30;
  const base = 30 * Math.pow(2, retryCount - 1);
  return Math.min(base, 480);
}

// ----------------------------------------------------------------------------
// Body construction
// ----------------------------------------------------------------------------

/**
 * Build the Guardian-side request body from a queue row. Optional fields are
 * omitted when null/empty so the JSON Guardian receives is tidy and Guardian's
 * 400 validation doesn't trip on empty strings.
 */
export function buildGuardianRequestBody(
  row: PendingGuardianEventRow,
): GuardianIngestRequest {
  const summary = summaryFromRow(row);
  const driveUrl = row.drive_file_id
    ? `https://drive.google.com/file/d/${row.drive_file_id}/view`
    : undefined;
  const mimeType = mimeFromRow(row);
  const body: GuardianIngestRequest = {
    correlation_id: row.correlation_id,
    event_type: row.event_type,
    summary,
  };
  if (row.cg_client_id) body.client_id = row.cg_client_id;
  if (row.client_name) body.client_name_hint = row.client_name;
  if (row.bureau_canonical) body.bureau = row.bureau_canonical;
  if (typeof row.round === "number") body.round = row.round;
  if (row.drive_path) body.drive_path = row.drive_path + row.drive_file_name;
  if (driveUrl) body.drive_url = driveUrl;
  if (mimeType) body.mime_type = mimeType;
  if (row.ocr_text && row.ocr_text.length > 0) body.ocr_text = row.ocr_text;
  return body;
}

function summaryFromRow(row: PendingGuardianEventRow): string {
  const tag = row.event_type === "outcomes_observed"
    ? "outcome update"
    : row.event_type === "completed_actions"
    ? "completed action"
    : "responses received";
  const parts: string[] = [`Hub ${tag}`];
  if (row.bureau) parts.push(`(${row.bureau}`);
  else if (row.bureau_canonical) parts.push(`(${row.bureau_canonical}`);
  if (typeof row.round === "number") parts.push(`round ${row.round}`);
  if (parts.length > 1) parts[parts.length - 1] += ")";
  return parts.join(" ");
}

function mimeFromRow(row: PendingGuardianEventRow): string | undefined {
  const name = row.drive_file_name?.toLowerCase() ?? "";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".heic")) return "image/heic";
  return undefined;
}

// ----------------------------------------------------------------------------
// Per-row processing
// ----------------------------------------------------------------------------

/**
 * Compute the row outcome from a Guardian HTTP response. Pure function — no
 * I/O, no clock — the caller (`drainOnce`) applies the resulting patch via
 * `deps.updateRow`. Splitting the decision lets us unit-test every status
 * transition exhaustively without a fake Supabase client.
 */
export function decideOutcome(
  row: PendingGuardianEventRow,
  resp: { status: number; body: string },
  now: Date,
): RowOutcome {
  // Treat any 2xx as success — Guardian only returns 200 today, but tolerate
  // 201/204 in case the API tightens up.
  if (resp.status >= 200 && resp.status < 300) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(resp.body) as Record<string, unknown>;
    } catch {
      /* keep parsed = {} — happens for 204 or malformed-but-2xx replies */
    }
    const eventId = typeof parsed.event_id === "string" ? parsed.event_id : null;
    const idempotent = parsed.idempotent === true;
    return { kind: "completed", guardian_event_id: eventId, idempotent };
  }

  if (resp.status === 422) {
    let candidates: unknown = null;
    try {
      const parsed = JSON.parse(resp.body) as Record<string, unknown>;
      candidates = parsed.candidates ?? parsed;
    } catch {
      candidates = { raw: truncate(resp.body, 1000) };
    }
    return { kind: "needs_operator", candidates };
  }

  if (resp.status === 400) {
    return {
      kind: "failed",
      error_message: `guardian 400: ${truncate(resp.body, 1500)}`,
    };
  }

  if (resp.status === 401) {
    return {
      kind: "auth_failed",
      error_message: `guardian 401: ${truncate(resp.body, 1500)}`,
    };
  }

  // 5xx, 408, 429, anything else → transient. Retry until cap.
  const newCount = row.retry_count + 1;
  const errMsg = `guardian ${resp.status}: ${truncate(resp.body, 1500)}`;
  if (newCount > MAX_RETRIES) {
    return {
      kind: "failed",
      error_message: `retry_exhausted (${MAX_RETRIES}); last: ${errMsg}`,
    };
  }
  const next = new Date(now.getTime() + backoffSeconds(newCount) * 1000);
  return {
    kind: "retry_queued",
    next_retry_at: next.toISOString(),
    retry_count: newCount,
    error_message: errMsg,
  };
}

/**
 * Convert a raised exception (network failure, fetch abort, etc.) into a
 * retry/give-up outcome — same shape as a 5xx response.
 */
export function decideOutcomeForException(
  row: PendingGuardianEventRow,
  err: unknown,
  now: Date,
): RowOutcome {
  const msg = err instanceof Error ? err.message : String(err);
  const newCount = row.retry_count + 1;
  if (newCount > MAX_RETRIES) {
    return {
      kind: "failed",
      error_message: `retry_exhausted (${MAX_RETRIES}); last: ${truncate(msg, 1500)}`,
    };
  }
  const next = new Date(now.getTime() + backoffSeconds(newCount) * 1000);
  return {
    kind: "retry_queued",
    next_retry_at: next.toISOString(),
    retry_count: newCount,
    error_message: `network: ${truncate(msg, 1500)}`,
  };
}

function truncate(s: string, n: number): string {
  if (typeof s !== "string") return "";
  return s.length <= n ? s : s.slice(0, n) + "…";
}

/**
 * Process a single row end-to-end. Returns the outcome so the orchestrator
 * can update its counters; the row update is applied here so the orchestrator
 * loop stays simple.
 */
export async function processRow(
  row: PendingGuardianEventRow,
  deps: DrainDeps,
): Promise<RowOutcome> {
  const log = deps.logger ?? console;
  const body = buildGuardianRequestBody(row);
  const json = JSON.stringify(body);
  const sig = await signHubRequest(json, deps.signatureSecret);

  let outcome: RowOutcome;
  try {
    const resp = await deps.postToGuardian(json, sig);
    outcome = decideOutcome(row, resp, deps.now());
  } catch (err) {
    log.warn(
      `[drain-guardian-queue] row=${row.id} network error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    outcome = decideOutcomeForException(row, err, deps.now());
  }

  await applyOutcome(row, outcome, deps);
  return outcome;
}

async function applyOutcome(
  row: PendingGuardianEventRow,
  outcome: RowOutcome,
  deps: DrainDeps,
): Promise<void> {
  const now = deps.now().toISOString();
  switch (outcome.kind) {
    case "completed":
      await deps.updateRow(row.id, {
        status: "completed",
        guardian_event_id: outcome.guardian_event_id,
        delivered_at: now,
        next_retry_at: null,
        error_message: null,
      });
      return;
    case "needs_operator":
      await deps.updateRow(row.id, {
        status: "needs_operator",
        clarification_needed: outcome.candidates,
        next_retry_at: null,
      });
      return;
    case "failed":
      await deps.updateRow(row.id, {
        status: "failed",
        error_message: outcome.error_message,
        next_retry_at: null,
      });
      return;
    case "auth_failed":
      (deps.logger ?? console).error(
        `[drain-guardian-queue] auth_failed row=${row.id} — check HUB_SIGNATURE_SECRET`,
      );
      await deps.updateRow(row.id, {
        status: "auth_failed",
        error_message: outcome.error_message,
        next_retry_at: null,
      });
      return;
    case "retry_queued":
      await deps.updateRow(row.id, {
        status: "pending",
        retry_count: outcome.retry_count,
        next_retry_at: outcome.next_retry_at,
        error_message: outcome.error_message,
      });
      return;
  }
}

// ----------------------------------------------------------------------------
// Orchestrator
// ----------------------------------------------------------------------------

/**
 * One drain tick: claim up to `limit` rows, process them sequentially,
 * return aggregate counters. Sequential (not parallel) because Guardian
 * dedupes by correlation_id and we don't want to spam its DB during retries.
 */
export async function runDrainTick(
  deps: DrainDeps,
  limit: number = DRAIN_BATCH_DEFAULT,
): Promise<DrainTickResult> {
  const log = deps.logger ?? console;
  const result: DrainTickResult = {
    scanned: 0,
    completed: 0,
    needs_operator: 0,
    failed: 0,
    auth_failed: 0,
    retry_queued: 0,
    unexpected_errors: 0,
  };
  log.info(`[drain-guardian-queue] tick start limit=${limit}`);

  let rows: PendingGuardianEventRow[] = [];
  try {
    rows = await deps.claimRows(limit, deps.now());
  } catch (err) {
    log.error(
      `[drain-guardian-queue] claimRows failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw err;
  }

  result.scanned = rows.length;
  if (rows.length === 0) {
    log.info("[drain-guardian-queue] tick end scanned=0");
    return result;
  }

  for (const row of rows) {
    try {
      const outcome = await processRow(row, deps);
      switch (outcome.kind) {
        case "completed":
          result.completed++;
          break;
        case "needs_operator":
          result.needs_operator++;
          break;
        case "failed":
          result.failed++;
          break;
        case "auth_failed":
          result.auth_failed++;
          break;
        case "retry_queued":
          result.retry_queued++;
          break;
      }
    } catch (err) {
      result.unexpected_errors++;
      log.error(
        `[drain-guardian-queue] unexpected error row=${row.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  log.info(
    `[drain-guardian-queue] tick end scanned=${result.scanned} completed=${result.completed} ` +
      `needs_operator=${result.needs_operator} failed=${result.failed} ` +
      `auth_failed=${result.auth_failed} retry_queued=${result.retry_queued} ` +
      `unexpected=${result.unexpected_errors}`,
  );
  return result;
}

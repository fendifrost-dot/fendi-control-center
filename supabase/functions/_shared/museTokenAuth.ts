/**
 * Shared Muse bearer-token check.
 *
 * Missing and wrong tokens fail before any database call, which is why an
 * anonymous request stays fast while a real token used to hang: the next step
 * used to be an awaited UPDATE of muse_api_tokens.last_used_at.
 *
 * The lookup goes through muse_resolve_api_token, which stamps last_used_at
 * only when it is older than five minutes and gives up on the row lock after
 * 250ms. If that function is not deployed yet, the fallback is a single
 * indexed read and does not write. Either way the HTTP call aborts at 8s
 * and the caller returns 503 JSON instead of waiting out the client.
 */

export const MUSE_DB_TIMEOUT_MS = 8_000;

const HASH_HEX = /^[0-9a-f]{64}$/;

export interface ResolvedMuseToken {
  ok: true;
  label: string;
  scopes: string[];
  source: "env" | "table";
}

export interface RejectedMuseToken {
  ok: false;
  status: 401 | 503;
  error: "unauthorized" | "database_timeout" | "database_unavailable";
  message: string;
  label: string | null;
}

export type MuseTokenAuth = ResolvedMuseToken | RejectedMuseToken;

interface TokenRow {
  label: string;
  scopes: string[] | null;
  expires_at: string | null;
  revoked_at: string | null;
}

interface PostgrestError {
  code?: string;
  message?: string;
}

export function databaseTimeoutBody(): { ok: false; error: "database_timeout"; message: string } {
  return {
    ok: false,
    error: "database_timeout",
    message: `The database did not answer within ${MUSE_DB_TIMEOUT_MS / 1000} seconds.`,
  };
}

export function isDatabaseTimeout(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object") {
    const name = "name" in error ? String((error as { name: unknown }).name) : "";
    if (name === "TimeoutError" || name === "AbortError") return true;
    const code = "code" in error ? String((error as { code: unknown }).code ?? "") : "";
    if (code === "57014" || code === "55P03") return true;
  }
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);
  return /statement timeout|lock timeout|canceling statement|AbortError|TimeoutError|operation was aborted|signal timed out/i
    .test(message);
}

function reject(status: 401 | 503, error: RejectedMuseToken["error"], message: string, label: string | null = null): RejectedMuseToken {
  return { ok: false, status, error, message, label };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isTokenRow(value: unknown): value is TokenRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as { label?: unknown }).label === "string";
}

function rowsOf(body: unknown): TokenRow[] {
  if (Array.isArray(body)) return body.filter(isTokenRow);
  if (isTokenRow(body)) return [body];
  return [];
}

function errorOf(body: unknown): PostgrestError {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const record = body as { code?: unknown; message?: unknown };
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}

function rpcMissing(status: number, body: unknown): boolean {
  const error = errorOf(body);
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return status === 404 && /muse_resolve_api_token/.test(error.message ?? "");
}

export function assessTokenRow(row: TokenRow | null, nowMs: number): MuseTokenAuth {
  if (!row) return reject(401, "unauthorized", "unknown token");
  if (row.revoked_at) return reject(401, "unauthorized", "token revoked", row.label);
  if (row.expires_at && Date.parse(row.expires_at) < nowMs) {
    return reject(401, "unauthorized", "token expired", row.label);
  }
  return { ok: true, label: row.label, scopes: row.scopes ?? [], source: "table" };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 180) };
  }
}

async function callDatabase(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, body: await readJson(response) };
}

export async function authenticateMuseToken(opts: {
  supabaseUrl: string;
  serviceKey: string;
  token: string | null;
  envToken?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  nowMs?: number;
}): Promise<MuseTokenAuth> {
  const token = opts.token?.trim() || null;
  if (!token) return reject(401, "unauthorized", "missing token");
  if (token === opts.serviceKey) return reject(401, "unauthorized", "service-role key rejected");
  const envToken = opts.envToken?.trim() ?? "";
  if (envToken && timingSafeEqual(token, envToken)) {
    return { ok: true, label: "env-bootstrap", scopes: ["read"], source: "env" };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? MUSE_DB_TIMEOUT_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const base = opts.supabaseUrl.replace(/\/+$/, "");
  const headers = {
    apikey: opts.serviceKey,
    authorization: `Bearer ${opts.serviceKey}`,
    accept: "application/json",
    "content-type": "application/json",
  };

  let hash: string;
  try {
    hash = await sha256Hex(token);
  } catch (error) {
    if (isDatabaseTimeout(error)) return reject(503, "database_timeout", databaseTimeoutBody().message);
    return reject(503, "database_unavailable", "The token lookup failed before it reached the database.");
  }
  if (!HASH_HEX.test(hash)) {
    return reject(503, "database_unavailable", "The token lookup failed before it reached the database.");
  }

  try {
    const rpc = await callDatabase(fetchImpl, `${base}/rest/v1/rpc/muse_resolve_api_token`, {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify({ p_token_sha256: hash }),
    }, timeoutMs);
    if (!rpcMissing(rpc.status, rpc.body)) {
      if (rpc.status >= 400 || errorOf(rpc.body).code) {
        const failure = errorOf(rpc.body);
        if (isDatabaseTimeout(failure) || isDatabaseTimeout(failure.message)) {
          return reject(503, "database_timeout", databaseTimeoutBody().message);
        }
        return reject(503, "database_unavailable", "The token lookup did not complete.");
      }
      return assessTokenRow(rowsOf(rpc.body)[0] ?? null, nowMs);
    }

    // Function not deployed yet. Read the row and do not stamp last_used_at:
    // that UPDATE is the lock the request used to wait on.
    const lookup = await callDatabase(
      fetchImpl,
      `${base}/rest/v1/muse_api_tokens?select=label,scopes,expires_at,revoked_at&token_sha256=eq.${hash}`,
      { method: "GET", redirect: "error", headers },
      timeoutMs,
    );
    if (lookup.status >= 400) {
      const failure = errorOf(lookup.body);
      if (isDatabaseTimeout(failure) || isDatabaseTimeout(failure.message)) {
        return reject(503, "database_timeout", databaseTimeoutBody().message);
      }
      return reject(503, "database_unavailable", "The token lookup did not complete.");
    }
    return assessTokenRow(rowsOf(lookup.body)[0] ?? null, nowMs);
  } catch (error) {
    if (isDatabaseTimeout(error)) return reject(503, "database_timeout", databaseTimeoutBody().message);
    return reject(503, "database_unavailable", "The token lookup did not complete.");
  }
}

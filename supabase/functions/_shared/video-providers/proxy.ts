/**
 * Shared helpers for the video-providers proxy.
 *
 * Every video-provider edge function follows the same lifecycle:
 *
 *   1. CORS preflight
 *   2. Authenticate the caller (shared AVT_PROXY_KEY)
 *   3. Validate input
 *   4. Resolve the upstream API key from env; fail-clean if missing
 *   5. Call upstream, write `tool_execution_logs` row throughout
 *   6. Return the standardised response envelope (see
 *      docs/control_center_provider_proxy.md in AVT repo)
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key, x-request-id",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

let cachedClient: SupabaseClient | null = null;
export function getServiceClient(): SupabaseClient {
  if (cachedClient) return cachedClient;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured");
  }
  cachedClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  return cachedClient;
}

/** Shared secret check. Reject if AVT_PROXY_KEY is not configured OR header mismatch. */
export function checkProxyAuth(req: Request): { ok: true } | { ok: false; response: Response } {
  const expected = Deno.env.get("AVT_PROXY_KEY")?.trim();
  if (!expected) {
    return {
      ok: false,
      response: jsonError(
        "PROVIDER_KEY_NOT_CONFIGURED",
        "AVT_PROXY_KEY is not set in Control Center secrets. Cannot validate proxy calls.",
        500,
      ),
    };
  }
  const got = req.headers.get("x-api-key")?.trim();
  if (!got || got !== expected) {
    return {
      ok: false,
      response: jsonError("UNAUTHORISED", "Missing or invalid x-api-key header.", 401, false),
    };
  }
  return { ok: true };
}

export function jsonError(
  errorCode: string,
  errorMessage: string,
  status = 500,
  retryable = false,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      errorCode,
      errorMessage,
      retryable,
      ...extra,
    }),
    {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

export function jsonOk(body: Record<string, unknown>, status = 200): Response {
  return new Response(
    JSON.stringify({ ok: true, ...body }),
    {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

/** Audit identifiers carried in every proxy request body. */
export type AvtAuditFields = {
  avt_user_id?: string | null;
  avt_project_id?: string | null;
  avt_prompt_id?: string | null;
  avt_shot_id?: string | null;
};

export type ProviderName =
  | "runway"
  | "veo"
  | "pika"
  | "fal"
  | "grok"
  | "higgsfield";

export type NormalisedStatus = "queued" | "running" | "succeeded" | "failed";

export function normaliseStatus(raw: string | undefined | null): NormalisedStatus {
  if (!raw) return "queued";
  const s = String(raw).toLowerCase();
  if (["succeeded", "completed", "done", "complete", "success", "finished"].includes(s))
    return "succeeded";
  if (["failed", "error", "cancelled", "canceled", "expired", "rejected"].includes(s))
    return "failed";
  if (["processing", "in_progress", "in-progress", "running", "started", "generating"].includes(s))
    return "running";
  return "queued";
}

/**
 * SHA256 hash of prompt text — we log this so we can correlate across calls
 * without storing the entire prompt body in tool_execution_logs.
 */
export async function promptHash(text: string): Promise<string> {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Write the initial "attempted" log row and return its id. */
export async function startLog(params: {
  provider: ProviderName | "anthropic";
  toolName: string;
  audit: AvtAuditFields;
  modelVariant: string | undefined;
  promptText: string;
  referenceImageUrl?: string | null;
  extraArgs?: Record<string, unknown>;
}): Promise<{ logId: string | null; requestId: string; startedAt: number }> {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  let logId: string | null = null;
  try {
    const supabase = getServiceClient();
    const hash = await promptHash(params.promptText);
    const { data, error } = await supabase
      .from("tool_execution_logs")
      .insert({
        request_id: requestId,
        tool_name: params.toolName,
        args: {
          ...params.audit,
          provider: params.provider,
          modelVariant: params.modelVariant,
          promptHash: hash,
          referenceImageUrl: params.referenceImageUrl ?? null,
          ...(params.extraArgs ?? {}),
        },
        status: "attempted",
        model: `${params.provider}:${params.modelVariant ?? "default"}`,
        chat_id: params.audit.avt_project_id ?? null,
        user_message: params.promptText.slice(0, 500),
        started_at: new Date(startedAt).toISOString(),
      })
      .select("id")
      .single();
    if (!error && data) logId = data.id;
  } catch (e) {
    console.error("startLog: failed to insert tool_execution_logs row", e);
  }
  return { logId, requestId, startedAt };
}

export async function finishLog(
  logId: string | null,
  outcome: "succeeded" | "failed",
  details: {
    httpStatus?: number;
    responseJson?: Record<string, unknown>;
    error?: string;
    startedAt: number;
  },
) {
  if (!logId) return;
  try {
    const supabase = getServiceClient();
    await supabase
      .from("tool_execution_logs")
      .update({
        status: outcome,
        elapsed_ms: Date.now() - details.startedAt,
        completed_at: new Date().toISOString(),
        http_status: details.httpStatus ?? null,
        response_json: details.responseJson ?? null,
        error: details.error?.slice(0, 5000) ?? null,
      })
      .eq("id", logId);
  } catch (e) {
    console.error("finishLog: failed to update tool_execution_logs row", e);
  }
}

/**
 * Wrap an upstream provider call with retry on 5xx / 429.
 * The callback receives the attempt number (0-indexed).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<{ ok: boolean; status: number; result?: T; error?: string }>,
  maxAttempts = 3,
): Promise<{ ok: boolean; status: number; result?: T; error?: string; attempts: number }> {
  let last: { ok: boolean; status: number; result?: T; error?: string } | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    last = await fn(attempt);
    if (last.ok) return { ...last, attempts: attempt + 1 };
    const retryable = last.status === 429 || (last.status >= 500 && last.status < 600);
    if (!retryable) return { ...last, attempts: attempt + 1 };
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt) + Math.random() * 250));
    }
  }
  return { ...(last ?? { ok: false, status: 0 }), attempts: maxAttempts };
}

/** Common request body parsed by every generate endpoint. */
export type CommonGenerateBody = AvtAuditFields & {
  promptText: string;
  mode?: "text_to_video" | "image_to_video" | "lipsync";
  referenceImageUrl?: string | null;
  referenceVideoUrl?: string | null;
  modelVariant?: string;
  duration?: number;
  aspectRatio?: string;
  seed?: number;
  settings?: Record<string, unknown>;
};

export function validateCommonBody(body: unknown): CommonGenerateBody | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body must be JSON object" };
  const b = body as Record<string, unknown>;
  if (typeof b.promptText !== "string" || (b.promptText as string).trim().length === 0) {
    return { error: "promptText is required and must be a non-empty string" };
  }
  return b as CommonGenerateBody;
}

/**
 * Higgsfield video-generation proxy.
 *
 * Verified live against https://platform.higgsfield.ai on 2026-05-17.
 *
 *   POST {BASE}/v1/image2video/dop
 *   Authorization: Key <KEY_ID>:<KEY_SECRET>
 *   User-Agent: higgsfield-server-js/2.0
 *   Body: { params: { model, prompt, input_images: [{ type, image_url }] } }
 *
 * Models accepted by the dop endpoint: "dop-lite", "dop-preview", "dop-turbo"
 * (server-side enum, validated by FastAPI — anything else returns 422).
 *
 * The dop endpoint is **image-to-video only**. There is no text-to-video
 * variant exposed at this base URL (POST /v1/text2video/dop returns
 * "Model not found"). If the caller doesn't pass a reference image we
 * surface INVALID_INPUT instead of getting a 422 from upstream.
 *
 * Upstream response is a JobSet:
 *   { id, type:"image2video", created_at, jobs:[{ id, status, results }], input_params }
 *
 * Polling lives in video-providers-job-status; it hits
 *   GET {BASE}/requests/{jobset_id}/status
 * which the SDK README documents as the canonical status endpoint.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  corsHeaders,
  checkProxyAuth,
  jsonError,
  jsonOk,
  startLog,
  finishLog,
  withRetry,
  validateCommonBody,
  normaliseStatus,
} from "../_shared/video-providers/proxy.ts";

const HF_BASE_URL = "https://platform.higgsfield.ai";
const HF_USER_AGENT = "higgsfield-server-js/2.0";
const HF_VALID_MODELS = new Set(["dop-lite", "dop-preview", "dop-turbo"]);
const DEFAULT_MODEL = "dop-turbo";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("INVALID_INPUT", "Method must be POST.", 405);

  const auth = checkProxyAuth(req);
  if (!auth.ok) return auth.response;

  // Higgsfield uses an API-key-ID + secret pair (UUID + hex). Auth header
  // is the colon-joined value:  Authorization: Key <KEY_ID>:<KEY_SECRET>
  // (same convention as fal.ai). Both env vars must be set.
  const keyId = Deno.env.get("HIGGSFIELD_API_KEY_ID")?.trim();
  const keySecret = Deno.env.get("HIGGSFIELD_API_SECRET")?.trim();
  if (!keyId || !keySecret) {
    return jsonError(
      "PROVIDER_KEY_NOT_CONFIGURED",
      "HIGGSFIELD_API_KEY_ID and HIGGSFIELD_API_SECRET must both be set in Control Center.",
      503,
      false,
    );
  }
  const authValue = `Key ${keyId}:${keySecret}`;

  let body: unknown;
  try { body = await req.json(); } catch {
    return jsonError("INVALID_INPUT", "Request body is not valid JSON.", 400);
  }
  const parsed = validateCommonBody(body);
  if ("error" in parsed) return jsonError("INVALID_INPUT", parsed.error, 400);

  // Higgsfield's DoP endpoint is image-to-video only — require a reference image.
  if (!parsed.referenceImageUrl || typeof parsed.referenceImageUrl !== "string") {
    return jsonError(
      "INVALID_INPUT",
      "Higgsfield DoP is image-to-video only. Pass referenceImageUrl (a publicly fetchable URL).",
      400,
      false,
    );
  }

  // Normalise modelVariant: accept "dop-turbo", "dop-lite", "dop-preview".
  // Fall back to dop-turbo for any unknown value (matches the SDK default).
  const requested = (parsed.modelVariant ?? DEFAULT_MODEL).toLowerCase();
  const modelVariant = HF_VALID_MODELS.has(requested) ? requested : DEFAULT_MODEL;

  const log = await startLog({
    provider: "higgsfield",
    toolName: "video_provider.higgsfield.generate",
    audit: {
      avt_user_id: parsed.avt_user_id ?? null,
      avt_project_id: parsed.avt_project_id ?? null,
      avt_prompt_id: parsed.avt_prompt_id ?? null,
      avt_shot_id: parsed.avt_shot_id ?? null,
    },
    modelVariant,
    promptText: parsed.promptText,
    referenceImageUrl: parsed.referenceImageUrl,
  });

  const result = await withRetry(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const resp = await fetch(`${HF_BASE_URL}/v1/image2video/dop`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": authValue,
          "User-Agent": HF_USER_AGENT,
        },
        body: JSON.stringify({
          params: {
            model: modelVariant,
            prompt: parsed.promptText,
            input_images: [{ type: "image_url", image_url: parsed.referenceImageUrl }],
            // Pass through caller-specified seed if provided (deterministic re-runs).
            ...(typeof parsed.seed === "number" ? { seed: parsed.seed } : {}),
          },
        }),
      });
      const text = await resp.text();
      let json: Record<string, unknown> = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!resp.ok) {
        // Surface enough upstream detail to debug; truncated so logs stay sane.
        const detail = (json.detail !== undefined ? JSON.stringify(json.detail) : text).slice(0, 800);
        return { ok: false, status: resp.status, error: detail };
      }
      return { ok: true, status: resp.status, result: json };
    } finally { clearTimeout(timer); }
  }, 2);

  if (!result.ok || !result.result) {
    await finishLog(log.logId, "failed", {
      httpStatus: result.status,
      error: result.error ?? "unknown",
      startedAt: log.startedAt,
    });

    // Distinguish error types but ALWAYS surface upstream context so future
    // failures don't get swallowed by a generic "not available" message.
    const isAuth = result.status === 401 || result.status === 403;
    const isValidation = result.status === 400 || result.status === 422;
    const code = isAuth
      ? "UNAUTHORISED"
      : isValidation
        ? "INVALID_INPUT"
        : "PROVIDER_API_ERROR";

    return jsonError(
      code,
      `Higgsfield returned ${result.status}: ${result.error ?? "unknown"}`,
      result.status >= 400 && result.status < 600 ? result.status : 502,
      result.status === 429 || (result.status >= 500 && result.status < 600),
      {
        providerStatus: result.status,
        attempts: result.attempts,
        error_upstream: "higgsfield",
        error_status: result.status,
        error_body_excerpt: (result.error ?? "").slice(0, 500),
      },
    );
  }

  const upstream = result.result as Record<string, unknown>;
  // JobSet shape: { id, type, jobs:[{ id, status, results }], input_params }
  const providerJobId = (upstream.id as string) ?? "";
  const firstJob = Array.isArray(upstream.jobs) && upstream.jobs.length > 0
    ? (upstream.jobs[0] as Record<string, unknown>)
    : {};
  const upstreamStatus = (firstJob.status as string) ?? "queued";
  const status = normaliseStatus(upstreamStatus);

  // Pull a result URL through if the job somehow came back already complete
  // (unlikely for video but cheap to handle).
  let resultUrl: string | null = null;
  const results = firstJob.results as Record<string, unknown> | undefined;
  if (results && typeof results === "object") {
    const raw = results.raw as Record<string, unknown> | undefined;
    resultUrl = (raw?.url as string) ?? null;
  }

  const responseEnvelope = {
    jobId: log.requestId,
    providerJobId,
    status,
    resultUrl,
    costEstimateCents: null,
    costFinalCents: null,
    provider: "higgsfield",
    modelVariant,
    providerMetadata: upstream,
  };

  await finishLog(log.logId, "succeeded", {
    httpStatus: result.status,
    responseJson: responseEnvelope,
    startedAt: log.startedAt,
  });
  return jsonOk(responseEnvelope);
});

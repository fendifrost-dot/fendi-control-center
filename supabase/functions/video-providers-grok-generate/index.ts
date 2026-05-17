/**
 * Grok (xAI) video-generation proxy.
 *
 * xAI's Grok Imagine clip generation API is publicly available as of
 * May 2026 via https://api.x.ai/v1/videos/generations.
 * (See https://docs.x.ai/developers/model-capabilities/video/generation)
 *
 * Flow is async:
 *   1. POST /v1/videos/generations  -> { request_id }
 *   2. Poll GET /v1/videos/<request_id>  -> { status: pending|done|failed|expired, video: {url, duration, ...} }
 *
 * This function handles step 1 and returns the request_id as providerJobId.
 * AVT then polls via video-providers-job-status (?provider=grok&id=...).
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

const XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-imagine-video";
const DEFAULT_DURATION = 5;
const DEFAULT_RESOLUTION = "720p";
// Cost estimate per generation in cents — placeholder until real pricing
// lands (xAI exposes pricing on /developers/pricing).
const GROK_CENTS_PER_GENERATION = 60;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("INVALID_INPUT", "Method must be POST.", 405);

  const auth = checkProxyAuth(req);
  if (!auth.ok) return auth.response;

  const apiKey = Deno.env.get("Frost_Grok")?.trim();
  if (!apiKey) {
    return jsonError(
      "PROVIDER_KEY_NOT_CONFIGURED",
      "Frost_Grok is not configured in Control Center.",
      503,
      false,
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return jsonError("INVALID_INPUT", "Request body is not valid JSON.", 400);
  }
  const parsed = validateCommonBody(body);
  if ("error" in parsed) return jsonError("INVALID_INPUT", parsed.error, 400);

  const modelVariant = parsed.modelVariant ?? DEFAULT_MODEL;
  const mode = parsed.mode ?? (parsed.referenceImageUrl ? "image_to_video" : "text_to_video");
  const duration = Math.max(1, Math.min(15, parsed.duration ?? DEFAULT_DURATION));
  const aspect_ratio = parsed.aspectRatio ?? "16:9";
  const resolution =
    typeof (parsed.settings as Record<string, unknown> | undefined)?.resolution === "string"
      ? ((parsed.settings as Record<string, unknown>).resolution as string)
      : DEFAULT_RESOLUTION;

  const log = await startLog({
    provider: "grok",
    toolName: "video_provider.grok.generate",
    audit: {
      avt_user_id: parsed.avt_user_id ?? null,
      avt_project_id: parsed.avt_project_id ?? null,
      avt_prompt_id: parsed.avt_prompt_id ?? null,
      avt_shot_id: parsed.avt_shot_id ?? null,
    },
    modelVariant,
    promptText: parsed.promptText,
    referenceImageUrl: parsed.referenceImageUrl,
    extraArgs: { mode, duration, aspect_ratio, resolution },
  });

  const xaiBody: Record<string, unknown> = {
    model: modelVariant,
    prompt: parsed.promptText,
    duration,
    aspect_ratio,
    resolution,
  };
  if (mode === "image_to_video" && parsed.referenceImageUrl) {
    xaiBody.image = parsed.referenceImageUrl;
  }

  const result = await withRetry(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const resp = await fetch(`${XAI_BASE_URL}/videos/generations`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(xaiBody),
      });
      const text = await resp.text();
      let json: Record<string, unknown> = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!resp.ok) {
        const errObj = (json.error as Record<string, unknown> | undefined) ?? null;
        const message =
          (errObj?.message as string) ??
          (json.detail as string) ??
          (json.error as string) ??
          text.slice(0, 500);
        return { ok: false, status: resp.status, error: message };
      }
      return { ok: true, status: resp.status, result: json };
    } finally { clearTimeout(timer); }
  });

  if (!result.ok || !result.result) {
    await finishLog(log.logId, "failed", {
      httpStatus: result.status,
      error: result.error ?? "unknown",
      startedAt: log.startedAt,
    });
    const isAuth = result.status === 401 || result.status === 403;
    return jsonError(
      isAuth ? "UNAUTHORISED" : "PROVIDER_API_ERROR",
      `Grok returned ${result.status}: ${result.error ?? "unknown"}`,
      result.status >= 400 && result.status < 600 ? result.status : 502,
      result.status === 429 || (result.status >= 500 && result.status < 600),
      { providerStatus: result.status, attempts: result.attempts },
    );
  }

  const upstream = result.result as Record<string, unknown>;
  // xAI returns { request_id } on submit.
  const providerJobId = (upstream.request_id as string) ?? (upstream.id as string) ?? "";
  const status = normaliseStatus("queued");

  const responseEnvelope = {
    jobId: log.requestId,
    providerJobId,
    status,
    resultUrl: null,
    costEstimateCents: GROK_CENTS_PER_GENERATION,
    costFinalCents: null,
    provider: "grok",
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

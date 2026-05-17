/**
 * Pika video-generation proxy.
 *
 * Pika's dev API is no longer separately available — Pika is gated behind
 * Fal.ai for API consumers. This function preserves the original
 * `video-providers-pika-generate` endpoint and request envelope but
 * internally routes the request to the Fal endpoint using one of the
 * `fal-ai/pika/v2.2/*` models.
 *
 * Why: AVT's UI keeps a "Pika" tab so existing shot data, seed templates,
 * and `provider = 'pika'` rows remain valid. Callers do not have to know
 * the proxy is now Fal under the hood. No separate PIKA_API_KEY is
 * required anywhere — only FAL_API_KEY.
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

const FAL_BASE_URL = "https://queue.fal.run";
// Default Pika-on-Fal models, current as of May 2026.
// (See https://fal.ai/models/fal-ai/pika/v2.2/text-to-video)
const DEFAULT_PIKA_MODEL_T2V = "fal-ai/pika/v2.2/text-to-video";
const DEFAULT_PIKA_MODEL_I2V = "fal-ai/pika/v2.2/image-to-video";
const DEFAULT_DURATION = 5;
// Per-generation cost estimate for Pika v2.2 on Fal (cents) — best-effort
// placeholder, updated when invoices land.
const PIKA_ON_FAL_CENTS_PER_GENERATION = 45;

function resolveFalModel(mode: string, requestedVariant: string | undefined): string {
  // If caller already passed a fal-ai/pika/... model, honour it.
  if (requestedVariant && requestedVariant.startsWith("fal-ai/pika/")) {
    return requestedVariant;
  }
  // Otherwise default per mode.
  return mode === "image_to_video" ? DEFAULT_PIKA_MODEL_I2V : DEFAULT_PIKA_MODEL_T2V;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("INVALID_INPUT", "Method must be POST.", 405);

  const auth = checkProxyAuth(req);
  if (!auth.ok) return auth.response;

  const apiKey = Deno.env.get("FAL_API_KEY")?.trim();
  if (!apiKey) {
    return jsonError(
      "PROVIDER_KEY_NOT_CONFIGURED",
      "FAL_API_KEY is not configured in Control Center. Pika is now routed through Fal so the FAL key is required.",
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

  const mode = parsed.mode ?? (parsed.referenceImageUrl ? "image_to_video" : "text_to_video");
  const falModel = resolveFalModel(mode, parsed.modelVariant);
  const userFacingVariant = parsed.modelVariant ?? "pika-2.2";
  const duration = parsed.duration ?? DEFAULT_DURATION;
  const costEstimateCents = PIKA_ON_FAL_CENTS_PER_GENERATION;

  const log = await startLog({
    provider: "pika",
    toolName: "video_provider.pika.generate",
    audit: {
      avt_user_id: parsed.avt_user_id ?? null,
      avt_project_id: parsed.avt_project_id ?? null,
      avt_prompt_id: parsed.avt_prompt_id ?? null,
      avt_shot_id: parsed.avt_shot_id ?? null,
    },
    modelVariant: userFacingVariant,
    promptText: parsed.promptText,
    referenceImageUrl: parsed.referenceImageUrl,
    extraArgs: { mode, duration, costEstimateCents, routedVia: "fal", falModel },
  });

  const falBody: Record<string, unknown> = {
    prompt: parsed.promptText,
    duration,
    aspect_ratio: parsed.aspectRatio ?? "16:9",
  };
  if (mode === "image_to_video" && parsed.referenceImageUrl) {
    falBody.image_url = parsed.referenceImageUrl;
  }
  if (typeof parsed.seed === "number") falBody.seed = parsed.seed;
  if (parsed.negativePrompt) falBody.negative_prompt = parsed.negativePrompt;

  const url = `${FAL_BASE_URL}/${falModel}`;

  const result = await withRetry(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Key ${apiKey}`,
        },
        body: JSON.stringify(falBody),
      });
      const text = await resp.text();
      let json: Record<string, unknown> = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!resp.ok) {
        return {
          ok: false,
          status: resp.status,
          error: (json.detail as string) ?? (json.error as string) ?? text.slice(0, 500),
        };
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
      `Pika-via-Fal (${falModel}) returned ${result.status}: ${result.error ?? "unknown"}`,
      result.status >= 400 && result.status < 600 ? result.status : 502,
      result.status === 429 || (result.status >= 500 && result.status < 600),
      { providerStatus: result.status, attempts: result.attempts, falModel },
    );
  }

  const upstream = result.result as Record<string, unknown>;
  const providerJobId = (upstream.request_id as string) ?? (upstream.id as string) ?? "";
  const status = normaliseStatus((upstream.status as string) ?? "queued");

  const responseEnvelope = {
    jobId: log.requestId,
    providerJobId,
    status,
    resultUrl: null,
    costEstimateCents,
    costFinalCents: null,
    provider: "pika",
    modelVariant: userFacingVariant,
    providerMetadata: { ...upstream, _routedVia: "fal", _falModel: falModel },
  };

  await finishLog(log.logId, "succeeded", {
    httpStatus: result.status,
    responseJson: responseEnvelope,
    startedAt: log.startedAt,
  });
  return jsonOk(responseEnvelope);
});

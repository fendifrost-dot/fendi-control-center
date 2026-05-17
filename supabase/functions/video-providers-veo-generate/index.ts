/**
 * Veo (Google) video-generation proxy.
 *
 * Calls Google's Generative Language v1beta `:predictLongRunning` endpoint
 * for veo-3.1-generate-preview. API key reuses Control Center's existing
 * `Frost_Gemini` secret (same one used by Gemini parser / OCR).
 *
 * Docs: https://ai.google.dev/gemini-api/docs/video
 *
 * Kickoff response shape (verified 2026-05-17 via curl):
 *   { name: "models/veo-3.1-generate-preview/operations/<id>" }
 *
 * Note: `numberOfVideos` is rejected by this model — do NOT include it.
 * Pricing is per-second on Veo; estimate is ~$0.50/sec.
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

const VEO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "veo-3.1-generate-preview";
const DEFAULT_DURATION = 8;
const DEFAULT_ASPECT = "16:9";
const DEFAULT_RESOLUTION = "1080p";
const ALLOWED_ASPECTS = new Set(["16:9", "16:10"]);
const ALLOWED_RESOLUTIONS = new Set(["720p", "1080p"]);
const VEO_CENTS_PER_SECOND = 50;

/** Veo 3.x accepts integer seconds 4-8 inclusive. Clamp + round to range. */
function coerceVeoDuration(d: number): number {
  if (!Number.isFinite(d)) return DEFAULT_DURATION;
  return Math.max(4, Math.min(8, Math.round(d)));
}

function coerceAspect(a: string | undefined): string {
  if (!a) return DEFAULT_ASPECT;
  return ALLOWED_ASPECTS.has(a) ? a : DEFAULT_ASPECT;
}

function coerceResolution(r: string | undefined): string {
  if (!r) return DEFAULT_RESOLUTION;
  return ALLOWED_RESOLUTIONS.has(r) ? r : DEFAULT_RESOLUTION;
}

function estimateCostCents(_model: string, durationSeconds: number): number {
  return Math.round(VEO_CENTS_PER_SECOND * durationSeconds);
}

/** Best-effort fetch + base64 of a reference image URL for image-to-video.
 *  Veo expects { image: { bytesBase64Encoded, mimeType } }. */
async function fetchImageAsBase64(
  imageUrl: string,
): Promise<{ bytesBase64Encoded: string; mimeType: string } | null> {
  try {
    const resp = await fetch(imageUrl);
    if (!resp.ok) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    const mimeType = resp.headers.get("content-type") ?? "image/png";
    // Stream-based base64 to avoid call-stack overflow on large images.
    const { encodeBase64 } = await import(
      "https://deno.land/std@0.224.0/encoding/base64.ts"
    );
    return { bytesBase64Encoded: encodeBase64(buf), mimeType };
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("INVALID_INPUT", "Method must be POST.", 405);

  const auth = checkProxyAuth(req);
  if (!auth.ok) return auth.response;

  const apiKey = Deno.env.get("Frost_Gemini")?.trim();
  if (!apiKey) {
    return jsonError(
      "PROVIDER_KEY_NOT_CONFIGURED",
      "Frost_Gemini is not configured in Control Center.",
      503,
      false,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("INVALID_INPUT", "Request body is not valid JSON.", 400);
  }
  const parsed = validateCommonBody(body);
  if ("error" in parsed) return jsonError("INVALID_INPUT", parsed.error, 400);

  const mode = parsed.mode ?? (parsed.referenceImageUrl ? "image_to_video" : "text_to_video");
  if (mode === "lipsync") {
    return jsonError(
      "INVALID_INPUT",
      "lipsync mode is not supported on Veo.",
      400,
    );
  }
  const modelVariant = parsed.modelVariant ?? DEFAULT_MODEL;
  const duration = coerceVeoDuration(parsed.duration ?? DEFAULT_DURATION);
  const aspectRatio = coerceAspect(parsed.aspectRatio);
  const resolution = coerceResolution((parsed as Record<string, unknown>).resolution as string | undefined);
  const costEstimateCents = estimateCostCents(modelVariant, duration);

  const log = await startLog({
    provider: "veo",
    toolName: "video_provider.veo.generate",
    audit: {
      avt_user_id: parsed.avt_user_id ?? null,
      avt_project_id: parsed.avt_project_id ?? null,
      avt_prompt_id: parsed.avt_prompt_id ?? null,
      avt_shot_id: parsed.avt_shot_id ?? null,
    },
    modelVariant,
    promptText: parsed.promptText,
    referenceImageUrl: parsed.referenceImageUrl,
    extraArgs: { mode, duration, aspectRatio, resolution, costEstimateCents },
  });

  // Build the instance. Image-to-video adds an `image` field with base64 bytes.
  const instance: Record<string, unknown> = { prompt: parsed.promptText };
  if (mode === "image_to_video" && parsed.referenceImageUrl) {
    const img = await fetchImageAsBase64(parsed.referenceImageUrl);
    if (!img) {
      await finishLog(log.logId, "failed", {
        httpStatus: 400,
        error: "could not fetch reference image",
        startedAt: log.startedAt,
      });
      return jsonError(
        "INVALID_INPUT",
        `Could not fetch reference image at ${parsed.referenceImageUrl}.`,
        400,
      );
    }
    instance.image = img;
  }

  const instances: Record<string, unknown>[] = [instance];
  const parameters: Record<string, unknown> = {
    aspectRatio,
    durationSeconds: duration,
    personGeneration: "allow_all",
    resolution,
  };
  if (typeof parsed.seed === "number") parameters.seed = parsed.seed;

  const url = `${VEO_BASE_URL}/models/${encodeURIComponent(modelVariant)}:predictLongRunning`;

  const result = await withRetry(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({ instances, parameters }),
      });
      const text = await resp.text();
      let json: Record<string, unknown> = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }
      if (!resp.ok) {
        return {
          ok: false,
          status: resp.status,
          error: ((json.error as Record<string, unknown> | undefined)?.message as string) ??
            text.slice(0, 500),
        };
      }
      return { ok: true, status: resp.status, result: json };
    } finally {
      clearTimeout(timer);
    }
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
      `Veo returned ${result.status}: ${result.error ?? "unknown"}`,
      result.status >= 400 && result.status < 600 ? result.status : 502,
      result.status === 429 || (result.status >= 500 && result.status < 600),
      { providerStatus: result.status, attempts: result.attempts },
    );
  }

  const upstream = result.result as Record<string, unknown>;
  // Operation name is fully qualified, e.g.
  //   "models/veo-3.1-generate-preview/operations/s32li62yjvff"
  // Store this exact string as providerJobId so the status/result functions
  // can pass it straight back to the /v1beta/{name} endpoint.
  const providerJobId = (upstream.name as string) ?? "";
  const upstreamStatus = upstream.done ? "succeeded" : "running";
  const status = normaliseStatus(upstreamStatus);

  const responseEnvelope = {
    jobId: log.requestId,
    providerJobId,
    status,
    resultUrl: null,
    costEstimateCents,
    costFinalCents: null,
    provider: "veo",
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

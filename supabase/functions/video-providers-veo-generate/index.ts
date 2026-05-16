/**
 * Veo (Google) video-generation proxy.
 *
 * Uses Google's Generative AI v1beta predictLongRunning endpoint for
 * veo-3.0-generate-preview. API key reuses Control Center's existing
 * `Frost_Gemini` secret (same one used by Gemini parser / OCR).
 *
 * Docs: https://ai.google.dev/gemini-api/docs/video
 *
 * Pricing is per-second on Veo; estimate is ~$0.50/sec on the GA tier.
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
const DEFAULT_MODEL = "veo-3.0-generate-preview";
const DEFAULT_DURATION = 8;
const DEFAULT_ASPECT = "16:9";
const VEO_CENTS_PER_SECOND = 50;

function estimateCostCents(_model: string, durationSeconds: number): number {
  return Math.round(VEO_CENTS_PER_SECOND * durationSeconds);
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
  if (mode === "lipsync" && !parsed.referenceVideoUrl) {
    return jsonError(
      "INVALID_INPUT",
      "lipsync mode requires referenceVideoUrl",
      400,
    );
  }
  const modelVariant = parsed.modelVariant ?? DEFAULT_MODEL;
  const duration = parsed.duration ?? DEFAULT_DURATION;
  const aspectRatio = parsed.aspectRatio ?? DEFAULT_ASPECT;
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
    extraArgs: { mode, duration, aspectRatio, costEstimateCents },
  });

  // Map to Veo's predictLongRunning shape.
  const instances: Record<string, unknown>[] = [
    {
      prompt: parsed.promptText,
      ...(mode === "image_to_video" && parsed.referenceImageUrl
        ? {
            image: {
              gcsUri: undefined,
              imageBytes: undefined,
              uri: parsed.referenceImageUrl,
            },
          }
        : {}),
    },
  ];
  const parameters: Record<string, unknown> = {
    aspectRatio,
    durationSeconds: duration,
    personGeneration: "allow_adult",
  };
  if (typeof parsed.seed === "number") parameters.seed = parsed.seed;

  const url = `${VEO_BASE_URL}/models/${encodeURIComponent(modelVariant)}:predictLongRunning?key=${encodeURIComponent(apiKey)}`;

  const result = await withRetry(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
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

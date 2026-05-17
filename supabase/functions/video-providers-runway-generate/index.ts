/**
 * Runway video-generation proxy.
 *
 * Wraps Runway's official REST API (https://docs.dev.runwayml.com/).
 * Supports image_to_video (Gen-3 Alpha Turbo with image conditioning) and
 * text_to_video.
 *
 * Pricing (as of May 2026): gen3a_turbo is ~5 credits/second, ~$0.05/credit.
 * We surface a costEstimateCents based on declared `duration`.
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

const RUNWAY_BASE_URL = "https://api.dev.runwayml.com/v1";
const RUNWAY_API_VERSION = "2024-11-06";
const DEFAULT_MODEL_T2V = "gen4_aleph"; // text-to-video flagship as of 2026-05
const DEFAULT_MODEL_I2V = "gen4_turbo";
const DEFAULT_DURATION = 5; // seconds
const DEFAULT_ASPECT = "1280:720";

// Per-second pricing — keep as a constant we can update without touching call sites.
const RUNWAY_CENTS_PER_SECOND_BY_MODEL: Record<string, number> = {
  gen3a_turbo: 5,
  gen3a: 10,
  gen4_turbo: 5,
  gen4: 12,
  gen4_aleph: 12,
  "gen4.5": 15,
  gen4_image: 5,
  gen4_image_turbo: 3,
};

const RATIO_MAP_GEN4: Record<string, string> = {
  "16:9": "1280:720",
  "9:16": "720:1280",
  "1:1": "960:960",
  "4:3": "1104:832",
  "3:4": "832:1104",
  "21:9": "1584:672",
};

function coerceRunwayRatio(modelVariant: string, ratio: string): string {
  // gen4 wants pixel ratios (e.g. "1280:720"); if a friendly ratio (16:9, 9:16, ...) sneaks in, map it.
  if (modelVariant.startsWith("gen4")) {
    if (/^\d+:\d+$/.test(ratio) && ratio.split(":").every(n => Number(n) >= 256)) return ratio;
    return RATIO_MAP_GEN4[ratio] ?? "1280:720";
  }
  return ratio;
}

function coerceRunwayDuration(d: number): number {
  // Runway gen4_turbo accepts 5 or 10 only.
  return d >= 8 ? 10 : 5;
}

function estimateCostCents(model: string, durationSeconds: number): number {
  const rate = RUNWAY_CENTS_PER_SECOND_BY_MODEL[model] ?? 5;
  return Math.round(rate * durationSeconds);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonError("INVALID_INPUT", "Method must be POST.", 405);
  }

  const auth = checkProxyAuth(req);
  if (!auth.ok) return auth.response;

  const apiKey = Deno.env.get("RUNWAY_API_KEY")?.trim();
  if (!apiKey) {
    return jsonError(
      "PROVIDER_KEY_NOT_CONFIGURED",
      "RUNWAY_API_KEY is not configured in Control Center.",
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
  if (mode === "image_to_video" && !parsed.referenceImageUrl) {
    return jsonError(
      "INVALID_INPUT",
      "image_to_video requires referenceImageUrl",
      400,
    );
  }

  const modelVariant = parsed.modelVariant ?? (mode === "image_to_video" ? DEFAULT_MODEL_I2V : DEFAULT_MODEL_T2V);
  const duration = parsed.duration ?? DEFAULT_DURATION;
  const aspectRatio = parsed.aspectRatio ?? DEFAULT_ASPECT;
  const costEstimateCents = estimateCostCents(modelVariant, duration);

  const log = await startLog({
    provider: "runway",
    toolName: "video_provider.runway.generate",
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

  // Map our normalised shape to Runway's request shape.
  const runwayUrl =
    mode === "image_to_video"
      ? `${RUNWAY_BASE_URL}/image_to_video`
      : `${RUNWAY_BASE_URL}/text_to_video`;

  const coercedRatio = coerceRunwayRatio(modelVariant, aspectRatio);
  const coercedDuration = coerceRunwayDuration(duration);
  const runwayBody: Record<string, unknown> = {
    model: modelVariant,
    promptText: parsed.promptText,
    duration: coercedDuration,
    ratio: coercedRatio,
  };
  if (mode === "image_to_video") {
    runwayBody.promptImage = parsed.referenceImageUrl;
  }
  if (typeof parsed.seed === "number") runwayBody.seed = parsed.seed;

  const result = await withRetry(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const resp = await fetch(runwayUrl, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "X-Runway-Version": RUNWAY_API_VERSION,
        },
        body: JSON.stringify(runwayBody),
      });
      const text = await resp.text();
      let json: Record<string, unknown> = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }
      if (!resp.ok) {
        // Surface the FULL upstream body so callers can see Runway's validation details
        // (e.g. which field failed). Runway returns {"error":"..."} but the field-level
        // problem only shows up in the raw text or other JSON keys.
        const summary = typeof json.error === "string" ? json.error : "unknown";
        const fullRaw = (text || "").slice(0, 800);
        return {
          ok: false,
          status: resp.status,
          error: `${summary} | raw: ${fullRaw}`,
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
      `Runway returned ${result.status}: ${result.error ?? "unknown"}`,
      result.status >= 400 && result.status < 600 ? result.status : 502,
      result.status === 429 || (result.status >= 500 && result.status < 600),
      { providerStatus: result.status, attempts: result.attempts },
    );
  }

  const upstream = result.result as Record<string, unknown>;
  const providerJobId = (upstream.id as string) ?? (upstream.task_id as string) ?? "";
  const upstreamStatus = (upstream.status as string) ?? "PENDING";
  const status = normaliseStatus(upstreamStatus);

  const responseEnvelope = {
    jobId: log.requestId,
    providerJobId,
    status,
    resultUrl: null,
    costEstimateCents,
    costFinalCents: null,
    provider: "runway",
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

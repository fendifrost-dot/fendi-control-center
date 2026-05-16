/**
 * Pika video-generation proxy.
 *
 * Wraps Pika's REST API (https://pika.art/docs/api). Supports
 * text_to_video and image_to_video.
 *
 * Pricing is per-generation flat; this estimate is a best-effort
 * placeholder pending Fendi's invoice data.
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

const PIKA_BASE_URL = "https://api.pika.art/v1";
const DEFAULT_MODEL = "pika-2.0";
const DEFAULT_DURATION = 4;
const PIKA_CENTS_PER_GENERATION = 35;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("INVALID_INPUT", "Method must be POST.", 405);

  const auth = checkProxyAuth(req);
  if (!auth.ok) return auth.response;

  const apiKey = Deno.env.get("PIKA_API_KEY")?.trim();
  if (!apiKey) {
    return jsonError(
      "PROVIDER_KEY_NOT_CONFIGURED",
      "PIKA_API_KEY is not configured in Control Center.",
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
  const modelVariant = parsed.modelVariant ?? DEFAULT_MODEL;
  const duration = parsed.duration ?? DEFAULT_DURATION;
  const costEstimateCents = PIKA_CENTS_PER_GENERATION;

  const log = await startLog({
    provider: "pika",
    toolName: "video_provider.pika.generate",
    audit: {
      avt_user_id: parsed.avt_user_id ?? null,
      avt_project_id: parsed.avt_project_id ?? null,
      avt_prompt_id: parsed.avt_prompt_id ?? null,
      avt_shot_id: parsed.avt_shot_id ?? null,
    },
    modelVariant,
    promptText: parsed.promptText,
    referenceImageUrl: parsed.referenceImageUrl,
    extraArgs: { mode, duration, costEstimateCents },
  });

  const pikaBody: Record<string, unknown> = {
    promptText: parsed.promptText,
    model: modelVariant,
    options: { duration, aspectRatio: parsed.aspectRatio ?? "16:9" },
  };
  if (mode === "image_to_video" && parsed.referenceImageUrl) {
    pikaBody.image = parsed.referenceImageUrl;
  }
  if (typeof parsed.seed === "number") (pikaBody.options as Record<string, unknown>).seed = parsed.seed;

  const url = mode === "image_to_video"
    ? `${PIKA_BASE_URL}/generate/image-to-video`
    : `${PIKA_BASE_URL}/generate/text-to-video`;

  const result = await withRetry(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(pikaBody),
      });
      const text = await resp.text();
      let json: Record<string, unknown> = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!resp.ok) {
        return { ok: false, status: resp.status, error: (json.error as string) ?? text.slice(0, 500) };
      }
      return { ok: true, status: resp.status, result: json };
    } finally { clearTimeout(timer); }
  });

  if (!result.ok || !result.result) {
    await finishLog(log.logId, "failed", { httpStatus: result.status, error: result.error ?? "unknown", startedAt: log.startedAt });
    const isAuth = result.status === 401 || result.status === 403;
    return jsonError(
      isAuth ? "UNAUTHORISED" : "PROVIDER_API_ERROR",
      `Pika returned ${result.status}: ${result.error ?? "unknown"}`,
      result.status >= 400 && result.status < 600 ? result.status : 502,
      result.status === 429 || (result.status >= 500 && result.status < 600),
      { providerStatus: result.status, attempts: result.attempts },
    );
  }

  const upstream = result.result as Record<string, unknown>;
  const providerJobId = (upstream.id as string) ?? (upstream.job_id as string) ?? "";
  const status = normaliseStatus((upstream.status as string) ?? "queued");

  const responseEnvelope = {
    jobId: log.requestId,
    providerJobId,
    status,
    resultUrl: null,
    costEstimateCents,
    costFinalCents: null,
    provider: "pika",
    modelVariant,
    providerMetadata: upstream,
  };

  await finishLog(log.logId, "succeeded", { httpStatus: result.status, responseJson: responseEnvelope, startedAt: log.startedAt });
  return jsonOk(responseEnvelope);
});

/**
 * Higgsfield CATALOGUE proxy — text-to-video and image-to-video through the models
 * Higgsfield hosts (Kling, MiniMax Hailuo, …), as opposed to video-providers-higgsfield-generate
 * which is Higgsfield's own DoP camera model (image-to-video only).
 *
 * Why a second function (2026-10-01): DoP animates a photographed-looking still with a camera
 * move but does not build worlds from text; the treatment's "world" scenes (the arctic room, the
 * fashion show behind the artist, the reporters' car) need a text-to-video world builder. The
 * catalogue is routed at the api host:
 *
 *   POST https://api.higgsfield.ai/<model-path>          Authorization: Key <KEY_ID>:<KEY_SECRET>
 *   Body: the model's own input schema (prompt, duration, …) — see docs.higgsfield.ai/docs/openapi.json
 *   Response: RequestStatus { request_id, status, status_url, cancel_url, video?: { url } }
 *   Status:   GET https://api.higgsfield.ai/requests/{request_id}/status  (job-status handles it)
 *
 * Model paths are an allowlist here (each with its duration enum and which fields it accepts) so a
 * caller cannot aim this at an arbitrary endpoint; adding a model is one line of data.
 *
 * Modes: text_to_video (prompt), image_to_video (prompt + referenceImageUrl), video_to_video (prompt +
 * referenceVideoUrl + referenceImageUrls[1..n] + resolution — Genjutsu object-swap / motion-transfer).
 *
 * Secrets: HIGGSFIELD_API_KEY_ID + HIGGSFIELD_API_SECRET (same pair as the DoP function).
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

const HF_API_BASE = "https://api.higgsfield.ai";
const HF_USER_AGENT = "higgsfield-server-js/2.0";
const SUBMIT_TIMEOUT_MS = 55_000;   // the catalogue submit is synchronous at Higgsfield and has been seen to take > 30 s

type ModelSpec = {
  path: string;
  mode: "text_to_video" | "image_to_video" | "video_to_video";
  durations: number[];          // the model's duration enum; empty for video-to-video (output length follows the source)
  fields: string[];             // optional input fields the model accepts besides prompt/duration(/image_url/video_url/image_urls)
  centsPerSecond: number;       // list price for the cost estimate (2026-10, docs.higgsfield.ai); the balance is authoritative
  resolutions?: Record<string, number>;   // video-to-video: allowed `resolution` values → cents per SOURCE second (overrides centsPerSecond)
  maxImages?: number;           // video-to-video: how many image_urls the model accepts
};

// Catalogue allowlist. Keys are what callers pass as modelVariant. `fields` is exactly the optional
// input set each model declares in docs.higgsfield.ai/docs/openapi.json (checked 2026-10-01): none of
// these models takes aspect_ratio or seed — the text-to-video models render at their own default
// frame, so a 9:16 world is built still-first (a 9:16 still into an image-to-video model sets the frame).
const MODELS: Record<string, ModelSpec> = {
  "kling-2.5-turbo-pro-t2v":      { path: "/kling-video/v2.5-turbo/pro/text-to-video",      mode: "text_to_video",  durations: [5, 10], fields: ["cfg_scale", "negative_prompt"],                 centsPerSecond: 7 },
  "kling-2.5-turbo-pro-i2v":      { path: "/kling-video/v2.5-turbo/pro/image-to-video",     mode: "image_to_video", durations: [5, 10], fields: ["cfg_scale", "negative_prompt"],                 centsPerSecond: 7 },
  "kling-2.5-turbo-standard-i2v": { path: "/kling-video/v2.5-turbo/standard/image-to-video", mode: "image_to_video", durations: [5, 10], fields: ["cfg_scale", "negative_prompt"],                 centsPerSecond: 4 },
  "hailuo-2.3-standard-t2v":      { path: "/minimax/hailuo-2.3/standard/text-to-video",      mode: "text_to_video",  durations: [6, 10], fields: ["prompt_optimizer"],                            centsPerSecond: 5 },
  "hailuo-2.3-standard-i2v":      { path: "/minimax/hailuo-2.3/standard/image-to-video",     mode: "image_to_video", durations: [6, 10], fields: ["prompt_optimizer"],                            centsPerSecond: 5 },
  // Genjutsu (Higgsfield's own video-to-video, released 2026-09-17; docs.higgsfield.ai/docs/models/genjutsu/*):
  // object-swap replaces only the element the prompt names (an outfit, a product) and keeps the rest of the
  // footage; motion-transfer keeps motion/camera/timing and rebuilds everything else from the references.
  // Source video 4–30 s (longer is trimmed), ≥ 409 600 px per frame, 1–8 reference images; output length = source.
  // Billed per SOURCE second, rounded up, by output resolution: 480p 31.8¢ · 720p 68.1¢ · 1080p 163.2¢.
  "genjutsu-object-swap":         { path: "/higgsfield/genjutsu/object-swap/v1.0",            mode: "video_to_video", durations: [],      fields: ["resolution"], centsPerSecond: 68.1, resolutions: { "480p": 31.8, "720p": 68.1, "1080p": 163.2 }, maxImages: 8 },
  "genjutsu-motion-transfer":     { path: "/higgsfield/genjutsu/motion-transfer/v1.0",        mode: "video_to_video", durations: [],      fields: ["resolution"], centsPerSecond: 68.1, resolutions: { "480p": 31.8, "720p": 68.1, "1080p": 163.2 }, maxImages: 8 },
};
const DEFAULT_T2V = "kling-2.5-turbo-pro-t2v";
const DEFAULT_I2V = "kling-2.5-turbo-pro-i2v";
const DEFAULT_V2V = "genjutsu-object-swap";
const DEFAULT_V2V_RESOLUTION = "720p";

function pickDuration(spec: ModelSpec, requested: number | undefined): number {
  if (spec.durations.length === 0) return Math.max(1, Math.ceil(Number(requested ?? 0)));   // v2v: the caller's source length, for the estimate only
  const want = Number(requested ?? spec.durations[0]);
  return spec.durations.reduce((best, d) => (Math.abs(d - want) < Math.abs(best - want) ? d : best), spec.durations[0]);
}

function isHttpUrl(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\/\S{1,2080}$/.test(v);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("INVALID_INPUT", "Method must be POST.", 405);
  const auth = checkProxyAuth(req);
  if (!auth.ok) return auth.response;

  const keyId = Deno.env.get("HIGGSFIELD_API_KEY_ID")?.trim();
  const keySecret = Deno.env.get("HIGGSFIELD_API_SECRET")?.trim();
  if (!keyId || !keySecret) {
    return jsonError("PROVIDER_KEY_NOT_CONFIGURED", "HIGGSFIELD_API_KEY_ID and HIGGSFIELD_API_SECRET must both be set in Control Center.", 503, false);
  }
  const authValue = `Key ${keyId}:${keySecret}`;

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("INVALID_INPUT", "Request body is not valid JSON.", 400); }
  const parsed = validateCommonBody(body);
  if ("error" in parsed) return jsonError("INVALID_INPUT", parsed.error, 400);
  const extra = body as Record<string, unknown>;

  const mode = parsed.mode ?? (parsed.referenceVideoUrl ? "video_to_video" : parsed.referenceImageUrl ? "image_to_video" : "text_to_video");
  const requested = (parsed.modelVariant ?? (mode === "video_to_video" ? DEFAULT_V2V : mode === "image_to_video" ? DEFAULT_I2V : DEFAULT_T2V)).toLowerCase();
  const spec = MODELS[requested];
  if (!spec) return jsonError("INVALID_INPUT", `Unknown modelVariant "${requested}". Known: ${Object.keys(MODELS).join(", ")}`, 400, false);
  if (spec.mode === "image_to_video" && !parsed.referenceImageUrl) return jsonError("INVALID_INPUT", `${requested} is image-to-video: pass referenceImageUrl (a publicly fetchable URL).`, 400, false);
  // video-to-video: the source clip + 1..maxImages reference images; `referenceImageUrls` (array) wins, else the single referenceImageUrl
  const refImages: string[] = Array.isArray(extra.referenceImageUrls)
    ? (extra.referenceImageUrls as unknown[]).filter(isHttpUrl)
    : parsed.referenceImageUrl ? [parsed.referenceImageUrl] : [];
  let resolution: string | undefined;
  if (spec.mode === "video_to_video") {
    if (!isHttpUrl(parsed.referenceVideoUrl)) return jsonError("INVALID_INPUT", `${requested} is video-to-video: pass referenceVideoUrl (a publicly fetchable URL of the source clip).`, 400, false);
    if (refImages.length < 1 || refImages.length > (spec.maxImages ?? 8)) return jsonError("INVALID_INPUT", `${requested} needs 1–${spec.maxImages ?? 8} reference images (referenceImageUrls or referenceImageUrl).`, 400, false);
    resolution = String(extra.resolution ?? DEFAULT_V2V_RESOLUTION);
    if (spec.resolutions && !(resolution in spec.resolutions)) return jsonError("INVALID_INPUT", `resolution must be one of ${Object.keys(spec.resolutions).join(", ")}.`, 400, false);
  }
  const duration = pickDuration(spec, parsed.duration);
  const centsPerSecond = (spec.mode === "video_to_video" && spec.resolutions && resolution) ? spec.resolutions[resolution] : spec.centsPerSecond;

  const input: Record<string, unknown> = spec.mode === "video_to_video"
    ? { prompt: parsed.promptText, video_url: parsed.referenceVideoUrl, image_urls: refImages, resolution }
    : { prompt: parsed.promptText, duration };
  if (spec.mode === "image_to_video") input.image_url = parsed.referenceImageUrl;
  for (const f of spec.fields) {
    if (f === "resolution") continue;   // set above, validated against the model's enum
    if (f === "negative_prompt" && typeof parsed.negativePrompt === "string" && extra[f] === undefined) input.negative_prompt = parsed.negativePrompt;
    else if (extra[f] !== undefined) input[f] = extra[f];
  }
  if (spec.fields.includes("seed") && typeof parsed.seed === "number") input.seed = parsed.seed;

  const log = await startLog({
    provider: "higgsfield",
    toolName: `video_provider.higgsfield.${requested}`,
    audit: { avt_user_id: parsed.avt_user_id ?? null, avt_project_id: parsed.avt_project_id ?? null, avt_prompt_id: parsed.avt_prompt_id ?? null, avt_shot_id: parsed.avt_shot_id ?? null },
    modelVariant: requested,
    promptText: parsed.promptText,
    referenceImageUrl: refImages[0] ?? null,
    extraArgs: spec.mode === "video_to_video" ? { referenceVideoUrl: parsed.referenceVideoUrl, referenceImageCount: refImages.length, resolution } : undefined,
  });

  // A submit that hangs past the abort window, or a network failure, must come back as a retryable
  // provider error rather than escaping withRetry as an exception (which left the log at "attempted"
  // and the caller with a bare 500 on the first Hailuo submit, 2026-10-01).
  const result = await withRetry(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SUBMIT_TIMEOUT_MS);
    try {
      const resp = await fetch(`${HF_API_BASE}${spec.path}`, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", "Authorization": authValue, "User-Agent": HF_USER_AGENT },
        body: JSON.stringify(input),
      });
      const text = await resp.text();
      let json: Record<string, unknown> = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!resp.ok) {
        const detail = (json.detail !== undefined ? JSON.stringify(json.detail) : text).slice(0, 800);
        return { ok: false, status: resp.status, error: detail };
      }
      return { ok: true, status: resp.status, result: json };
    } catch (e) {
      const aborted = (e as { name?: string })?.name === "AbortError";
      return { ok: false, status: aborted ? 504 : 502, error: aborted ? `submit exceeded ${SUBMIT_TIMEOUT_MS} ms` : `submit failed: ${(e as Error)?.message ?? String(e)}` };
    } finally { clearTimeout(timer); }
  }, 2);

  if (!result.ok || !result.result) {
    await finishLog(log.logId, "failed", { httpStatus: result.status, error: result.error ?? "unknown", startedAt: log.startedAt });
    const isAuth = result.status === 401 || result.status === 403;
    const isValidation = result.status === 400 || result.status === 422;
    const code = isAuth ? "UNAUTHORISED" : isValidation ? "INVALID_INPUT" : "PROVIDER_API_ERROR";
    return jsonError(code, `Higgsfield (${requested}) returned ${result.status}: ${result.error ?? "unknown"}`,
      result.status >= 400 && result.status < 600 ? result.status : 502,
      result.status === 429 || (result.status >= 500 && result.status < 600),
      { providerStatus: result.status, attempts: result.attempts, error_upstream: "higgsfield", error_status: result.status, error_body_excerpt: (result.error ?? "").slice(0, 500) });
  }

  const upstream = result.result as Record<string, unknown>;
  const providerJobId = (upstream.request_id as string) ?? (upstream.id as string) ?? "";
  const status = normaliseStatus((upstream.status as string) ?? "queued");
  const video = upstream.video as Record<string, unknown> | undefined;
  const resultUrl = video && typeof video.url === "string" ? (video.url as string) : null;

  const responseEnvelope = {
    jobId: log.requestId,
    providerJobId,
    status,
    resultUrl,
    costEstimateCents: Math.round(centsPerSecond * duration),
    resolution: resolution ?? null,
    costFinalCents: null,
    provider: "higgsfield",
    modelVariant: requested,
    modelPath: spec.path,
    statusHost: HF_API_BASE,
    providerMetadata: upstream,
  };
  await finishLog(log.logId, "succeeded", { httpStatus: result.status, responseJson: responseEnvelope, startedAt: log.startedAt });
  return jsonOk(responseEnvelope);
});

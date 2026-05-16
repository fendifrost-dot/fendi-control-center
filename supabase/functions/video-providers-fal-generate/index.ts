/**
 * Fal.ai video-generation proxy.
 *
 * Wraps fal-serverless model invocations. `modelVariant` identifies which
 * fal model to run (e.g. `fal-ai/mochi-v1`, `fal-ai/flux/dev/video`,
 * `fal-ai/luma-dream-machine`). Default is Mochi v1.
 *
 * Pricing varies per-model; we use a per-model cents table.
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
const DEFAULT_MODEL = "fal-ai/mochi-v1";
const FAL_CENTS_PER_GENERATION: Record<string, number> = {
  "fal-ai/mochi-v1": 20,
  "fal-ai/flux/dev/video": 15,
  "fal-ai/luma-dream-machine": 40,
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("INVALID_INPUT", "Method must be POST.", 405);

  const auth = checkProxyAuth(req);
  if (!auth.ok) return auth.response;

  const apiKey = Deno.env.get("FAL_API_KEY")?.trim();
  if (!apiKey) {
    return jsonError(
      "PROVIDER_KEY_NOT_CONFIGURED",
      "FAL_API_KEY is not configured in Control Center.",
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
  const costEstimateCents = FAL_CENTS_PER_GENERATION[modelVariant] ?? 20;

  const log = await startLog({
    provider: "fal",
    toolName: "video_provider.fal.generate",
    audit: {
      avt_user_id: parsed.avt_user_id ?? null,
      avt_project_id: parsed.avt_project_id ?? null,
      avt_prompt_id: parsed.avt_prompt_id ?? null,
      avt_shot_id: parsed.avt_shot_id ?? null,
    },
    modelVariant,
    promptText: parsed.promptText,
    referenceImageUrl: parsed.referenceImageUrl,
    extraArgs: { costEstimateCents, settings: parsed.settings ?? null },
  });

  const falBody: Record<string, unknown> = {
    prompt: parsed.promptText,
    ...(parsed.referenceImageUrl ? { image_url: parsed.referenceImageUrl } : {}),
    ...(parsed.settings ?? {}),
  };
  if (typeof parsed.seed === "number") falBody.seed = parsed.seed;

  const url = `${FAL_BASE_URL}/${modelVariant}`;

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
        return { ok: false, status: resp.status, error: (json.detail as string) ?? (json.error as string) ?? text.slice(0, 500) };
      }
      return { ok: true, status: resp.status, result: json };
    } finally { clearTimeout(timer); }
  });

  if (!result.ok || !result.result) {
    await finishLog(log.logId, "failed", { httpStatus: result.status, error: result.error ?? "unknown", startedAt: log.startedAt });
    const isAuth = result.status === 401 || result.status === 403;
    return jsonError(
      isAuth ? "UNAUTHORISED" : "PROVIDER_API_ERROR",
      `Fal returned ${result.status}: ${result.error ?? "unknown"}`,
      result.status >= 400 && result.status < 600 ? result.status : 502,
      result.status === 429 || (result.status >= 500 && result.status < 600),
      { providerStatus: result.status, attempts: result.attempts },
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
    provider: "fal",
    modelVariant,
    providerMetadata: upstream,
  };

  await finishLog(log.logId, "succeeded", { httpStatus: result.status, responseJson: responseEnvelope, startedAt: log.startedAt });
  return jsonOk(responseEnvelope);
});

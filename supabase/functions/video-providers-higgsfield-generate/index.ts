/**
 * Higgsfield video-generation proxy.
 *
 * Higgsfield's API is publicly available (https://platform.higgsfield.ai).
 * Auth uses an API-key-ID + secret pair combined into one header value:
 *   Authorization: Key <KEY_ID>:<KEY_SECRET>
 * (same colon-joined convention as fal.ai).
 *
 * If the upstream endpoint is unreachable (404/405/501/0) we surface
 * PROVIDER_NOT_AVAILABLE so AVT renders a graceful "manual workflow only"
 * banner instead of a stack trace.
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
const DEFAULT_MODEL = "higgsfield-v1";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("INVALID_INPUT", "Method must be POST.", 405);

  const auth = checkProxyAuth(req);
  if (!auth.ok) return auth.response;

  // Higgsfield uses an API-key-ID + secret pair (UUID + hex). The official SDKs
  // submit them as a single colon-joined Authorization header value:
  //   Authorization: Key <KEY_ID>:<KEY_SECRET>
  // (same convention as fal.ai). Either both env vars must be set, or both
  // missing — surface PROVIDER_KEY_NOT_CONFIGURED otherwise.
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

  const modelVariant = parsed.modelVariant ?? DEFAULT_MODEL;

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
      const resp = await fetch(`${HF_BASE_URL}/generate`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: authValue,
        },
        body: JSON.stringify({
          model: modelVariant,
          prompt: parsed.promptText,
          ...(parsed.referenceImageUrl ? { image_url: parsed.referenceImageUrl } : {}),
        }),
      });
      const text = await resp.text();
      let json: Record<string, unknown> = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!resp.ok) {
        return { ok: false, status: resp.status, error: (json.error as string) ?? text.slice(0, 500) };
      }
      return { ok: true, status: resp.status, result: json };
    } finally { clearTimeout(timer); }
  }, 1);

  if (!result.ok || !result.result) {
    const notAvail = result.status === 404 || result.status === 405 || result.status === 501 || result.status === 0;
    await finishLog(log.logId, "failed", {
      httpStatus: result.status,
      error: notAvail ? "endpoint not available" : (result.error ?? "unknown"),
      startedAt: log.startedAt,
    });
    if (notAvail) {
      return jsonError(
        "PROVIDER_NOT_AVAILABLE",
        "Higgsfield API is not yet publicly available. Use the manual Copy Prompt workflow inside Higgsfield's UI for now.",
        501,
        false,
      );
    }
    const isAuth = result.status === 401 || result.status === 403;
    return jsonError(
      isAuth ? "UNAUTHORISED" : "PROVIDER_API_ERROR",
      `Higgsfield returned ${result.status}: ${result.error ?? "unknown"}`,
      result.status >= 400 && result.status < 600 ? result.status : 502,
      false,
      { providerStatus: result.status, attempts: result.attempts },
    );
  }

  const upstream = result.result as Record<string, unknown>;
  const providerJobId = (upstream.id as string) ?? "";
  const status = normaliseStatus((upstream.status as string) ?? "queued");

  const responseEnvelope = {
    jobId: log.requestId,
    providerJobId,
    status,
    resultUrl: null,
    costEstimateCents: null,
    costFinalCents: null,
    provider: "higgsfield",
    modelVariant,
    providerMetadata: upstream,
  };

  await finishLog(log.logId, "succeeded", { httpStatus: result.status, responseJson: responseEnvelope, startedAt: log.startedAt });
  return jsonOk(responseEnvelope);
});

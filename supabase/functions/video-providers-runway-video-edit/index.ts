/**
 * Runway video-EDIT proxy — POST /v1/video_to_video.
 *
 * Additive sibling of `video-providers-runway-generate`, which stays untouched: that
 * function owns text_to_video / image_to_video and its shared request shape
 * (`validateCommonBody`) has no room for a source video, timed keyframes or reference
 * lists. Forcing video editing through it would change locked production behaviour, so
 * this is a separate route with its own contract.
 *
 * The trust boundary this preserves: RUNWAY_API_KEY lives HERE and nowhere else. AVT
 * prepares the request (ownership, Look resolution, signed reference/keyframe URLs, spend
 * authorization) and Control Center executes it, audits it and owns the break-glass.
 *
 * Polling and result retrieval are NOT reimplemented — `video-providers-job-status` and
 * `video-providers-job-result` already handle `provider=runway` through GET /v1/tasks/{id},
 * and video_to_video tasks use that same task endpoint.
 *
 * Secrets: RUNWAY_API_KEY, AVT_PROXY_KEY (both already configured).
 * Break-glass: set RUNWAY_VIDEO_EDIT_DISABLED=true to stop this lane without touching the
 * generate lane; deleting the function remains the second, harder stop.
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
  normaliseStatus,
} from "../_shared/video-providers/proxy.ts";
import {
  RUNWAY_VIDEO_EDIT_MODELS,
  buildRunwayRequest,
  checkCostAuthorization,
  estimateCostCents,
  validateVideoEditBody,
} from "./contract.ts";

const RUNWAY_BASE_URL = "https://api.dev.runwayml.com/v1";
const RUNWAY_API_VERSION = "2024-11-06";
const RUNWAY_ENDPOINT = `${RUNWAY_BASE_URL}/video_to_video`;
const UPSTREAM_TIMEOUT_MS = 30_000;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("INVALID_INPUT", "Method must be POST.", 405);

  const auth = checkProxyAuth(req);
  if (!auth.ok) return auth.response;

  // Break-glass, before anything reaches Runway.
  if (Deno.env.get("RUNWAY_VIDEO_EDIT_DISABLED")?.trim().toLowerCase() === "true") {
    return jsonError(
      "PROVIDER_NOT_AVAILABLE",
      "Runway video editing is disabled in Control Center (RUNWAY_VIDEO_EDIT_DISABLED).",
      503,
      false,
    );
  }

  const apiKey = Deno.env.get("RUNWAY_API_KEY")?.trim();
  if (!apiKey) {
    return jsonError(
      "PROVIDER_KEY_NOT_CONFIGURED",
      "RUNWAY_API_KEY is not configured in Control Center.",
      503,
      false,
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError("INVALID_INPUT", "Request body is not valid JSON.", 400);
  }

  const parsed = validateVideoEditBody(raw);
  if ("error" in parsed) return jsonError("INVALID_INPUT", parsed.error, 400);

  const model = RUNWAY_VIDEO_EDIT_MODELS[parsed.model];
  const runwayRequestBody = buildRunwayRequest(parsed);

  // ---- dry run: resolve everything, contact nothing, bill nothing --------
  // No tool_execution_logs row is written for a dry run: that table records calls that
  // reached a provider, and a dry run never does.
  if (parsed.dryRun) {
    return jsonOk({
      dryRun: true,
      billed: false,
      provider: "runway",
      modelVariant: parsed.model,
      endpoint: RUNWAY_ENDPOINT,
      contract: model.contract,
      runwayRequestBody,
      keyframeCount: parsed.keyframes.length,
      referenceCount: parsed.references.length,
      inputSeconds: parsed.inputSeconds,
      avtAuthorizedMaxCents: parsed.avtAuthorizedMaxCents,
      ccProviderEstimateCents:
        parsed.inputSeconds === null ? null : estimateCostCents(model, parsed.inputSeconds),
      modelLimits: {
        maxReferences: model.maxReferences,
        maxKeyframes: model.maxKeyframes,
        maxInputSeconds: model.maxInputSeconds,
        maxPromptChars: model.maxPromptChars,
      },
      capabilitySource: model.source,
    });
  }

  // ---- spend gate: Control Center's own estimate against AVT's authorization ----
  const gate = checkCostAuthorization({
    model,
    inputSeconds: parsed.inputSeconds,
    avtAuthorizedMaxCents: parsed.avtAuthorizedMaxCents,
  });
  if (!gate.ok) {
    return jsonError("COST_LIMIT_EXCEEDED", gate.reason, 400, false, {
      avtAuthorizedMaxCents: gate.avtAuthorizedMaxCents,
      ccProviderEstimateCents: gate.ccProviderEstimateCents,
      provider: "runway",
      modelVariant: parsed.model,
    });
  }

  const log = await startLog({
    provider: "runway",
    toolName: "video_provider.runway.video_edit",
    audit: {
      avt_user_id: parsed.avt_user_id ?? null,
      avt_project_id: parsed.avt_project_id ?? null,
      avt_prompt_id: parsed.avt_prompt_id ?? null,
      avt_shot_id: parsed.avt_shot_id ?? null,
    },
    modelVariant: parsed.model,
    promptText: parsed.promptText,
    referenceImageUrl: parsed.keyframes[0]?.uri ?? parsed.references[0]?.uri ?? null,
    extraArgs: {
      contract: model.contract,
      endpoint: RUNWAY_ENDPOINT,
      keyframeCount: parsed.keyframes.length,
      referenceCount: parsed.references.length,
      inputSeconds: parsed.inputSeconds,
      // Both cost numbers, each attributed — never one ambiguous "costEstimate".
      avtAuthorizedMaxCents: gate.avtAuthorizedMaxCents,
      ccProviderEstimateCents: gate.ccProviderEstimateCents,
    },
  });

  const result = await withRetry(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const resp = await fetch(RUNWAY_ENDPOINT, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "X-Runway-Version": RUNWAY_API_VERSION,
        },
        body: JSON.stringify(runwayRequestBody),
      });
      const text = await resp.text();
      let payload: Record<string, unknown> = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      if (!resp.ok) {
        // Same error surfacing as the generate function: the field-level problem is often
        // only in the raw body, so pass it through rather than summarising it away.
        const summary = typeof payload.error === "string" ? payload.error : "unknown";
        return { ok: false, status: resp.status, error: `${summary} | raw: ${(text || "").slice(0, 800)}` };
      }
      return { ok: true, status: resp.status, result: payload };
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
  const status = normaliseStatus((upstream.status as string) ?? "PENDING");

  const responseEnvelope = {
    jobId: log.requestId,
    providerJobId,
    status,
    resultUrl: null,
    provider: "runway",
    modelVariant: parsed.model,
    // Deliberately NOT a single `costEstimateCents`: each number names its owner.
    avtAuthorizedMaxCents: gate.avtAuthorizedMaxCents,
    ccProviderEstimateCents: gate.ccProviderEstimateCents,
    costFinalCents: null,
    providerMetadata: upstream,
  };

  await finishLog(log.logId, "succeeded", {
    httpStatus: result.status,
    responseJson: responseEnvelope,
    startedAt: log.startedAt,
  });

  return jsonOk(responseEnvelope);
});

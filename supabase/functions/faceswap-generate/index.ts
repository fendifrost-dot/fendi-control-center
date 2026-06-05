// Control Center edge function — faceswap-generate
//
// Pure Fal orchestration for identity face-swap. Takes two already-signed
// image URLs (the artist's face + a target scene image) and runs Fal's
// easel-ai/advanced-face-swap model, preserving the target scene/outfit while
// swapping in the artist's face. Returns the rendered image URL.
//
// Trust boundary: mirrors compose-look — the ONLY shared secret across the
// AVT<->CC boundary is COMPOSE_LOOK_PROXY_SECRET (header: X-Proxy-Secret).
// CC holds no AVT credentials. AVT's faceswap-proxy signs the input URLs,
// calls this function, then downloads + persists the result as the user.
//
// Env (CC secrets):
//   - COMPOSE_LOOK_PROXY_SECRET   (shared with AVT; same value compose-look uses)
//   - FAL_API_KEY                 (already configured for video-providers-fal-generate)
//
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-proxy-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FAL_QUEUE_URL = "https://queue.fal.run";
const MODEL = "easel-ai/advanced-face-swap"; // $0.05 / generation
const COST_ESTIMATE_CENTS = 5;

// Fal queue poll budget. Advanced face-swap (with 2x upscale) typically
// finishes in 10-40s; we cap well under the edge-function wall.
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 120_000;

type Body = {
  faceImageUrl?: string;
  targetImageUrl?: string;
  gender?: "male" | "female" | "non-binary";
  workflowType?: "user_hair" | "target_hair";
  upscale?: boolean;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const expectedSecret = Deno.env.get("COMPOSE_LOOK_PROXY_SECRET")?.trim();
  const falKey = Deno.env.get("FAL_API_KEY")?.trim();
  if (!expectedSecret || !falKey) {
    return json(500, {
      ok: false,
      errorCode: "SERVER_MISCONFIGURED",
      errorMessage:
        "COMPOSE_LOOK_PROXY_SECRET or FAL_API_KEY not configured in Control Center secrets.",
    });
  }
  const gotSecret = req.headers.get("x-proxy-secret")?.trim();
  if (!gotSecret || gotSecret !== expectedSecret) {
    return json(401, { ok: false, errorCode: "UNAUTHORISED", errorMessage: "Bad X-Proxy-Secret." });
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, errorCode: "INVALID_JSON", errorMessage: "Body must be JSON." });
  }

  const faceImageUrl = body.faceImageUrl?.trim();
  const targetImageUrl = body.targetImageUrl?.trim();
  if (!faceImageUrl || !targetImageUrl) {
    return json(400, {
      ok: false,
      errorCode: "MISSING_INPUT",
      errorMessage: "faceImageUrl and targetImageUrl are both required.",
    });
  }

  const input = {
    face_image_0: faceImageUrl,
    gender_0: body.gender ?? "male",
    target_image: targetImageUrl,
    // user_hair preserves the artist's own hairline (correct for a bald/shaved
    // continuity profile); target_hair keeps the scene model's hair.
    workflow_type: body.workflowType ?? "user_hair",
    upscale: body.upscale ?? true,
  };

  // ---- submit to Fal queue -------------------------------------------
  let submitJson: any;
  try {
    const submit = await fetch(`${FAL_QUEUE_URL}/${MODEL}`, {
      method: "POST",
      headers: { Authorization: `Key ${falKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    submitJson = await submit.json().catch(() => ({}));
    if (!submit.ok) {
      return json(502, {
        ok: false,
        errorCode: "FAL_SUBMIT_FAILED",
        errorMessage: `Fal submit ${submit.status}: ${JSON.stringify(submitJson).slice(0, 400)}`,
        retryable: submit.status >= 500,
      });
    }
  } catch (err) {
    return json(502, { ok: false, errorCode: "FAL_UNREACHABLE", errorMessage: String(err).slice(0, 300), retryable: true });
  }

  const statusUrl: string | undefined = submitJson.status_url;
  const responseUrl: string | undefined = submitJson.response_url;
  const requestId: string | undefined = submitJson.request_id;
  if (!statusUrl || !responseUrl) {
    return json(502, {
      ok: false,
      errorCode: "FAL_NO_QUEUE_URLS",
      errorMessage: `Fal did not return queue URLs: ${JSON.stringify(submitJson).slice(0, 300)}`,
    });
  }

  // ---- poll until COMPLETED ------------------------------------------
  const started = Date.now();
  let status = "IN_QUEUE";
  while (Date.now() - started < POLL_MAX_MS) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const st = await fetch(statusUrl, { headers: { Authorization: `Key ${falKey}` } });
      const stJson: any = await st.json().catch(() => ({}));
      status = stJson.status ?? status;
      if (status === "COMPLETED") break;
      if (status === "FAILED" || status === "ERROR") {
        return json(502, {
          ok: false,
          errorCode: "FAL_JOB_FAILED",
          errorMessage: `Fal job ${requestId ?? ""} failed: ${JSON.stringify(stJson).slice(0, 300)}`,
        });
      }
    } catch {
      // transient — keep polling within the budget
    }
  }
  if (status !== "COMPLETED") {
    return json(504, {
      ok: false,
      errorCode: "FAL_TIMEOUT",
      errorMessage: `Fal job ${requestId ?? ""} did not complete within ${POLL_MAX_MS / 1000}s.`,
      retryable: true,
      providerJobId: requestId,
    });
  }

  // ---- fetch result ---------------------------------------------------
  let resultJson: any;
  try {
    const res = await fetch(responseUrl, { headers: { Authorization: `Key ${falKey}` } });
    resultJson = await res.json().catch(() => ({}));
    if (!res.ok) {
      return json(502, {
        ok: false,
        errorCode: "FAL_RESULT_FAILED",
        errorMessage: `Fal result ${res.status}: ${JSON.stringify(resultJson).slice(0, 300)}`,
      });
    }
  } catch (err) {
    return json(502, { ok: false, errorCode: "FAL_RESULT_UNREACHABLE", errorMessage: String(err).slice(0, 300) });
  }

  const imageUrl: string | undefined = resultJson?.image?.url;
  if (!imageUrl) {
    return json(502, {
      ok: false,
      errorCode: "FAL_NO_IMAGE",
      errorMessage: `Fal result had no image url: ${JSON.stringify(resultJson).slice(0, 300)}`,
    });
  }

  return json(200, {
    ok: true,
    imageUrl,
    provider: "fal",
    model: MODEL,
    providerJobId: requestId ?? null,
    costEstimateCents: COST_ESTIMATE_CENTS,
    width: resultJson?.image?.width ?? null,
    height: resultJson?.image?.height ?? null,
    contentType: resultJson?.image?.content_type ?? "image/png",
  });
});

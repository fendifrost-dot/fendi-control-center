// Control Center edge function — faceswap-generate (async submit-only).
//
// AVT's faceswap-proxy is now submit-only. This function:
//   1. Validates X-Proxy-Secret (COMPOSE_LOOK_PROXY_SECRET).
//   2. Mints a signed token `t` that encodes AVT's callback URL + secret.
//   3. SAM-3 segments the head/neck region on the target canvas (sync poll).
//   4. Submits an identity-conditioned inpaint job (flux-kontext-lora/inpaint)
//      with the SAM-3 mask + artist reference photo to the Fal QUEUE with
//      ?fal_webhook=<our faceswap-generate-callback URL>?t=<token>.
//   5. Returns { ok: true, providerJobId } once Fal accepts the job.
//
// Pattern A from the PuLID-Flux upgrade handoff: preserve outfit/composition
// via masked regional inpaint while conditioning on the identity reference.
// fal-ai/flux-pulid has no mask/inpaint API on Fal, so we use
// fal-ai/flux-kontext-lora/inpaint which accepts image_url + mask_url +
// reference_image_url — the same wire-up the handoff describes.
//
// When Fal finishes, it POSTs to faceswap-generate-callback, which verifies
// `t` and relays the result to AVT's faceswap-callback.
//
// Env (CC secrets):
//   - COMPOSE_LOOK_PROXY_SECRET   (shared with AVT — also used as HMAC key)
//   - FAL_API_KEY                 (already configured)
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
// Identity-conditioned inpaint (mask + reference_image_url). Replaces fal-ai/face-swap.
const MODEL = "fal-ai/flux-kontext-lora/inpaint";
const COST_ESTIMATE_CENTS = 7; // SAM-3 ~2¢ + kontext inpaint ~5¢

const FAL_SUBMIT_TIMEOUT_MS = 10_000;
const SAM3_POLL_TIMEOUT_MS = 90_000;

const TOKEN_TTL_SEC = 30 * 60;

const CC_FUNCTIONS_BASE = "https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1";
const AVT_CALLBACK_HOST = "qoyxgnkvjukovkrvdaiq.supabase.co";

const IDENTITY_MASK_PROMPT = "the person's head, face, hair, beard, ears, and neck";

const IDENTITY_INPAINT_PROMPT =
  "In the masked region only, render this person's exact head and face: professional portrait, " +
  "photorealistic, natural skin texture with visible pores, sharp focus, natural eye catchlights " +
  "and specular highlights, 35mm camera. Keep the original photo's head pose, angle, lighting " +
  "direction, and shadow falloff so the head sits naturally on the body. Do not alter clothing, " +
  "hands, body, or background outside the mask. No plastic or airbrushed skin.";

type SubmitBody = {
  mode?: string;
  callbackUrl?: string;
  callbackSecret?: string;
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

function b64urlEncodeStr(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlEncodeBuf(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function mintToken(
  hmacKey: string,
  cb: string,
  cs: string,
  ti: string,
): Promise<string> {
  const payload = JSON.stringify({
    cb,
    cs,
    ti,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC,
  });
  const payloadB64 = b64urlEncodeStr(payload);
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(hmacKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(payloadB64));
  return `${payloadB64}.${b64urlEncodeBuf(sig)}`;
}

async function pollFalUntilDone(
  apiKey: string,
  statusUrl: string,
  responseUrl: string,
  timeoutMs: number = SAM3_POLL_TIMEOUT_MS,
): Promise<any> {
  const start = Date.now();
  const POLL_INTERVAL_MS = 1500;
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusResp = await fetch(statusUrl, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!statusResp.ok) continue;
    const status = await statusResp.json();
    if (status?.status === "COMPLETED") {
      const respResp = await fetch(responseUrl, {
        headers: { Authorization: `Key ${apiKey}` },
      });
      if (!respResp.ok) {
        throw new Error(`fal_response_${respResp.status}: ${await respResp.text().catch(() => "")}`);
      }
      return await respResp.json();
    }
    if (status?.status === "FAILED" || status?.status === "ERROR") {
      throw new Error(`fal_failed: ${status?.error ?? "unknown"}`);
    }
  }
  throw new Error("fal_poll_timeout");
}

async function callFalSam3Segment(
  apiKey: string,
  input: { imageUrl: string; prompt: string },
): Promise<{ request_id: string; mask_url: string | null }> {
  const submitResp = await fetch(`${FAL_QUEUE_URL}/fal-ai/sam-3/image`, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      image_url: input.imageUrl,
      prompt: input.prompt,
      apply_mask: false,
      output_format: "png",
      max_masks: 1,
    }),
  });
  if (!submitResp.ok) {
    throw new Error(`sam3_submit_${submitResp.status}: ${await submitResp.text().catch(() => "")}`);
  }
  const { request_id, status_url, response_url } = await submitResp.json();
  const result = await pollFalUntilDone(apiKey, status_url, response_url);
  const maskUrl = result?.masks?.[0]?.url ?? result?.image?.url ?? null;
  return { request_id, mask_url: maskUrl };
}

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

  let body: SubmitBody;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, errorCode: "INVALID_JSON", errorMessage: "Body must be JSON." });
  }

  if (body.mode !== "submit") {
    return json(400, {
      ok: false,
      errorCode: "UNSUPPORTED_MODE",
      errorMessage: `mode must be "submit" (got ${JSON.stringify(body.mode)}).`,
    });
  }

  const callbackUrl = body.callbackUrl?.trim();
  const callbackSecret = body.callbackSecret?.trim();
  const faceImageUrl = body.faceImageUrl?.trim();
  const targetImageUrl = body.targetImageUrl?.trim();

  if (!callbackUrl || !callbackSecret || !faceImageUrl || !targetImageUrl) {
    return json(400, {
      ok: false,
      errorCode: "MISSING_INPUT",
      errorMessage:
        "callbackUrl, callbackSecret, faceImageUrl and targetImageUrl are all required.",
    });
  }

  let parsedCb: URL;
  try {
    parsedCb = new URL(callbackUrl);
  } catch {
    return json(400, { ok: false, errorCode: "BAD_CALLBACK_URL", errorMessage: "callbackUrl is not a valid URL." });
  }
  if (parsedCb.protocol !== "https:" || parsedCb.host !== AVT_CALLBACK_HOST) {
    return json(400, {
      ok: false,
      errorCode: "BAD_CALLBACK_URL",
      errorMessage: `callbackUrl host must be ${AVT_CALLBACK_HOST} over https.`,
    });
  }

  // ---- SAM-3 head/neck mask (sync — reuses compose-look identity_inpaint prompt) ----
  let maskUrl: string;
  try {
    const seg = await callFalSam3Segment(falKey, {
      imageUrl: targetImageUrl,
      prompt: IDENTITY_MASK_PROMPT,
    });
    if (!seg.mask_url) {
      return json(400, {
        ok: false,
        errorCode: "MASK_NOT_FOUND",
        errorMessage: "SAM-3 could not isolate a head/neck region in the target image.",
        retryable: false,
      });
    }
    maskUrl = seg.mask_url;
    console.log(`[faceswap-generate] sam3 mask ready request_id=${seg.request_id}`);
  } catch (err) {
    return json(502, {
      ok: false,
      errorCode: "SAM3_FAILED",
      errorMessage: String(err).slice(0, 300),
      retryable: true,
    });
  }

  const token = await mintToken(expectedSecret, callbackUrl, callbackSecret, targetImageUrl);
  const ccWebhook =
    `${CC_FUNCTIONS_BASE}/faceswap-generate-callback?t=${encodeURIComponent(token)}`;

  // fal-ai/flux-kontext-lora/inpaint — identity-conditioned regional fill.
  // gender / workflowType / upscale from SubmitBody are legacy face-swap fields;
  // AVT contract unchanged, fields ignored.
  const input = {
    image_url: targetImageUrl,
    mask_url: maskUrl,
    reference_image_url: faceImageUrl,
    prompt: IDENTITY_INPAINT_PROMPT,
    num_inference_steps: 28,
    guidance_scale: 2.5,
    strength: 0.85,
    output_format: "png",
    enable_safety_checker: false,
  };

  const falUrl = `${FAL_QUEUE_URL}/${MODEL}?fal_webhook=${encodeURIComponent(ccWebhook)}`;
  let submitJson: any;
  let submitStatus = 0;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FAL_SUBMIT_TIMEOUT_MS);
  try {
    const submit = await fetch(falUrl, {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Key ${falKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    submitStatus = submit.status;
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
    return json(502, {
      ok: false,
      errorCode: "FAL_UNREACHABLE",
      errorMessage: String(err).slice(0, 300),
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  const requestId: string | undefined = submitJson?.request_id;
  if (!requestId) {
    return json(502, {
      ok: false,
      errorCode: "FAL_NO_REQUEST_ID",
      errorMessage: `Fal submit ${submitStatus} returned no request_id: ${JSON.stringify(submitJson).slice(0, 300)}`,
    });
  }

  console.log(
    `[faceswap-generate] submitted model=${MODEL} request_id=${requestId} webhook->faceswap-generate-callback cb=${callbackUrl}`,
  );

  return json(200, {
    ok: true,
    providerJobId: requestId,
    provider: "fal",
    model: MODEL,
    costEstimateCents: COST_ESTIMATE_CENTS,
  });
});

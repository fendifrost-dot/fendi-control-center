// Control Center edge function — faceswap-generate (async submit-only).
//
// AVT's faceswap-proxy is now submit-only. This function:
//   1. Validates X-Proxy-Secret (COMPOSE_LOOK_PROXY_SECRET).
//   2. Mints a signed token `t` that encodes AVT's callback URL + secret.
//   3. Submits the Fal advanced-face-swap job to the Fal QUEUE with
//      ?fal_webhook=<our faceswap-generate-callback URL>?t=<token>.
//   4. Returns { ok: true, providerJobId } in under 5s.
//
// When Fal finishes, it POSTs to faceswap-generate-callback, which verifies
// `t` and relays the result to AVT's faceswap-callback. No polling here —
// the old 150s edge wall is no longer the bottleneck.
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
const MODEL = "fal-ai/face-swap"; // supported replacement for deprecated easel-ai/advanced-face-swap
const COST_ESTIMATE_CENTS = 5;

// Hard wall on the outbound submit fetch. Fal queue submit returns in <1s
// normally; 10s is plenty.
const FAL_SUBMIT_TIMEOUT_MS = 10_000;

// Token lifetime — Fal jobs can sit in queue for a while. 30 min is safe.
const TOKEN_TTL_SEC = 30 * 60;

// CC base URL — used to build the fal_webhook target. This project's ref.
const CC_FUNCTIONS_BASE = "https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1";

// Allow-list for AVT callback host to keep this function from being abused
// as an arbitrary HTTP submitter.
const AVT_CALLBACK_HOST = "qoyxgnkvjukovkrvdaiq.supabase.co";

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

  // Defence-in-depth: only relay results back to AVT.
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

  // ---- build the Fal webhook (CC-internal callback receiver) ---------
  const token = await mintToken(expectedSecret, callbackUrl, callbackSecret, targetImageUrl);
  const ccWebhook =
    `${CC_FUNCTIONS_BASE}/faceswap-generate-callback?t=${encodeURIComponent(token)}`;

  // fal-ai/face-swap schema:
  //   base_image_url = the scene to paste a face onto (our targetImageUrl)
  //   swap_image_url = the face to lift from (our faceImageUrl)
  // gender / workflowType / upscale from SubmitBody are not part of this
  // model's schema and are intentionally ignored. AVT contract unchanged.
  const input = {
    base_image_url: targetImageUrl,
    swap_image_url: faceImageUrl,
  };

  // ---- submit to Fal queue with webhook ------------------------------
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
    `[faceswap-generate] submitted request_id=${requestId} webhook->faceswap-generate-callback cb=${callbackUrl}`,
  );

  return json(200, {
    ok: true,
    providerJobId: requestId,
    provider: "fal",
    model: MODEL,
    costEstimateCents: COST_ESTIMATE_CENTS,
  });
});

// Control Center edge function — faceswap-generate-callback
//
// Receives Fal's webhook POST after an identity-conditioned inpaint job finishes
// (registered by faceswap-generate via ?fal_webhook=). Verifies the signed
// `t` token in the URL (HMAC over the AVT callback URL + secret + exp),
// then relays the result to AVT's faceswap-callback.
//
// Trust model: Fal itself is unauthenticated. The only thing that authorises
// this relay is the HMAC token we minted when we submitted the job. AVT's
// faceswap-callback is idempotent, so if our POST to AVT fails we return
// non-2xx to Fal and let Fal retry the webhook.
//
// Env (CC secrets):
//   - COMPOSE_LOOK_PROXY_SECRET   (HMAC key — same secret used to mint the token)
//
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-proxy-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = "fal-ai/flux-kontext-lora/inpaint";
const COST_ESTIMATE_CENTS = 7;
const AVT_POST_TIMEOUT_MS = 10_000;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlEncode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmacSha256B64Url(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return b64urlEncode(sig);
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

type RelayBody = {
  status: "succeeded" | "failed";
  fal_image_url?: string;
  content_type?: string;
  width?: number;
  height?: number;
  model?: string;
  provider_job_id?: string;
  cost_cents?: number;
  error?: string;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const hmacKey = Deno.env.get("COMPOSE_LOOK_PROXY_SECRET")?.trim();
  if (!hmacKey) {
    return json(500, { ok: false, error: "COMPOSE_LOOK_PROXY_SECRET not configured" });
  }

  // ---- verify the signed `t` token ----------------------------------
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";
  const dot = token.indexOf(".");
  if (dot <= 0) return json(401, { ok: false, error: "missing or malformed token" });

  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacSha256B64Url(hmacKey, payloadB64);
  if (!constantTimeEq(sig, expected)) {
    return json(401, { ok: false, error: "bad token signature" });
  }

  let claims: { cb: string; cs: string; exp: number };
  try {
    const bytes = b64urlDecode(payloadB64);
    claims = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json(401, { ok: false, error: "bad token payload" });
  }
  if (
    typeof claims.cb !== "string" ||
    typeof claims.cs !== "string" ||
    typeof claims.exp !== "number"
  ) {
    return json(401, { ok: false, error: "bad token claims" });
  }
  if (Date.now() / 1000 > claims.exp) {
    return json(401, { ok: false, error: "token expired" });
  }

  // ---- parse Fal webhook body ---------------------------------------
  let fal: any;
  try {
    fal = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid Fal JSON" });
  }

  const requestId: string | undefined = fal?.request_id ?? fal?.gateway_request_id;
  const falStatus: string = (fal?.status ?? "").toString().toUpperCase();
  const imageUrl: string | undefined =
    fal?.payload?.images?.[0]?.url ??
    fal?.payload?.image?.url;

  let relay: RelayBody;
  if (falStatus === "OK" && imageUrl) {
    relay = {
      status: "succeeded",
      fal_image_url: imageUrl,
      content_type:
        fal?.payload?.images?.[0]?.content_type ??
        fal?.payload?.image?.content_type ??
        "image/png",
      width: fal?.payload?.images?.[0]?.width ?? fal?.payload?.image?.width ?? undefined,
      height: fal?.payload?.images?.[0]?.height ?? fal?.payload?.image?.height ?? undefined,
      model: MODEL,
      provider_job_id: requestId,
      cost_cents: COST_ESTIMATE_CENTS,
    };
  } else {
    const errMsg =
      typeof fal?.error === "string" && fal.error
        ? fal.error
        : falStatus !== "OK"
        ? `fal status: ${falStatus || "unknown"}`
        : "no image in fal payload";
    relay = {
      status: "failed",
      model: MODEL,
      provider_job_id: requestId,
      error: errMsg.slice(0, 500),
    };
  }

  // ---- POST to AVT's faceswap-callback ------------------------------
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AVT_POST_TIMEOUT_MS);
  try {
    const resp = await fetch(claims.cb, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Secret": claims.cs,
      },
      body: JSON.stringify(relay),
    });
    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      console.error(
        `[faceswap-generate-callback] AVT POST ${resp.status} cb=${claims.cb} body=${text.slice(0, 300)}`,
      );
      // Return 502 so Fal retries the webhook (AVT callback is idempotent).
      return json(502, {
        ok: false,
        error: `avt_callback_${resp.status}`,
        avt_body: text.slice(0, 300),
      });
    }
    console.log(
      `[faceswap-generate-callback] relayed request_id=${requestId} status=${relay.status} -> AVT 200`,
    );
    return json(200, { ok: true });
  } catch (err) {
    console.error(`[faceswap-generate-callback] AVT POST unreachable: ${String(err).slice(0, 300)}`);
    return json(502, { ok: false, error: "avt_unreachable" });
  } finally {
    clearTimeout(timer);
  }
});
// CC — Fal flux-lora-fast-training for personal style LoRA v3
//
// Webhook mode (callback_url present): submit to Fal with `fal_webhook`
// pointing at AVT's train-style-lora-callback (?artist_id=...). Fal will
// POST the result directly to AVT when training finishes — no polling,
// no EdgeRuntime.waitUntil. Returns immediately with `{ status: 'queued',
// request_id, webhook_url }`.
//
// Sync mode (callback_url absent): legacy fallback — submit + poll inline
// and return the lora_url. Kept for ad-hoc/manual invocations.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type Body = {
  images_data_url?: string;
  trigger_word?: string;
  is_style?: boolean;
  create_masks?: boolean;
  steps?: number;
  callback_url?: string;
  artist_id?: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-proxy-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pollFalUntilDone(
  apiKey: string,
  statusUrl: string,
  responseUrl: string,
  timeoutMs = 600_000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
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
        throw new Error(`fal_response_${respResp.status}`);
      }
      return await respResp.json();
    }
    if (status?.status === "FAILED" || status?.status === "ERROR") {
      throw new Error(`fal_failed: ${status?.error ?? "unknown"}`);
    }
  }
  throw new Error("fal_poll_timeout");
}

async function submitTraining(
  falKey: string,
  body: Body,
  webhookUrl?: string,
): Promise<{ request_id: string; status_url: string; response_url: string }> {
  const base = "https://queue.fal.run/fal-ai/flux-lora-fast-training";
  const url = webhookUrl
    ? `${base}?fal_webhook=${encodeURIComponent(webhookUrl)}`
    : base;

  const submitResp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Key ${falKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      images_data_url: body.images_data_url,
      trigger_word: body.trigger_word ?? "FENDIFITS",
      is_style: body.is_style ?? true,
      create_masks: body.create_masks ?? false,
      steps: body.steps ?? 300,
    }),
  });
  if (!submitResp.ok) {
    throw new Error(
      `train_submit_${submitResp.status}: ${await submitResp.text().catch(() => "")}`,
    );
  }
  const { request_id, status_url, response_url } = await submitResp.json();
  if (!request_id) {
    throw new Error("train_submit_missing_request_id");
  }
  return { request_id, status_url, response_url };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const falKey = Deno.env.get("FAL_API_KEY") ?? "";
  const proxySecret = Deno.env.get("COMPOSE_LOOK_PROXY_SECRET") ?? "";
  if (!falKey || !proxySecret) return json(500, { error: "server_misconfigured" });

  const headerSecret = req.headers.get("x-proxy-secret") ?? "";
  if (!headerSecret || !constantTimeEqual(headerSecret, proxySecret)) {
    return json(401, { error: "bad_proxy_secret" });
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  if (!body.images_data_url) return json(400, { error: "missing_images_data_url" });

  const callbackUrl = body.callback_url;

  try {
    // Webhook path: submit with fal_webhook, return immediately.
    if (callbackUrl) {
      const { request_id } = await submitTraining(falKey, body, callbackUrl);
      return json(200, {
        status: "queued",
        request_id,
        webhook_url: callbackUrl,
      });
    }

    // Sync fallback: submit, poll inline, return lora_url.
    const { request_id, status_url, response_url } = await submitTraining(falKey, body);
    if (!status_url || !response_url) {
      throw new Error("train_submit_missing_queue_urls");
    }
    const result = await pollFalUntilDone(falKey, status_url, response_url);
    const loraFile = result?.diffusers_lora_file as { url?: string } | undefined;
    const loraUrl = loraFile?.url;
    if (!loraUrl) throw new Error("training_no_lora_url");
    return json(200, {
      status: "complete",
      lora_url: loraUrl,
      request_id,
    });
  } catch (err: unknown) {
    const msg = String((err as Error)?.message ?? err).slice(0, 500);
    return json(500, { status: "failed", error: msg });
  }
});

// CC — poll a Fal queue job using the server-side FAL_API_KEY.
// Auth: X-Proxy-Secret. Body: { status_url, response_url }.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type Body = {
  status_url?: string;
  response_url?: string;
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

  const statusUrl = body.status_url ?? "";
  const responseUrl = body.response_url ?? "";
  if (!statusUrl || !responseUrl) {
    return json(400, { error: "missing_status_or_response_url" });
  }

  try {
    const statusResp = await fetch(statusUrl, {
      headers: { Authorization: `Key ${falKey}` },
    });
    if (!statusResp.ok) {
      return json(502, {
        error: "fal_status_failed",
        detail: `status_${statusResp.status}`,
      });
    }
    const statusJson = await statusResp.json();
    const status = statusJson?.status ?? "UNKNOWN";

    if (status !== "COMPLETED") {
      return json(200, { status, raw: statusJson });
    }

    const respResp = await fetch(responseUrl, {
      headers: { Authorization: `Key ${falKey}` },
    });
    if (!respResp.ok) {
      return json(502, {
        error: "fal_response_failed",
        detail: `response_${respResp.status}`,
      });
    }
    const result = await respResp.json();
    const loraFile = result?.diffusers_lora_file as { url?: string } | undefined;
    return json(200, {
      status: "COMPLETED",
      lora_url: loraFile?.url ?? null,
      result,
    });
  } catch (err: unknown) {
    const msg = String((err as Error)?.message ?? err).slice(0, 500);
    return json(500, { error: "poll_failed", detail: msg });
  }
});

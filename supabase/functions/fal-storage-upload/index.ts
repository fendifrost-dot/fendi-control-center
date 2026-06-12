// CC — upload a training ZIP to Fal CDN using the server-side FAL_API_KEY.
// Auth: X-Proxy-Secret (COMPOSE_LOOK_PROXY_SECRET). Body: raw application/zip bytes.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

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

  const fileName = req.headers.get("x-file-name") ?? "training.zip";
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength === 0) return json(400, { error: "empty_body" });

  try {
    const initResp = await fetch(
      "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
      {
        method: "POST",
        headers: {
          Authorization: `Key ${falKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          file_name: fileName,
          content_type: "application/zip",
        }),
      },
    );
    if (!initResp.ok) {
      const text = await initResp.text().catch(() => "");
      return json(502, {
        error: "fal_initiate_failed",
        detail: text.slice(0, 300),
      });
    }
    const { upload_url, file_url } = await initResp.json();
    if (!upload_url || !file_url) {
      return json(502, { error: "fal_initiate_missing_urls" });
    }

    const putResp = await fetch(upload_url, {
      method: "PUT",
      headers: { "Content-Type": "application/zip" },
      body: bytes,
    });
    if (!putResp.ok) {
      const text = await putResp.text().catch(() => "");
      return json(502, {
        error: "fal_upload_failed",
        detail: text.slice(0, 300),
      });
    }

    return json(200, {
      file_url,
      size_bytes: bytes.byteLength,
      file_name: fileName,
    });
  } catch (err: unknown) {
    const msg = String((err as Error)?.message ?? err).slice(0, 500);
    return json(500, { error: "upload_failed", detail: msg });
  }
});

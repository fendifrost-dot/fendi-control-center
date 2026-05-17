/**
 * Cross-provider job result download.
 *
 * Same query params as status (?provider=&id=). Returns either the
 * provider-hosted URL (default) or the bytes inline (?inline=1).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import {
  corsHeaders,
  checkProxyAuth,
  jsonError,
  jsonOk,
  ProviderName,
} from "../_shared/video-providers/proxy.ts";

const PROVIDER_KEY_BY_NAME: Record<ProviderName, string> = {
  runway: "RUNWAY_API_KEY",
  veo: "Frost_Gemini",
  pika: "FAL_API_KEY", // Pika is Fal-routed.
  fal: "FAL_API_KEY",
  grok: "Frost_Grok",
  higgsfield: "HIGGSFIELD_API_KEY_ID",
};

const RUNWAY_BASE_URL = "https://api.dev.runwayml.com/v1";
const RUNWAY_API_VERSION = "2024-11-06";
const VEO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const FAL_BASE_URL = "https://queue.fal.run";
const XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_PIKA_FAL_MODEL = "fal-ai/pika/v2.2/text-to-video";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "GET") return jsonError("INVALID_INPUT", "Method must be GET.", 405);

  const auth = checkProxyAuth(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const provider = url.searchParams.get("provider") as ProviderName | null;
  const id = url.searchParams.get("id");
  const inline = url.searchParams.get("inline") === "1";
  if (!provider || !id) {
    return jsonError("INVALID_INPUT", "Query params `provider` and `id` are required.", 400);
  }
  if (!PROVIDER_KEY_BY_NAME[provider]) {
    return jsonError("INVALID_INPUT", `Unknown provider: ${provider}`, 400);
  }
  const apiKey = Deno.env.get(PROVIDER_KEY_BY_NAME[provider])?.trim();
  if (!apiKey) {
    return jsonError("PROVIDER_KEY_NOT_CONFIGURED", `${PROVIDER_KEY_BY_NAME[provider]} not set`, 503);
  }

  try {
    let resultUrl: string | null = null;
    let upstream: Record<string, unknown> = {};

    if (provider === "runway") {
      const resp = await fetch(`${RUNWAY_BASE_URL}/tasks/${encodeURIComponent(id)}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Runway-Version": RUNWAY_API_VERSION,
        },
      });
      const text = await resp.text();
      try { upstream = text ? JSON.parse(text) : {}; } catch { upstream = { raw: text }; }
      const output = upstream.output as unknown;
      if (Array.isArray(output) && typeof output[0] === "string") resultUrl = output[0];
    } else if (provider === "veo") {
      const opUrl = `${VEO_BASE_URL}/${id}?key=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(opUrl);
      const text = await resp.text();
      try { upstream = text ? JSON.parse(text) : {}; } catch { upstream = { raw: text }; }
      const responseField = upstream.response as Record<string, unknown> | undefined;
      const predictions = responseField?.predictions as unknown;
      if (Array.isArray(predictions) && predictions.length > 0) {
        const p = predictions[0] as Record<string, unknown>;
        resultUrl = (p.videoUri as string) ?? (p.uri as string) ?? null;
      }
    } else if (provider === "pika" || provider === "fal") {
      const defaultPath = provider === "pika" ? DEFAULT_PIKA_FAL_MODEL : "fal-ai/mochi-v1";
      const modelPath = url.searchParams.get("modelPath") ?? defaultPath;
      const resp = await fetch(`${FAL_BASE_URL}/${modelPath}/requests/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Key ${apiKey}` },
      });
      const text = await resp.text();
      try { upstream = text ? JSON.parse(text) : {}; } catch { upstream = { raw: text }; }
      const video = upstream.video as Record<string, unknown> | undefined;
      resultUrl = (video?.url as string) ?? (upstream.video_url as string) ?? null;
    } else if (provider === "grok") {
      const resp = await fetch(`${XAI_BASE_URL}/videos/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const text = await resp.text();
      try { upstream = text ? JSON.parse(text) : {}; } catch { upstream = { raw: text }; }
      const video = upstream.video as Record<string, unknown> | undefined;
      resultUrl = (video?.url as string) ?? null;
    } else {
      return jsonError(
        "PROVIDER_NOT_AVAILABLE",
        `${provider} result fetching is not yet available — the upstream API is gated.`,
        501,
      );
    }

    if (!resultUrl) {
      return jsonError("PROVIDER_API_ERROR", "Result not yet available — job may still be running.", 425);
    }

    if (!inline) {
      return jsonOk({ provider, providerJobId: id, resultUrl, providerMetadata: upstream });
    }

    const dl = await fetch(resultUrl);
    if (!dl.ok) {
      return jsonError("PROVIDER_API_ERROR", `Failed to download from resultUrl: ${dl.status}`, 502, true);
    }
    const buf = new Uint8Array(await dl.arrayBuffer());
    const contentType = dl.headers.get("content-type") ?? "video/mp4";
    // encodeBase64 streams through the buffer; the prior spread+btoa overflowed the call stack on video-sized payloads.
    const b64 = encodeBase64(buf);
    return jsonOk({
      provider,
      providerJobId: id,
      contentType,
      bytes_base64: b64,
      sizeBytes: buf.byteLength,
    });
  } catch (err) {
    return jsonError("INTERNAL", String(err), 500, true);
  }
});

/**
 * Cross-provider job result download.
 *
 * Same query params as status (?provider=&id=), but instead of returning
 * the upstream JSON, this endpoint downloads the resulting video bytes,
 * uploads them to AVT's `project-clips` Storage bucket on AVT's Supabase
 * project, and returns the AVT storage path + final cost.
 *
 * NOTE: Since AVT and CC live in different Supabase projects, the upload
 * happens by AVT calling its own upload-asset edge function with the
 * downloaded bytes — that flow is wired AVT-side. This endpoint here just
 * fetches the resultUrl and returns the bytes + content type so AVT can
 * stream them through.
 *
 * Returns `{ resultUrl }` for the simple case (AVT downloads directly)
 * OR `{ bytes_base64, contentType }` if `?inline=1` is set.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
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
  pika: "PIKA_API_KEY",
  fal: "FAL_API_KEY",
  grok: "Frost_Grok",
  higgsfield: "HIGGSFIELD_API_KEY",
};

const RUNWAY_BASE_URL = "https://api.dev.runwayml.com/v1";
const RUNWAY_API_VERSION = "2024-11-06";
const VEO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const PIKA_BASE_URL = "https://api.pika.art/v1";
const FAL_BASE_URL = "https://queue.fal.run";

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
    } else if (provider === "pika") {
      const resp = await fetch(`${PIKA_BASE_URL}/jobs/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const text = await resp.text();
      try { upstream = text ? JSON.parse(text) : {}; } catch { upstream = { raw: text }; }
      resultUrl = (upstream.video_url as string) ?? (upstream.url as string) ?? null;
    } else if (provider === "fal") {
      const modelPath = url.searchParams.get("modelPath") ?? "fal-ai/mochi-v1";
      const resp = await fetch(`${FAL_BASE_URL}/${modelPath}/requests/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Key ${apiKey}` },
      });
      const text = await resp.text();
      try { upstream = text ? JSON.parse(text) : {}; } catch { upstream = { raw: text }; }
      const video = upstream.video as Record<string, unknown> | undefined;
      resultUrl = (video?.url as string) ?? (upstream.video_url as string) ?? null;
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
      // Return the signed/temporary URL the provider gave us. AVT will fetch
      // the bytes directly and re-upload via its own upload-asset function.
      return jsonOk({ provider, providerJobId: id, resultUrl, providerMetadata: upstream });
    }

    // Inline mode: stream bytes through for environments where AVT can't
    // talk to the provider's signed URL directly (CORS, region, etc.).
    const dl = await fetch(resultUrl);
    if (!dl.ok) {
      return jsonError("PROVIDER_API_ERROR", `Failed to download from resultUrl: ${dl.status}`, 502, true);
    }
    const buf = new Uint8Array(await dl.arrayBuffer());
    const contentType = dl.headers.get("content-type") ?? "video/mp4";
    // Base64 inline; max ~10MB before edge-function payload pain.
    const b64 = btoa(String.fromCharCode(...buf));
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

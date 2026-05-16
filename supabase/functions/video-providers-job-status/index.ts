/**
 * Cross-provider job status polling.
 *
 * AVT polls this with: GET /video-providers-job-status?provider=runway&id=<providerJobId>
 * Returns the normalised envelope with the latest status. When status =
 * succeeded the resultUrl is populated.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  corsHeaders,
  checkProxyAuth,
  jsonError,
  jsonOk,
  normaliseStatus,
  ProviderName,
} from "../_shared/video-providers/proxy.ts";

const PROVIDER_KEY_BY_NAME: Record<ProviderName, string> = {
  runway: "RUNWAY_API_KEY",
  veo: "Frost_Gemini",
  pika: "PIKA_API_KEY",
  fal: "FAL_API_KEY",
  grok: "Frost_Grok",
  higgsfield: "HIGGSFIELD_API_KEY_ID", // ID-only check; full Key+Secret used by generate fn
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
    let upstream: Record<string, unknown> = {};
    let httpStatus = 0;

    if (provider === "runway") {
      const resp = await fetch(`${RUNWAY_BASE_URL}/tasks/${encodeURIComponent(id)}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Runway-Version": RUNWAY_API_VERSION,
        },
      });
      httpStatus = resp.status;
      const text = await resp.text();
      try { upstream = text ? JSON.parse(text) : {}; } catch { upstream = { raw: text }; }
    } else if (provider === "veo") {
      // `id` is the long-running operation name returned by predictLongRunning.
      const opUrl = `${VEO_BASE_URL}/${id}?key=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(opUrl);
      httpStatus = resp.status;
      const text = await resp.text();
      try { upstream = text ? JSON.parse(text) : {}; } catch { upstream = { raw: text }; }
    } else if (provider === "pika") {
      const resp = await fetch(`${PIKA_BASE_URL}/jobs/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      httpStatus = resp.status;
      const text = await resp.text();
      try { upstream = text ? JSON.parse(text) : {}; } catch { upstream = { raw: text }; }
    } else if (provider === "fal") {
      const modelPath = url.searchParams.get("modelPath") ?? "fal-ai/mochi-v1";
      const resp = await fetch(`${FAL_BASE_URL}/${modelPath}/requests/${encodeURIComponent(id)}/status`, {
        headers: { Authorization: `Key ${apiKey}` },
      });
      httpStatus = resp.status;
      const text = await resp.text();
      try { upstream = text ? JSON.parse(text) : {}; } catch { upstream = { raw: text }; }
    } else if (provider === "grok" || provider === "higgsfield") {
      // Polling not available until the API is open. Return PROVIDER_NOT_AVAILABLE.
      return jsonError(
        "PROVIDER_NOT_AVAILABLE",
        `${provider} status polling is not yet available — the upstream API is gated.`,
        501,
        false,
      );
    }

    let status: ReturnType<typeof normaliseStatus> = "queued";
    let resultUrl: string | null = null;

    if (provider === "runway") {
      status = normaliseStatus(upstream.status as string);
      if (status === "succeeded") {
        const output = upstream.output as unknown;
        if (Array.isArray(output) && typeof output[0] === "string") resultUrl = output[0];
      }
    } else if (provider === "veo") {
      const done = Boolean(upstream.done);
      status = done ? "succeeded" : "running";
      if (done) {
        const responseField = upstream.response as Record<string, unknown> | undefined;
        const predictions = responseField?.predictions as unknown;
        if (Array.isArray(predictions) && predictions.length > 0) {
          const p = predictions[0] as Record<string, unknown>;
          resultUrl = (p.videoUri as string) ?? (p.uri as string) ?? null;
        }
      }
    } else if (provider === "pika") {
      status = normaliseStatus(upstream.status as string);
      if (status === "succeeded") {
        resultUrl = (upstream.video_url as string) ?? (upstream.url as string) ?? null;
      }
    } else if (provider === "fal") {
      status = normaliseStatus(upstream.status as string);
      if (status === "succeeded") {
        const out = upstream.response as Record<string, unknown> | undefined;
        const video = (out?.video as Record<string, unknown> | undefined) ?? undefined;
        resultUrl = (video?.url as string) ?? (out?.video_url as string) ?? null;
      }
    }

    return jsonOk({
      provider,
      providerJobId: id,
      status,
      resultUrl,
      providerMetadata: upstream,
      httpStatus,
    });
  } catch (err) {
    return jsonError("INTERNAL", String(err), 500, true);
  }
});

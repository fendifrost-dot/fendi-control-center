/**
 * Cross-provider job status polling.
 *
 * AVT polls this with: GET /video-providers-job-status?provider=runway&id=<providerJobId>
 * Returns the normalised envelope with the latest status. When status =
 * succeeded the resultUrl is populated.
 *
 * Pika is now routed through Fal (see video-providers-pika-generate). The
 * upstream `providerMetadata._falModel` from the original generate call
 * tells us which fal model path to poll. Callers can also pass
 * `?modelPath=fal-ai/pika/v2.2/text-to-video`.
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
  pika: "FAL_API_KEY", // Pika is now Fal-routed.
  fal: "FAL_API_KEY",
  grok: "Frost_Grok",
  higgsfield: "HIGGSFIELD_API_KEY_ID", // ID-only check; full Key+Secret used by generate fn
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
      const opUrl = `${VEO_BASE_URL}/${id}?key=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(opUrl);
      httpStatus = resp.status;
      const text = await resp.text();
      try { upstream = text ? JSON.parse(text) : {}; } catch { upstream = { raw: text }; }
    } else if (provider === "pika") {
      // Pika is Fal-routed: use fal-ai/pika/v2.2/* as modelPath.
      const modelPath = url.searchParams.get("modelPath") ?? DEFAULT_PIKA_FAL_MODEL;
      const resp = await fetch(`${FAL_BASE_URL}/${modelPath}/requests/${encodeURIComponent(id)}/status`, {
        headers: { Authorization: `Key ${apiKey}` },
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
    } else if (provider === "grok") {
      const resp = await fetch(`${XAI_BASE_URL}/videos/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      httpStatus = resp.status;
      const text = await resp.text();
      try { upstream = text ? JSON.parse(text) : {}; } catch { upstream = { raw: text }; }
    } else if (provider === "higgsfield") {
      return jsonError(
        "PROVIDER_NOT_AVAILABLE",
        "Higgsfield polling not wired yet — generate function holds the request_id until its own status helper lands.",
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
    } else if (provider === "pika" || provider === "fal") {
      // Fal status semantics: IN_QUEUE, IN_PROGRESS, COMPLETED, FAILED, etc.
      const raw = String(upstream.status ?? "").toLowerCase();
      if (raw === "completed") status = "succeeded";
      else if (raw === "failed" || raw === "cancelled") status = "failed";
      else if (raw === "in_progress" || raw === "running") status = "running";
      else status = "queued";
      if (status === "succeeded") {
        const out = upstream.response as Record<string, unknown> | undefined;
        const video = (out?.video as Record<string, unknown> | undefined) ?? undefined;
        resultUrl = (video?.url as string) ?? (out?.video_url as string) ?? null;
      }
    } else if (provider === "grok") {
      // xAI semantics: pending | done | failed | expired
      const raw = String(upstream.status ?? "").toLowerCase();
      if (raw === "done") status = "succeeded";
      else if (raw === "failed" || raw === "expired") status = "failed";
      else status = "running";
      if (status === "succeeded") {
        const video = upstream.video as Record<string, unknown> | undefined;
        resultUrl = (video?.url as string) ?? null;
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

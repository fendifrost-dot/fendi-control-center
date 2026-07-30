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

// Prefix so the raw Fal detail is greppable in Supabase edge logs.
const LOG = "[fal-queue-poll]";

// Fal's queue status payload carries a `logs` array whose entries hold the REAL
// failure (traceback, "CUDA out of memory", ffmpeg stderr, output-validation
// error) — far more specific than the generic `detail` on the response body.
// Flatten it to a bounded string for logging + propagation.
function extractLogs(statusJson: unknown): string {
  const logs = (statusJson as { logs?: unknown } | null)?.logs;
  if (!logs) return "";
  if (Array.isArray(logs)) {
    return logs
      .map((l) =>
        typeof l === "string"
          ? l
          : (l as { message?: string })?.message ?? JSON.stringify(l),
      )
      .join("\n");
  }
  return typeof logs === "string" ? logs : JSON.stringify(logs);
}

// Image jobs return their asset under `image`/`images`; VIDEO models vary —
// Kling/Beeble use `video.url`, some ffmpeg/decart lanes use `video_url`,
// `videos[0].url`, or nest under `output`. The old code only read `video.url`,
// so a completed video job with any other shape silently returned
// `video_url: null` and read as success. Probe the known shapes.
function extractVideoUrl(result: unknown): string | null {
  const r = result as Record<string, any> | null;
  if (!r) return null;
  const candidates = [
    r.video?.url,
    r.video_url,
    Array.isArray(r.video) ? r.video[0]?.url : undefined,
    Array.isArray(r.videos) ? r.videos[0]?.url : undefined,
    r.output?.video?.url,
    r.output?.url,
    typeof r.output === "string" ? r.output : undefined,
    r.url,
  ];
  const found = candidates.find(
    (u): u is string => typeof u === "string" && u.length > 0,
  );
  return found ?? null;
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
      // The Fal STATUS endpoint itself failed (auth/quota/404/5xx). Capture the
      // body — a 401/403 here is the tell for an account/billing/key problem
      // rather than a job problem. status_url has no secret in it (the key rides
      // the Authorization header, which we never log).
      const statusBody = await statusResp.text().catch(() => "");
      console.error(
        `${LOG} status_fetch_failed http=${statusResp.status} url=${statusUrl} body=${statusBody.slice(0, 1500)}`,
      );
      return json(502, {
        error: "fal_status_failed",
        detail: `status_${statusResp.status}`,
        fal_status: statusResp.status,
        fal_body_preview: statusBody.slice(0, 1500),
        status_url: statusUrl,
      });
    }
    const statusJson = await statusResp.json().catch(() => ({}));
    const status = statusJson?.status ?? "UNKNOWN";

    // Some models surface a terminal ERROR/FAILED status here instead of driving
    // to COMPLETED and failing at the response fetch. Previously that status was
    // returned verbatim with a 200, so the client kept polling forever (a hang
    // that presents as "stuck", not as an error). Detect it and fail loudly with
    // the queue logs, which hold the real cause.
    const terminalError =
      typeof status === "string" && /^(ERROR|FAILED)$/i.test(status);
    if (terminalError) {
      const falLogs = extractLogs(statusJson);
      console.error(
        `${LOG} terminal_status status=${status} logs=${falLogs.slice(0, 1500)} raw=${JSON.stringify(statusJson).slice(0, 1500)}`,
      );
      return json(502, {
        error: "fal_job_error",
        fal_status: status,
        fal_error_detail:
          statusJson?.error ?? statusJson?.detail ?? null,
        fal_logs: falLogs.slice(0, 1500),
        fal_body_preview: JSON.stringify(statusJson).slice(0, 1500),
      });
    }

    if (status !== "COMPLETED") {
      // Still running — surface the transient status to edge logs but keep the
      // exact {status, raw} contract the client polls on.
      console.log(`${LOG} in_progress status=${status}`);
      return json(200, { status, raw: statusJson });
    }

    const respResp = await fetch(responseUrl, {
      headers: { Authorization: `Key ${falKey}` },
    });
    if (!respResp.ok) {
      // Job reached COMPLETED but the response is an error — this is where a
      // genuinely failed Fal job (esp. video: GPU OOM, ffmpeg failure, output
      // validation) lands. Surface the raw response body AND the queue logs,
      // and echo them to edge logs. This is the point that used to mask every
      // video failure behind a bare `fal_response_failed`.
      const errBody = await respResp.text().catch(() => "");
      const falLogs = extractLogs(statusJson);
      console.error(
        `${LOG} response_fetch_failed http=${respResp.status} url=${responseUrl} body=${errBody.slice(0, 1500)} status_logs=${falLogs.slice(0, 1000)}`,
      );
      return json(502, {
        error: "fal_response_failed",
        detail: `response_${respResp.status}`,
        fal_status: respResp.status,
        fal_body_preview: errBody.slice(0, 1500),
        fal_error_body: errBody.slice(0, 1500), // back-compat alias
        fal_logs: falLogs.slice(0, 1500),
        response_url: responseUrl,
      });
    }
    const result = await respResp.json().catch(() => ({}));
    const loraFile = result?.diffusers_lora_file as { url?: string } | undefined;
    const videoUrl = extractVideoUrl(result);
    if (!videoUrl && !loraFile?.url) {
      // COMPLETED with a 200 body but neither expected asset present. Catches a
      // video-vs-image response-shape mismatch that would otherwise return
      // video_url:null and read as a silent success. Log the actual keys.
      console.warn(
        `${LOG} completed_no_output keys=${JSON.stringify(Object.keys(result || {}))} sample=${JSON.stringify(result).slice(0, 800)}`,
      );
    }
    return json(200, {
      status: "COMPLETED",
      lora_url: loraFile?.url ?? null,
      video_url: videoUrl,
      result,
    });
  } catch (err: unknown) {
    const msg = String((err as Error)?.message ?? err).slice(0, 500);
    console.error(`${LOG} poll_exception ${msg}`);
    return json(500, { error: "poll_failed", detail: msg });
  }
});

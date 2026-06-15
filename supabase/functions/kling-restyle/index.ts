// CC edge function -- kling-restyle
//
// Fal Kling video-to-video orchestrator. Smoke-test for wardrobe + identity swap.
//
// Boundary contract:
//   Header:  X-Proxy-Secret (must equal KLING_PROXY_SECRET)
//   Input:   {
//     sourceVideoUrl: string,            // HTTPS URL Fal can fetch (signed)
//     prompt: string,                    // Output scene description
//     callback_url?: string,             // Optional async callback
//   }
//   Output (sync mode, no callback_url):
//     { output_video_url, request_id, cost_cents }
//   Output (async mode, callback_url present):
//     { status: "queued" }                 (Background job POSTs callback)
//
// Env vars required:
//   - FAL_API_KEY              (https://fal.ai/)
//   - KLING_PROXY_SECRET       (shared with AVT kling-restyle-proxy)
//
// Kling models on Fal:
//   - fal-ai/kling-video/v2.1/master/video-to-video (transforms existing video)
//
// Pricing: Kling pricing varies; per-minute billing typical.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type Body = {
  sourceVideoUrl: string;
  prompt: string;
  callback_url?: string;
};

type FalQueueResp = {
  request_id: string;
  status_url: string;
  response_url: string;
};

type FalStatusResp = {
  request_id: string;
  status: string; // "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED"
  result?: {
    video?: {
      url?: string;
    };
    video_url?: string; // alternate field name
  };
  error?: {
    message?: string;
  };
};

const FAL_KLING_ENDPOINT = "https://queue.fal.run/fal-ai/kling-video/o1/video-to-video/edit";
const POLL_INTERVAL_MS = 3_000;
const SYNC_POLL_TIMEOUT_MS = 140_000;
const ASYNC_POLL_TIMEOUT_MS = 600_000;

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  // ---- env --------------------------------------------------------------
  const falKey = Deno.env.get("FAL_API_KEY") ?? "";
  const proxySecret = Deno.env.get("KLING_PROXY_SECRET") ?? "";
  if (!falKey) {
    return json(500, { error: "server_misconfigured", detail: "FAL_API_KEY missing" });
  }
  if (!proxySecret) {
    return json(500, { error: "server_misconfigured", detail: "KLING_PROXY_SECRET missing" });
  }

  // ---- proxy auth -------------------------------------------------------
  const headerSecret = req.headers.get("x-proxy-secret") ?? "";
  if (!headerSecret) return json(401, { error: "missing_proxy_secret" });
  if (!constantTimeEqual(headerSecret, proxySecret)) {
    return json(401, { error: "bad_proxy_secret" });
  }

  // ---- body -------------------------------------------------------------
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  if (!body.sourceVideoUrl || typeof body.sourceVideoUrl !== "string") {
    return json(400, { error: "missing_source_video_url" });
  }
  if (!body.prompt || body.prompt.trim().length < 4) {
    return json(400, { error: "prompt_too_short" });
  }

  // ---- execution --------------------------------------------------------
  const executeJob = async (): Promise<Response> => {
    let submit: FalQueueResp;
    try {
      submit = await submitKlingJob(falKey, {
        sourceVideoUrl: body.sourceVideoUrl,
        prompt: body.prompt,
      });
    } catch (err: any) {
      return json(502, {
        error: "kling_submit_failed",
        detail: String(err?.message ?? err).slice(0, 500),
      });
    }

    const requestId = submit?.request_id || submit?.["request_id"];
    const statusUrl = submit?.status_url || submit?.["status_url"];
    const responseUrl = submit?.response_url || submit?.["response_url"] || statusUrl;
    if (!requestId) {
      return json(502, {
        error: "kling_no_request_id",
        detail: `submit=${JSON.stringify(submit)}`,
      });
    }
    if (!statusUrl) {
      return json(502, {
        error: "kling_no_status_url",
        detail: `submit=${JSON.stringify(submit)}`,
      });
    }

    const timeoutMs = body.callback_url ? ASYNC_POLL_TIMEOUT_MS : SYNC_POLL_TIMEOUT_MS;
    let final: FalStatusResp;
    try {
      final = await pollFalUntilDone(falKey, statusUrl, responseUrl, timeoutMs);
    } catch (err: any) {
      return json(502, {
        error: "kling_poll_failed",
        detail: String(err?.message ?? err).slice(0, 500),
        request_id: requestId,
      });
    }

    if (final.status === "FAILED") {
      return json(502, {
        error: "kling_job_failed",
        detail: final.error?.message ?? "unknown",
        request_id: requestId,
      });
    }

    // Try multiple possible field names for Kling output video
    const outputUrl = final.result?.video?.url
      || final.result?.video_url
      || final.result?.output_video
      || final.result?.edited_video
      || (final.result as any)?.video?.url
      || (final.result as any)?.output?.url;

    if (!outputUrl) {
      return json(502, {
        error: "kling_no_video_url",
        request_id: requestId,
        debug_result_keys: Object.keys(final.result || {}),
        debug_result: JSON.stringify(final.result).slice(0, 500),
      });
    }

    // Kling O1 Edit pricing: $0.168/sec, 5s = $0.84 = 84 cents
    const costCents = 84;

    return json(200, {
      output_video_url: outputUrl,
      request_id: requestId,
      cost_cents: costCents,
      generation_metadata: {
        source_video_url: body.sourceVideoUrl,
        prompt: body.prompt,
      },
    });
  };

  // ASYNC MODE — return 200 queued immediately, finish in background.
  if (body.callback_url) {
    const callbackUrl = body.callback_url;
    const background = (async () => {
      let resp: Response;
      try {
        resp = await executeJob();
      } catch (err: any) {
        await postCallback(callbackUrl, proxySecret, {
          status: "failed",
          error: `cc_unhandled: ${String(err?.message ?? err).slice(0, 500)}`,
        });
        return;
      }
      const respText = await resp.text().catch(() => "");
      let parsed: any = null;
      try { parsed = JSON.parse(respText); } catch { /* ignore */ }
      if (resp.ok && parsed?.output_video_url) {
        await postCallback(callbackUrl, proxySecret, {
          status: "complete",
          output_video_url: parsed.output_video_url,
          request_id: parsed.request_id,
          cost_cents: parsed.cost_cents,
          generation_metadata: parsed.generation_metadata,
        });
      } else {
        const errMsg = parsed?.error ?? `cc_${resp.status}`;
        const detail = parsed?.detail ? `: ${String(parsed.detail).slice(0, 300)}` : "";
        await postCallback(callbackUrl, proxySecret, {
          status: "failed",
          error: `${errMsg}${detail}`.slice(0, 500),
        });
      }
    })();

    // deno-lint-ignore no-explicit-any
    const er = (globalThis as any).EdgeRuntime;
    if (er && typeof er.waitUntil === "function") {
      er.waitUntil(background);
    } else {
      background.catch(() => {});
    }
    return json(200, { status: "queued" });
  }

  // SYNC MODE — for curl smoke tests only. 140s ceiling.
  return await executeJob();
});

// ---------------------------------------------------------------------------
// Fal Kling API helpers
// ---------------------------------------------------------------------------
async function submitKlingJob(
  apiKey: string,
  input: {
    sourceVideoUrl: string;
    prompt: string;
  },
): Promise<FalQueueResp> {
  // Fal queue submission for Kling O1 Edit (video-to-video natural language editor).
  const requestBody = {
    video_url: input.sourceVideoUrl,
    prompt: input.prompt,
  };

  const resp = await fetch(FAL_KLING_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`kling_submit_${resp.status}: ${errText.slice(0, 1500)}`);
  }
  return await resp.json();
}

async function pollFalUntilDone(
  apiKey: string,
  statusUrl: string,
  responseUrl: string,
  timeoutMs: number,
): Promise<FalStatusResp> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const resp = await fetch(statusUrl, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!resp.ok) {
      if (resp.status >= 500) continue;
      const errText = await resp.text().catch(() => "");
      throw new Error(`kling_status_${resp.status}: ${errText.slice(0, 300)}`);
    }
    const status: FalStatusResp = await resp.json();
    const s = (status.status || "").toUpperCase();
    if (s === "COMPLETED") {
      // Fetch final result from response_url
      const respResp = await fetch(responseUrl, {
        headers: { Authorization: `Key ${apiKey}` },
      });
      if (!respResp.ok) {
        const errText = await respResp.text().catch(() => "");
        throw new Error(`kling_response_${respResp.status}: ${errText.slice(0, 300)}`);
      }
      const finalResult: FalStatusResp = await respResp.json();
      return { ...status, result: finalResult.result };
    }
    if (s === "FAILED") {
      return status;
    }
    // IN_QUEUE, IN_PROGRESS — keep polling
  }
  throw new Error("kling_poll_timeout");
}

// ---------------------------------------------------------------------------
// Callback helper (async-mode result POST back to AVT proxy)
// ---------------------------------------------------------------------------
async function postCallback(
  url: string,
  proxySecret: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Secret": proxySecret,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Drop — AVT poll/UI can recover
  }
}

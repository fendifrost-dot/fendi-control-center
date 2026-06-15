// CC edge function -- switchx-restyle
//
// Beeble SwitchX video-to-video orchestrator. AVT-side data access (caller
// auth, project lookup, source video signing, restyle-job row insert) is
// owned by the switchx-restyle-proxy edge function on the AVT side.
//
// Boundary contract:
//   Header:  X-Proxy-Secret (must equal SWITCHX_PROXY_SECRET)
//   Input:   {
//     sourceVideoUrl: string,            // HTTPS URL Beeble can fetch (signed)
//     prompt: string,                    // Output scene description
//     mode?: "custom" | "auto",          // Default "auto"
//     referenceImageUrl?: string | null, // Optional location/style ref
//     callback_url?: string,             // Optional async callback (AVT proxy)
//   }
//   Output (sync mode, no callback_url):
//     { output_video_url, frames_processed, cost_cents, beeble_job_id,
//       generation_metadata }
//   Output (async mode, callback_url present):
//     { status: "queued" }                 (Background job POSTs callback)
//
// Env vars required:
//   - BEEBLE_API_KEY              (https://developer.beeble.ai/)
//   - SWITCHX_PROXY_SECRET        (shared with AVT switchx-restyle-proxy)
//
// Pricing (verified 2026-06-14 from developer.beeble.ai/pricing):
//   - 720p: $0.10 per 30 frames
//   - 1080p: $0.30 per 30 frames
//   - Same rates for images
//   - Max 240 frames per job (~8s at 30fps)
//   - Pay-as-you-go, $50 min topup
//
// Modes:
//   - "custom" — precision wardrobe / object swap, keeps face + hands intact.
//                Best for performance shots where artist identity is locked.
//   - "auto"   — first-frame subject detection + propagation. Faster, good
//                for full scene replacements (b-roll, lyric visuals).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type SwitchXMode = "custom" | "auto";

type Body = {
  sourceVideoUrl: string;
  prompt: string;
  mode?: SwitchXMode;
  referenceImageUrl?: string | null;
  /**
   * Async mode: when present, the function returns `{ status: 'queued' }`
   * immediately and runs the SwitchX job in the background via
   * EdgeRuntime.waitUntil. When the job finishes (or fails), CC POSTs the
   * result to `callback_url` with the X-Proxy-Secret header so the AVT
   * proxy can update the restyle-job row.
   *
   * SwitchX jobs commonly run 30-90s for 720p / 5s clips and can exceed
   * Supabase Edge's ~150s sync wall for 1080p / 8s clips. Always use the
   * callback path when integrating with a UI; sync is for curl smoke tests.
   */
  callback_url?: string;
};

type BeebleSubmitResp = {
  id: string;
  status?: string;
};

type BeebleStatusResp = {
  id: string;
  status: string; // "queued" | "processing" | "succeeded" | "failed"
  result?: {
    output_url?: string;
    frames_processed?: number;
    resolution?: string; // "720p" | "1080p" | etc.
  };
  error?: { message?: string; code?: string };
};

const BEEBLE_API_BASE = "https://api.beeble.ai/v1";
const SWITCHX_SUBMIT_URL = `${BEEBLE_API_BASE}/switchx/generations`;
const POLL_INTERVAL_MS = 3_000;
const SYNC_POLL_TIMEOUT_MS = 140_000; // Stay under platform sync wall
const ASYNC_POLL_TIMEOUT_MS = 600_000; // 10 min for 1080p / 8s clips

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

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  // ---- env --------------------------------------------------------------
  const beebleKey = Deno.env.get("BEEBLE_API_KEY") ?? "";
  const proxySecret = Deno.env.get("SWITCHX_PROXY_SECRET") ?? "";
  if (!beebleKey) {
    return json(500, { error: "server_misconfigured", detail: "BEEBLE_API_KEY missing" });
  }
  if (!proxySecret) {
    return json(500, { error: "server_misconfigured", detail: "SWITCHX_PROXY_SECRET missing" });
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
  const mode: SwitchXMode = body.mode === "custom" ? "custom" : "auto";

  // ---- execution --------------------------------------------------------
  const executeJob = async (): Promise<Response> => {
    let submit: BeebleSubmitResp;
    try {
      submit = await submitSwitchXJob(beebleKey, {
        sourceVideoUrl: body.sourceVideoUrl,
        prompt: body.prompt,
        mode,
        referenceImageUrl: body.referenceImageUrl ?? null,
      });
    } catch (err: any) {
      return json(502, {
        error: "beeble_submit_failed",
        detail: String(err?.message ?? err).slice(0, 500),
      });
    }

    const jobId = submit?.id;
    if (!jobId) {
      return json(502, { error: "beeble_no_job_id", detail: JSON.stringify(submit).slice(0, 300) });
    }

    const timeoutMs = body.callback_url ? ASYNC_POLL_TIMEOUT_MS : SYNC_POLL_TIMEOUT_MS;
    let final: BeebleStatusResp;
    try {
      final = await pollBeebleUntilDone(beebleKey, jobId, timeoutMs);
    } catch (err: any) {
      return json(502, {
        error: "beeble_poll_failed",
        detail: String(err?.message ?? err).slice(0, 500),
        beeble_job_id: jobId,
      });
    }

    if (final.status === "failed") {
      return json(502, {
        error: "beeble_job_failed",
        detail: final.error?.message ?? "unknown",
        beeble_job_id: jobId,
      });
    }

    const outputUrl = final.result?.output_url;
    if (!outputUrl) {
      return json(502, {
        error: "beeble_no_output_url",
        beeble_job_id: jobId,
      });
    }

    const frames = final.result?.frames_processed ?? 0;
    const resolution = (final.result?.resolution ?? "720p").toLowerCase();
    const costCents = estimateCostCents(frames, resolution);

    return json(200, {
      output_video_url: outputUrl,
      frames_processed: frames,
      cost_cents: costCents,
      beeble_job_id: jobId,
      generation_metadata: {
        mode,
        resolution,
        source_video_url: body.sourceVideoUrl,
        reference_image_url: body.referenceImageUrl ?? null,
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
          frames_processed: parsed.frames_processed,
          cost_cents: parsed.cost_cents,
          beeble_job_id: parsed.beeble_job_id,
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
// Beeble SwitchX API helpers
// ---------------------------------------------------------------------------
async function submitSwitchXJob(
  apiKey: string,
  input: {
    sourceVideoUrl: string;
    prompt: string;
    mode: SwitchXMode;
    referenceImageUrl?: string | null;
  },
): Promise<BeebleSubmitResp> {
  // Beeble API request body. Field names per docs.beeble.ai/beeble/switchx
  // — flat top-level fields, NOT nested source/reference objects. Required
  // fields: generation_type, source_uri, prompt. Optional: reference_image_uri,
  // alpha_uri, alpha_mode, max_resolution.
  const requestBody: Record<string, unknown> = {
    generation_type: "video",
    source_uri: input.sourceVideoUrl,
    prompt: input.prompt,
    alpha_mode: input.mode,
    // Beeble wants max_resolution as an integer (vertical pixels), not "720p".
    // 720 = 720p, 1080 = 1080p. We default to 720 for cost (10c/30 frames).
    max_resolution: 720,
  };
  if (input.referenceImageUrl) {
    requestBody.reference_image_uri = input.referenceImageUrl;
  }

  const resp = await fetch(SWITCHX_SUBMIT_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    // Bump error truncation to 1500 chars so 422 validation lists with
    // multiple missing-field entries don't get cut mid-sentence.
    throw new Error(`beeble_submit_${resp.status}: ${errText.slice(0, 1500)}`);
  }
  return await resp.json();
}

async function pollBeebleUntilDone(
  apiKey: string,
  jobId: string,
  timeoutMs: number,
): Promise<BeebleStatusResp> {
  const start = Date.now();
  const statusUrl = `${BEEBLE_API_BASE}/switchx/generations/${jobId}`;
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const resp = await fetch(statusUrl, {
      headers: { "x-api-key": apiKey },
    });
    if (!resp.ok) {
      // Soft-skip transient 5xx; treat persistent errors as failures
      if (resp.status >= 500) continue;
      const errText = await resp.text().catch(() => "");
      throw new Error(`beeble_status_${resp.status}: ${errText.slice(0, 300)}`);
    }
    const status: BeebleStatusResp = await resp.json();
    const s = (status.status || "").toLowerCase();
    if (s === "succeeded" || s === "completed" || s === "complete") {
      return status;
    }
    if (s === "failed" || s === "error" || s === "errored") {
      return status;
    }
    // queued, processing, running — keep polling
  }
  throw new Error("beeble_poll_timeout");
}

// ---------------------------------------------------------------------------
// Cost estimation (Build tier pricing as of 2026-06-14)
//   720p:  $0.10 per 30 frames
//   1080p: $0.30 per 30 frames
// Returns whole cents (rounded up).
// ---------------------------------------------------------------------------
function estimateCostCents(frames: number, resolution: string): number {
  if (frames <= 0) return 0;
  const r = (resolution || "").toLowerCase();
  let centsPer30Frames = 10; // 720p default
  if (r.includes("1080") || r.includes("fhd") || r === "1080p") {
    centsPer30Frames = 30;
  }
  return Math.ceil((frames / 30) * centsPer30Frames);
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
    // Drop — AVT poll/UI can recover; logging would help but Edge logs are
    // out of scope for the v1 smoke-test path.
  }
}

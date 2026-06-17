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
//     prompt: string,                    // Output scene / wardrobe description
//     mode?: "custom" | "auto" | "wardrobe",   // Default "auto"
//     referenceImageUrl?: string | null, // Optional location/style ref (auto/custom)
//     // --- wardrobe mode only ---
//     wardrobeReferenceImageUrl?: string,// REQUIRED for wardrobe: target outfit ref
//     keepMaskUrl?: string | null,       // Optional: first-frame keep-mask PNG (alpha).
//                                        //   If omitted, generated from the source video.
//     invertMask?: boolean,              // Optional (default true): invert the SAM mask
//                                        //   so prompted regions become BLACK (preserve).
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
//   - FAL_API_KEY                 (only for wardrobe mode WITHOUT a supplied
//                                  keepMaskUrl — used for first-frame extraction,
//                                  SAM-3 segmentation, and Fal CDN mask hosting)
//
// Pricing (verified 2026-06-14 from developer.beeble.ai/pricing):
//   - 720p: $0.10 per 30 frames
//   - 1080p: $0.30 per 30 frames
//   - Same rates for images
//   - Max 240 frames per job (~8s at 30fps)
//   - Pay-as-you-go, $50 min topup
//
// Modes:
//   - "custom"   — precision wardrobe / object swap, keeps face + hands intact.
//                  Caller supplies the full per-frame alpha (alpha_mode=custom).
//   - "auto"     — first-frame subject detection + propagation. Faster, good
//                  for full scene replacements (b-roll, lyric visuals).
//   - "wardrobe" — swap a subject's CLOTHING while preserving face, body, motion,
//                  and lipsync. Identity is held by INVERTING the alpha polarity:
//                  we mask the parts to KEEP (face, hands, hair, exposed skin) and
//                  let SwitchX regenerate everything else (the clothing). Uses
//                  Beeble alpha_mode="select": ONE first-frame keep-mask PNG that
//                  Beeble's internal SAM3 propagates across the whole clip.
//
//   KEEP-MASK POLARITY (verbatim from developer.beeble.ai docs):
//       WHITE = regenerate, BLACK = preserve.
//   So the keep-mask is BLACK on face/hands/hair/skin and WHITE everywhere else.
//   Fal SAM-3 returns the OPPOSITE convention (WHITE on the prompted region), so
//   we invert it before handing it to Beeble. `invertMask:false` disables that if
//   the caller pre-supplies a mask already in Beeble polarity.
//
//   NOTE: this function does NOT touch audio. Lipsync/audio is preserved by the
//   downstream build, not here.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { Image } from "https://deno.land/x/imagescript@1.2.15/mod.ts";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type SwitchXMode = "custom" | "auto" | "wardrobe";

// Beeble's alpha_mode is its own enum (auto|fill|custom|select), distinct from
// our caller-facing `mode`. wardrobe maps to "select" (single keyframe mask,
// SAM3-propagated); auto/custom pass through 1:1.
const BEEBLE_ALPHA_MODE: Record<SwitchXMode, string> = {
  auto: "auto",
  custom: "custom",
  wardrobe: "select",
};

// Prompt prefix injected for wardrobe mode so SwitchX locks identity + pose and
// only regenerates the garment.
const WARDROBE_PROMPT_PREFIX = "Same subject, identical face and pose, wearing ";

type Body = {
  sourceVideoUrl: string;
  prompt: string;
  mode?: SwitchXMode;
  referenceImageUrl?: string | null;
  // --- wardrobe mode ---
  wardrobeReferenceImageUrl?: string;
  keepMaskUrl?: string | null;
  invertMask?: boolean;
  /**
   * Fire-and-forget submit (smoke tests). When true (and no callback_url),
   * the function resolves the keep-mask, submits the Beeble job, and returns
   * `{ status: "queued", beeble_job_id, generation_metadata }` immediately —
   * WITHOUT polling. The caller polls `beeble-poll-debug?job_id=<id>` itself.
   * This sidesteps the Edge 150s sync wall for slow 1080p wardrobe jobs.
   */
  queue_only?: boolean;
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
    render?: string; // The restyled video (what we want)
    source?: string; // Original echoed back
    alpha?: string; // Alpha matte
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

const FAL_QUEUE_BASE = "https://queue.fal.run";
const FAL_EXTRACT_FRAME_URL = `${FAL_QUEUE_BASE}/fal-ai/ffmpeg-api/extract-frame`;
const FAL_SAM3_URL = `${FAL_QUEUE_BASE}/fal-ai/sam-3/image`;
const FAL_CDN_INITIATE_URL =
  "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3";
const SAM_KEEP_PROMPT = "face, hands, hair, exposed skin";

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
  const falKey = Deno.env.get("FAL_API_KEY") ?? "";
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

  // ---- stage-file helper action ----------------------------------------
  // Lets a caller POST { action: "stage-file", url: "...", fileName: "..." }
  // and get back a Fal-CDN-hosted URL. Used to re-host source videos and
  // wardrobe reference images on a CDN Beeble can fetch from when the
  // original host (catbox.moe etc.) refuses Beeble's IPs.
  if ((body as any).action === "stage-file") {
    const stageUrl = (body as any).url;
    const stageFileName = (body as any).fileName ?? "staged.bin";
    if (!stageUrl || typeof stageUrl !== "string") {
      return json(400, { error: "stage_file_missing_url" });
    }
    if (!falKey) {
      return json(500, { error: "server_misconfigured", detail: "FAL_API_KEY missing" });
    }
    try {
      const fetchResp = await fetch(stageUrl);
      if (!fetchResp.ok) {
        return json(502, {
          error: "stage_file_fetch_failed",
          detail: `${fetchResp.status} fetching ${stageUrl}`,
        });
      }
      const stageBytes = new Uint8Array(await fetchResp.arrayBuffer());
      const stageContentType =
        fetchResp.headers.get("content-type") ?? "application/octet-stream";
      const cdnUrl = await uploadFileToFalCdn(
        falKey,
        stageBytes,
        stageFileName,
        stageContentType,
      );
      return json(200, {
        fal_cdn_url: cdnUrl,
        bytes: stageBytes.length,
        content_type: stageContentType,
      });
    } catch (err: any) {
      return json(502, {
        error: "stage_file_failed",
        detail: String(err?.message ?? err).slice(0, 500),
      });
    }
  }

  if (!body.sourceVideoUrl || typeof body.sourceVideoUrl !== "string") {
    return json(400, { error: "missing_source_video_url" });
  }
  if (!body.prompt || body.prompt.trim().length < 4) {
    return json(400, { error: "prompt_too_short" });
  }
  const mode: SwitchXMode =
    body.mode === "custom" ? "custom" : body.mode === "wardrobe" ? "wardrobe" : "auto";

  // ---- wardrobe-mode validation ----------------------------------------
  if (mode === "wardrobe") {
    if (!body.wardrobeReferenceImageUrl || typeof body.wardrobeReferenceImageUrl !== "string") {
      return json(400, { error: "missing_wardrobe_reference_image_url" });
    }
    // We need FAL_API_KEY only to GENERATE a mask. If the caller pre-supplies
    // keepMaskUrl we can run wardrobe with no Fal dependency at all.
    if (!body.keepMaskUrl && !falKey) {
      return json(400, {
        error: "keep_mask_required",
        detail:
          "wardrobe mode needs either keepMaskUrl (verbatim alpha PNG) or FAL_API_KEY " +
          "configured so the keep-mask can be auto-generated from the source video.",
      });
    }
  }

  // ---- execution --------------------------------------------------------
  // pollForResult=false → resolve mask + submit, return job id, skip polling.
  const executeJob = async (pollForResult: boolean): Promise<Response> => {
    // Resolve the wardrobe keep-mask up front (provided verbatim, or generated).
    let resolvedKeepMaskUrl: string | null = body.keepMaskUrl ?? null;
    let keepMaskGenerated = false;
    if (mode === "wardrobe" && !resolvedKeepMaskUrl) {
      try {
        resolvedKeepMaskUrl = await generateKeepMask(falKey, body.sourceVideoUrl, {
          invert: body.invertMask !== false, // default true
        });
        keepMaskGenerated = true;
      } catch (err: any) {
        return json(502, {
          error: "keep_mask_generation_failed",
          detail: String(err?.message ?? err).slice(0, 500),
        });
      }
    }

    let submit: BeebleSubmitResp;
    try {
      submit = await submitSwitchXJob(beebleKey, {
        sourceVideoUrl: body.sourceVideoUrl,
        prompt: body.prompt,
        mode,
        referenceImageUrl: body.referenceImageUrl ?? null,
        wardrobeReferenceImageUrl: body.wardrobeReferenceImageUrl ?? null,
        keepMaskUrl: resolvedKeepMaskUrl,
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

    const baseMetadata = {
      mode,
      source_video_url: body.sourceVideoUrl,
      reference_image_url: body.referenceImageUrl ?? null,
      wardrobe_reference_image_url: body.wardrobeReferenceImageUrl ?? null,
      keep_mask_url: resolvedKeepMaskUrl,
      keep_mask_generated: keepMaskGenerated,
      prompt: body.prompt,
    };

    // queue_only — hand back the Beeble job id and let the caller poll
    // beeble-poll-debug. No sync wall to fight.
    if (!pollForResult) {
      return json(200, {
        status: "queued",
        beeble_job_id: jobId,
        generation_metadata: baseMetadata,
      });
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

    const outputUrl = final.result?.render;
    if (!outputUrl) {
      return json(502, {
        error: "beeble_no_render_url",
        beeble_job_id: jobId,
      });
    }

    const frames = final.result?.frames_processed ?? 0;
    const resolution = (final.result?.resolution ?? (mode === "wardrobe" ? "1080p" : "720p"))
      .toLowerCase();
    const costCents = estimateCostCents(frames, resolution);

    return json(200, {
      output_video_url: outputUrl,
      frames_processed: frames,
      cost_cents: costCents,
      beeble_job_id: jobId,
      generation_metadata: { ...baseMetadata, resolution },
    });
  };

  // QUEUE-ONLY MODE — submit + return job id, caller polls beeble-poll-debug.
  if (body.queue_only && !body.callback_url) {
    return await executeJob(false);
  }

  // ASYNC MODE — return 200 queued immediately, finish in background.
  if (body.callback_url) {
    const callbackUrl = body.callback_url;
    const background = (async () => {
      let resp: Response;
      try {
        resp = await executeJob(true);
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
  return await executeJob(true);
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
    wardrobeReferenceImageUrl?: string | null;
    keepMaskUrl?: string | null;
  },
): Promise<BeebleSubmitResp> {
  // Beeble API request body. Field names per developer.beeble.ai/docs.
  // Flat top-level *_uri fields (NOT nested objects); Beeble accepts plain
  // signed HTTPS URLs as well as beeble:// upload URIs, so we pass the signed
  // URLs straight through (same as the proven auto/custom path — no presign
  // round-trip needed). Required: generation_type, source_uri, prompt.
  const requestBody: Record<string, unknown> = {
    generation_type: "video",
    source_uri: input.sourceVideoUrl,
    prompt: input.prompt,
    alpha_mode: BEEBLE_ALPHA_MODE[input.mode],
    // Beeble wants max_resolution as an integer (vertical pixels), not "720p".
    // 720 = 720p, 1080 = 1080p. auto/custom default to 720 for cost (10c/30
    // frames); wardrobe runs at 1080 so the garment swap holds fine detail.
    max_resolution: input.mode === "wardrobe" ? 1080 : 720,
  };

  if (input.mode === "wardrobe") {
    // Identity-preserving wardrobe swap. EXACT shape per task spec:
    //   reference_image_uri = target outfit; alpha_uri = first-frame keep-mask;
    //   alpha_mode = "select"; alpha_keyframe_index = 0 (Beeble SAM3 propagates).
    if (!input.wardrobeReferenceImageUrl) {
      throw new Error("wardrobe_missing_reference_image_uri");
    }
    if (!input.keepMaskUrl) {
      throw new Error("wardrobe_missing_alpha_uri");
    }
    requestBody.reference_image_uri = input.wardrobeReferenceImageUrl;
    requestBody.alpha_uri = input.keepMaskUrl;
    requestBody.alpha_keyframe_index = 0;
    requestBody.prompt = `${WARDROBE_PROMPT_PREFIX}${input.prompt}`;
  } else if (input.referenceImageUrl) {
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
// Keep-mask generation (wardrobe mode, when no keepMaskUrl supplied)
//
// Pipeline:
//   1. Extract the FIRST frame of the source video (Fal ffmpeg-api).
//   2. Segment "face, hands, hair, exposed skin" with Fal SAM-3.
//   3. Invert polarity (SAM gives WHITE on the prompted region; Beeble wants
//      BLACK = preserve). Skippable via invert:false.
//   4. Host the resulting PNG on Fal CDN (public HTTPS URL) so Beeble can fetch
//      it as alpha_uri.
//
// We host on Fal CDN rather than Supabase Storage so the whole wardrobe path
// needs exactly ONE extra secret (FAL_API_KEY) — the mask is a non-sensitive
// black/white silhouette and Beeble accepts any fetchable HTTPS URL. See
// SWITCHX_HANDOFF.md for the rationale / how to switch to Supabase Storage.
// ---------------------------------------------------------------------------
async function generateKeepMask(
  falKey: string,
  sourceVideoUrl: string,
  opts: { invert: boolean },
): Promise<string> {
  if (!falKey) throw new Error("fal_api_key_missing");

  // 1. first frame
  const frameUrl = await falExtractFirstFrame(falKey, sourceVideoUrl);
  if (!frameUrl) throw new Error("extract_frame_no_image");

  // 2. SAM-3 segmentation of the keep regions
  const samMaskUrl = await falSam3Mask(falKey, frameUrl, SAM_KEEP_PROMPT);
  if (!samMaskUrl) throw new Error("sam3_no_mask");

  // 3. download + (optionally) invert to Beeble polarity (BLACK = preserve)
  const rawPng = await fetchBytes(samMaskUrl);
  const maskPng = opts.invert ? await invertPng(rawPng) : rawPng;

  // 4. host on Fal CDN
  return await uploadPngToFalCdn(falKey, maskPng, "switchx-keepmask.png");
}

async function falExtractFirstFrame(falKey: string, videoUrl: string): Promise<string | null> {
  const submitResp = await fetch(FAL_EXTRACT_FRAME_URL, {
    method: "POST",
    headers: { Authorization: `Key ${falKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ video_url: videoUrl, frame_type: "first" }),
  });
  if (!submitResp.ok) {
    throw new Error(`extract_frame_submit_${submitResp.status}: ${await submitResp.text().catch(() => "")}`);
  }
  const { request_id, status_url, response_url } = await submitResp.json();
  const result = await pollFalUntilDone(falKey, request_id, status_url, response_url, 90_000);
  return result?.images?.[0]?.url ?? result?.image?.url ?? null;
}

// SAM-3 text-prompted segmentation — returns a mask PNG URL (mirrors the
// compose-look callFalSam3Segment helper).
async function falSam3Mask(falKey: string, imageUrl: string, prompt: string): Promise<string | null> {
  const submitResp = await fetch(FAL_SAM3_URL, {
    method: "POST",
    headers: { Authorization: `Key ${falKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      image_url: imageUrl,
      prompt,
      apply_mask: false,
      output_format: "png",
      max_masks: 1,
    }),
  });
  if (!submitResp.ok) {
    throw new Error(`sam3_submit_${submitResp.status}: ${await submitResp.text().catch(() => "")}`);
  }
  const { request_id, status_url, response_url } = await submitResp.json();
  const result = await pollFalUntilDone(falKey, request_id, status_url, response_url, 90_000);
  return result?.masks?.[0]?.url ?? result?.image?.url ?? null;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch_bytes_${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

// Invert a mask PNG's luminance (RGB), leaving alpha untouched. Decodes/encodes
// with ImageScript (pure-TS, Deno-friendly — no native ffmpeg/canvas).
async function invertPng(bytes: Uint8Array): Promise<Uint8Array> {
  const img = await Image.decode(bytes);
  const data = img.bitmap; // RGBA, 4 bytes/pixel
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i];
    data[i + 1] = 255 - data[i + 1];
    data[i + 2] = 255 - data[i + 2];
    // data[i + 3] (alpha) left as-is
  }
  return await img.encode();
}

async function uploadPngToFalCdn(
  falKey: string,
  bytes: Uint8Array,
  fileName: string,
): Promise<string> {
  return await uploadFileToFalCdn(falKey, bytes, fileName, "image/png");
}

async function uploadFileToFalCdn(
  falKey: string,
  bytes: Uint8Array,
  fileName: string,
  contentType: string,
): Promise<string> {
  const initResp = await fetch(FAL_CDN_INITIATE_URL, {
    method: "POST",
    headers: { Authorization: `Key ${falKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ file_name: fileName, content_type: contentType }),
  });
  if (!initResp.ok) {
    throw new Error(`fal_cdn_initiate_${initResp.status}: ${await initResp.text().catch(() => "")}`);
  }
  const { upload_url, file_url } = await initResp.json();
  if (!upload_url || !file_url) throw new Error("fal_cdn_initiate_missing_urls");

  const putResp = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  if (!putResp.ok) {
    throw new Error(`fal_cdn_upload_${putResp.status}: ${await putResp.text().catch(() => "")}`);
  }
  return file_url;
}

// Fal queue poller (ported from compose-look). Submits return request_id +
// status_url + response_url; we poll status until COMPLETED then fetch result.
async function pollFalUntilDone(
  apiKey: string,
  _requestId: string,
  statusUrl: string,
  responseUrl: string,
  timeoutMs = 90_000,
): Promise<any> {
  const start = Date.now();
  const intervalMs = 1_500;
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const statusResp = await fetch(statusUrl, { headers: { Authorization: `Key ${apiKey}` } });
    if (!statusResp.ok) continue;
    const status = await statusResp.json();
    if (status?.status === "COMPLETED") {
      const respResp = await fetch(responseUrl, { headers: { Authorization: `Key ${apiKey}` } });
      if (!respResp.ok) {
        throw new Error(`fal_response_${respResp.status}: ${await respResp.text().catch(() => "")}`);
      }
      return await respResp.json();
    }
    if (status?.status === "FAILED" || status?.status === "ERROR") {
      throw new Error(`fal_failed: ${status?.error ?? "unknown"}`);
    }
  }
  throw new Error("fal_poll_timeout");
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

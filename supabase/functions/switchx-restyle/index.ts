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
//     mode?: "background" | "wardrobe" | "both" | "auto" | "custom",
//                                        //   Default "background". "auto" is a
//                                        //   back-compat alias for "background".
//     referenceImageUrl?: string | null, // Scene/lighting ref (background/auto/custom)
//     // --- wardrobe / both ---
//     wardrobeReferenceImageUrl?: string,// REQUIRED for wardrobe/both: target outfit ref
//     alphaUrl?: string | null,          // Optional: pre-built per-frame grayscale alpha
//                                        //   VIDEO (Beeble custom polarity:
//                                        //   WHITE=preserve, BLACK=regenerate). If
//                                        //   omitted for wardrobe, generated from the
//                                        //   source via Fal SAM-3 video-rle.
//     keepMaskUrl?: string | null,       // DEPRECATED alias for alphaUrl.
//     polarityOverride?: "auto" | "invert",
//                                        //   "auto" (default): use the SAM-3 matte as
//                                        //   returned (prompted regions WHITE = preserve).
//                                        //   "invert": NOT supported in-function — see
//                                        //   note below. Supply a pre-inverted alphaUrl.
//     // --- both ---
//     backgroundReferenceImageUrl?: string,// Optional bg/scene ref for the 2nd (auto) pass
//     // --- async / smoke ---
//     queue_only?: boolean,              // single-mode only; submit + return job id
//     callback_url?: string,             // run in background, POST result to callback
//   }
//   Output (sync, no callback_url):
//     background/wardrobe: { output_video_url, frames_processed, cost_cents,
//                           beeble_job_id, generation_metadata }
//     both:               { output_video_url, interim_video_url,
//                           wardrobe_job_id, background_job_id, generation_metadata }
//   Output (queue_only, single mode):
//     { status: "queued", beeble_job_id, generation_metadata }
//   Output (async, callback_url present):
//     { status: "queued" }   (background job POSTs the result to callback_url)
//
// Env vars required:
//   - BEEBLE_API_KEY              (https://developer.beeble.ai/)
//   - SWITCHX_PROXY_SECRET        (shared with AVT switchx-restyle-proxy)
//   - FAL_API_KEY                 (wardrobe/both WITHOUT a supplied alphaUrl —
//                                  used for SAM-3 body-parts segmentation + Fal CDN)
//
// Pricing (verified 2026-06-14 from developer.beeble.ai/pricing):
//   - 720p: $0.10 per 30 frames | 1080p: $0.30 per 30 frames
//   - Max 240 frames per job (~8s at 30fps), max 2.77 MP/frame
//   - Pay-as-you-go, $50 min topup
//
// ---------------------------------------------------------------------------
// THREE MODES
// ---------------------------------------------------------------------------
//   "background" (alias "auto") -> Beeble alpha_mode "auto"
//       Swap the BACKGROUND/scene only; subject + clothing preserved. The proven
//       path. Uses prompt + referenceImageUrl as the scene/lighting reference.
//       No mask generation.
//
//   "wardrobe" -> Beeble alpha_mode "custom"
//       Swap CLOTHING only, preserve face/skin/hair. We build a per-frame
//       grayscale alpha VIDEO from Fal SAM-3 (body-parts segmenter): the kept
//       regions (face, hands, hair, exposed skin, neck) are WHITE = preserve;
//       clothing (and background) is BLACK = regenerate. wardrobeReferenceImageUrl
//       drives the new costume (Beeble: reference carries "wardrobe/costumes",
//       applied into the BLACK regions). Prompt is wrapped to lock identity.
//
//   "both" -> two-pass chain (custom then auto)
//       Pass 1 = wardrobe (custom alpha, keep face/hands/hair/skin WHITE, clothes
//       + background BLACK) -> interim render. Pass 2 = background (auto) on the
//       interim render -> final. Returns BOTH urls. Multi-minute: REQUIRES the
//       callback_url (async) path, or sync only for a short probe clip.
//
// ALPHA POLARITY (Beeble custom mode, verified from beeble.ai/features/switchx
// + docs.beeble.ai/beeble/switchx):
//       WHITE = preserve (kept from source, relit/restyled)
//       BLACK = regenerate (generated from prompt + reference)
// Fal SAM-3 (apply_mask:false) returns the prompted regions as WHITE, which IS
// the correct "preserve" polarity for our keep-regions -> NO inversion needed in
// the happy path. `polarityOverride:"invert"` exists for the case the first probe
// shows the polarity reversed, BUT inverting a *video* is not possible in this
// runtime (no fal video-negate endpoint, no in-Deno H.264 encoder), so it throws
// with guidance — supply a pre-inverted alphaUrl instead. See SWITCHX_HANDOFF.md.
//
//   NOTE: this function does NOT touch audio. Lipsync/audio is preserved by the
//   downstream build, not here.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Caller-facing mode. "auto" is a back-compat alias for "background".
type SwitchXMode = "background" | "wardrobe" | "both" | "auto" | "custom";

// Beeble's alpha_mode enum (auto|fill|custom|select) is distinct from our
// caller-facing `mode`. background/auto -> "auto"; wardrobe -> "custom" (the real
// fix: "select" is a SAM3 subject-tracker that re-expands a skin seed to the full
// clothed silhouette, so it could never swap wardrobe). custom passes through for
// advanced callers supplying their own alpha. "both" is orchestration, not a
// single alpha_mode, so it's absent here.
const BEEBLE_ALPHA_MODE: Record<Exclude<SwitchXMode, "both">, string> = {
  background: "auto",
  auto: "auto",
  wardrobe: "custom",
  custom: "custom",
};

// SAM-3 segmenter prompt for wardrobe mode. We segment the GARMENT TARGET
// (jacket only for v1) with apply_mask:true, producing a video where the jacket
// region shows source pixels and everything else is BLACK. Beeble then either
// regenerates the BLACK region (if BLACK=regenerate polarity) or the visible
// region (if WHITE=preserve polarity). The first probe tells us which.
//
// Background diagnosis (ChatGPT + Grok, 2026-06-16): segmenting face/hands/etc
// as "preserve" leaves clothes AND background editable; the model takes the
// easier path of changing the background instead of the jacket. Targeting the
// jacket directly forces it into the editable zone.
const SAM_KEEP_PROMPTS = ["jacket"];

// Wardrobe prompt wrapper — locks identity, pose, and background; only the
// garment (the BLACK region driven by the reference costume) changes.
function buildWardrobePrompt(garment: string): string {
  return `Same subject, identical face, hair, pose, and background, wearing ${garment}`;
}

type Body = {
  sourceVideoUrl: string;
  prompt: string;
  mode?: SwitchXMode;
  referenceImageUrl?: string | null;
  // --- wardrobe / both ---
  wardrobeReferenceImageUrl?: string;
  alphaUrl?: string | null;
  keepMaskUrl?: string | null; // DEPRECATED alias for alphaUrl
  polarityOverride?: "auto" | "invert";
  // --- both ---
  backgroundReferenceImageUrl?: string;
  /**
   * Fire-and-forget submit (smoke tests, single mode only). When true (and no
   * callback_url), the function resolves the alpha, submits ONE Beeble job, and
   * returns `{ status: "queued", beeble_job_id, generation_metadata }`
   * immediately — WITHOUT polling. The caller polls `beeble-poll-debug?job_id=`.
   * Not supported for mode "both" (two sequential jobs — use callback_url, or let
   * the smoke script chain two queue_only single-mode calls).
   */
  queue_only?: boolean;
  /**
   * Async mode: return `{ status: 'queued' }` immediately and run the job(s) in
   * the background via EdgeRuntime.waitUntil, POSTing the result to callback_url
   * with the X-Proxy-Secret header. REQUIRED for "both" (multi-minute chain).
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
// "both" chains two jobs; give each pass its own budget inside the bg task.
const BOTH_PASS_TIMEOUT_MS = 480_000;

const FAL_QUEUE_BASE = "https://queue.fal.run";
// SAM-3 video segmentation (per-frame body-parts matte). apply_mask:false ->
// the segmented MASK video (prompted regions WHITE), not an overlay.
// Fal SAM-3 has two video endpoints:
//   /sam-3/video-rle  — returns per-frame RLE (no video file). Useless for us.
//   /sam-3/video      — returns an MP4 file with the mask applied. This is what
//                       we need for Beeble's custom-mode alpha_uri.
const FAL_SAM3_VIDEO_URL = `${FAL_QUEUE_BASE}/fal-ai/sam-3/video`;
const FAL_CDN_INITIATE_URL =
  "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3";

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

// Normalize caller mode + aliases to a canonical mode.
function normalizeMode(raw: unknown): SwitchXMode {
  switch (raw) {
    case "wardrobe":
      return "wardrobe";
    case "both":
      return "both";
    case "custom":
      return "custom";
    case "background":
    case "auto":
    case undefined:
    case null:
    case "":
      return "background";
    default:
      return "background";
  }
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

  // ---- cancel-fal-job action -------------------------------------------
  // Sends DELETE to a Fal queue cancel_url for an in-flight or queued job.
  // POST { action: "cancel-fal-job", cancel_url: "..." } → { ok }.
  if ((body as any).action === "cancel-fal-job") {
    const cancelUrl = (body as any).cancel_url ?? (body as any).status_url;
    if (!cancelUrl || typeof cancelUrl !== "string") {
      return json(400, { error: "cancel_missing_url" });
    }
    if (!falKey) {
      return json(500, { error: "server_misconfigured", detail: "FAL_API_KEY missing" });
    }
    try {
      // Fal's cancel endpoint is the status_url with /cancel appended, OR the
      // explicit cancel_url returned in the submission response. Try cancel_url
      // first; fall back to status_url/cancel.
      let target = cancelUrl;
      if (!target.endsWith("/cancel") && !target.includes("/cancel?")) {
        target = target.replace(/\/status\b/, "/cancel");
        if (target === cancelUrl) target = `${cancelUrl.replace(/\/$/, "")}/cancel`;
      }
      const resp = await fetch(target, {
        method: "PUT",
        headers: { Authorization: `Key ${falKey}` },
      });
      const text = await resp.text().catch(() => "");
      return json(200, {
        ok: resp.ok,
        status: resp.status,
        target,
        body: text.slice(0, 400),
      });
    } catch (err: any) {
      return json(502, {
        error: "cancel_failed",
        detail: String(err?.message ?? err).slice(0, 500),
      });
    }
  }

  // ---- vton-frame action -----------------------------------------------
  // Calls Fal IDM-VTON to transfer a specific garment image onto a person
  // image (per-frame virtual try-on). This is the new wardrobe truth engine
  // (replaces Beeble custom-mode for garment transfer; Beeble keeps the
  // temporal/background role). POST { action: "vton-frame", human_image_url,
  // garment_image_url, category: "upper_body" | "lower_body" | "dresses",
  // garment_description: "...", prompt: "..." (optional) } → { image_url }.
  if ((body as any).action === "vton-frame") {
    const humanUrl = (body as any).human_image_url;
    const garmentUrl = (body as any).garment_image_url;
    const category = (body as any).category ?? "upper_body";
    const garmentDescription = (body as any).garment_description ?? "garment";
    const vtonPrompt = (body as any).prompt;
    const vtonModel = (body as any).model ?? "idm-vton";
    if (!humanUrl || typeof humanUrl !== "string") {
      return json(400, { error: "vton_missing_human_image_url" });
    }
    if (!garmentUrl || typeof garmentUrl !== "string") {
      return json(400, { error: "vton_missing_garment_image_url" });
    }
    if (!falKey) {
      return json(500, { error: "server_misconfigured", detail: "FAL_API_KEY missing" });
    }
    try {
      let endpointUrl: string;
      let input: Record<string, unknown>;
      if (vtonModel === "cat-vton") {
        // CatVTON: cloth_type enum is upper/lower/overall/inner/outer.
        const clothTypeMap: Record<string, string> = {
          upper_body: "upper",
          lower_body: "lower",
          dresses: "overall",
          upper: "upper",
          lower: "lower",
          overall: "overall",
          inner: "inner",
          outer: "outer",
        };
        endpointUrl = "https://queue.fal.run/fal-ai/cat-vton";
        input = {
          human_image_url: humanUrl,
          garment_image_url: garmentUrl,
          cloth_type: clothTypeMap[category] ?? "upper",
          num_inference_steps: 50,
          guidance_scale: 2.5,
        };
      } else {
        // Default: IDM-VTON
        endpointUrl = "https://queue.fal.run/fal-ai/idm-vton";
        input = {
          human_image_url: humanUrl,
          garment_image_url: garmentUrl,
          category,
          garment_description: garmentDescription,
        };
        if (vtonPrompt && typeof vtonPrompt === "string") input.prompt = vtonPrompt;
      }

      const submitResp = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          Authorization: `Key ${falKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      if (!submitResp.ok) {
        return json(502, {
          error: "vton_submit_failed",
          detail: `${submitResp.status}: ${(await submitResp.text().catch(() => "")).slice(0, 500)}`,
        });
      }
      const { request_id, status_url, response_url } = await submitResp.json();

      // Always return queue handles immediately. VTON runs frequently exceed
      // Supabase Edge's 150s timeout, so client-side polling via fal-queue-poll
      // is the only reliable path.
      return json(200, {
        status: "queued",
        model: vtonModel,
        request_id,
        status_url,
        response_url,
      });
    } catch (err: any) {
      return json(502, {
        error: "vton_failed",
        detail: String(err?.message ?? err).slice(0, 500),
      });
    }
  }

  // ---- remove-bg action ------------------------------------------------
  // Calls Fal birefnet/v2 to background-remove a single image. Used to turn
  // product-shot screenshots into transparent-bg canonical garment assets so
  // the downstream compose-reference call sees the garment isolated, not the
  // product photo's scene context (which biases the editor toward sportswear).
  // POST { action: "remove-bg", image_url: "..." } → { image_url }.
  if ((body as any).action === "remove-bg") {
    const inputUrl = (body as any).image_url;
    if (!inputUrl || typeof inputUrl !== "string") {
      return json(400, { error: "remove_bg_missing_image_url" });
    }
    if (!falKey) {
      return json(500, { error: "server_misconfigured", detail: "FAL_API_KEY missing" });
    }
    try {
      const submitResp = await fetch(
        "https://queue.fal.run/fal-ai/birefnet/v2",
        {
          method: "POST",
          headers: {
            Authorization: `Key ${falKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            image_url: inputUrl,
            model: "General Use (Light)",
            operating_resolution: "1024x1024",
            refine_foreground: true,
            output_format: "png",
          }),
        },
      );
      if (!submitResp.ok) {
        return json(502, {
          error: "remove_bg_submit_failed",
          detail: `${submitResp.status}: ${(await submitResp.text().catch(() => "")).slice(0, 400)}`,
        });
      }
      const { request_id, status_url, response_url } = await submitResp.json();
      const result = await pollFalUntilDone(falKey, request_id, status_url, response_url, 60_000);
      const candidates = [
        result?.image?.url,
        result?.image_url,
        result?.images?.[0]?.url,
        result?.output?.url,
      ];
      const found = candidates.find((u): u is string => typeof u === "string" && u.length > 0);
      if (!found) {
        return json(502, {
          error: "remove_bg_no_image",
          detail: `keys=${JSON.stringify(Object.keys(result || {}))}`,
        });
      }
      return json(200, { image_url: found });
    } catch (err: any) {
      return json(502, {
        error: "remove_bg_failed",
        detail: String(err?.message ?? err).slice(0, 500),
      });
    }
  }

  // ---- compose-reference action --------------------------------------
  // Calls Fal seedream/v4/edit to composite an outfit onto a subject. Used to
  // generate a "subject-wearing-target-jacket" reference for Beeble so it
  // anchors identity AND outfit instead of hallucinating a body from the
  // garment reference. POST { action: "compose-reference", image_urls: [...],
  // prompt: "..." } — returns { image_url }.
  if ((body as any).action === "compose-reference") {
    const imageUrls = (body as any).image_urls;
    const composePrompt = (body as any).prompt;
    if (!Array.isArray(imageUrls) || imageUrls.length < 1) {
      return json(400, { error: "compose_reference_missing_image_urls" });
    }
    if (!composePrompt || typeof composePrompt !== "string") {
      return json(400, { error: "compose_reference_missing_prompt" });
    }
    if (!falKey) {
      return json(500, { error: "server_misconfigured", detail: "FAL_API_KEY missing" });
    }
    try {
      const submitResp = await fetch(
        "https://queue.fal.run/fal-ai/bytedance/seedream/v4/edit",
        {
          method: "POST",
          headers: {
            Authorization: `Key ${falKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt: composePrompt,
            image_urls: imageUrls,
            image_size: "auto_2K",
            num_images: 1,
            max_images: 1,
            enable_safety_checker: false,
          }),
        },
      );
      if (!submitResp.ok) {
        return json(502, {
          error: "compose_submit_failed",
          detail: `${submitResp.status}: ${(await submitResp.text().catch(() => "")).slice(0, 500)}`,
        });
      }
      const { request_id, status_url, response_url } = await submitResp.json();
      const result = await pollFalUntilDone(falKey, request_id, status_url, response_url, 120_000);
      const candidates = [
        result?.images?.[0]?.url,
        result?.image?.url,
        result?.image_url,
        result?.output?.url,
        result?.url,
      ];
      const found = candidates.find((u): u is string => typeof u === "string" && u.length > 0);
      if (!found) {
        return json(502, {
          error: "compose_no_image",
          detail: `keys=${JSON.stringify(Object.keys(result || {}))} sample=${JSON.stringify(result).slice(0, 400)}`,
        });
      }
      return json(200, { image_url: found });
    } catch (err: any) {
      return json(502, {
        error: "compose_failed",
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

  const mode = normalizeMode(body.mode);
  // alphaUrl is canonical; keepMaskUrl is the deprecated alias.
  const suppliedAlphaUrl = body.alphaUrl ?? body.keepMaskUrl ?? null;
  const polarityOverride = body.polarityOverride === "invert" ? "invert" : "auto";

  // ---- per-mode validation ---------------------------------------------
  if (mode === "wardrobe" || mode === "both") {
    if (!body.wardrobeReferenceImageUrl || typeof body.wardrobeReferenceImageUrl !== "string") {
      return json(400, { error: "missing_wardrobe_reference_image_url" });
    }
    // Need FAL_API_KEY only to GENERATE the alpha. If alphaUrl is supplied we
    // can run with no Fal dependency at all.
    if (!suppliedAlphaUrl && !falKey) {
      return json(400, {
        error: "alpha_required",
        detail:
          "wardrobe/both needs either alphaUrl (a per-frame grayscale alpha VIDEO, " +
          "Beeble polarity: WHITE=preserve, BLACK=regenerate) or FAL_API_KEY configured " +
          "so the alpha can be auto-generated from the source via SAM-3.",
      });
    }
  }

  // "both" is a multi-minute two-job chain. queue_only can't represent two jobs
  // with one id, so require either callback_url (production async) or sync (short
  // probe clips only).
  if (mode === "both" && body.queue_only && !body.callback_url) {
    return json(400, {
      error: "both_requires_callback_or_sync",
      detail:
        "mode 'both' chains two sequential Beeble jobs and cannot run as queue_only. " +
        "Use callback_url (async, recommended) or omit queue_only for a sync probe clip. " +
        "The smoke script chains two queue_only single-mode calls instead.",
    });
  }

  // ---- single-mode execution -------------------------------------------
  // pollForResult=false -> resolve alpha + submit, return job id, skip polling.
  const executeSingle = async (pollForResult: boolean): Promise<Response> => {
    let resolvedAlphaUrl: string | null = suppliedAlphaUrl;
    let alphaGenerated = false;
    if (mode === "wardrobe" && !resolvedAlphaUrl) {
      try {
        resolvedAlphaUrl = await generateBodyPartsAlphaVideo(falKey, body.sourceVideoUrl, {
          keepPrompts: SAM_KEEP_PROMPTS,
          polarityOverride,
        });
        alphaGenerated = true;
      } catch (err: any) {
        return json(502, {
          error: "alpha_generation_failed",
          detail: String(err?.message ?? err).slice(0, 500),
        });
      }
    }

    let submit: BeebleSubmitResp;
    try {
      submit = await submitSwitchXJob(beebleKey, {
        sourceVideoUrl: body.sourceVideoUrl,
        prompt: body.prompt,
        // executeSingle is never reached for "both" (routed to executeBoth, and
        // "both"+queue_only is rejected earlier), so the cast is safe.
        mode: mode as Exclude<SwitchXMode, "both">,
        referenceImageUrl: body.referenceImageUrl ?? null,
        wardrobeReferenceImageUrl: body.wardrobeReferenceImageUrl ?? null,
        alphaUrl: resolvedAlphaUrl,
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
      beeble_alpha_mode: BEEBLE_ALPHA_MODE[mode as Exclude<SwitchXMode, "both">],
      source_video_url: body.sourceVideoUrl,
      reference_image_url: body.referenceImageUrl ?? null,
      wardrobe_reference_image_url: body.wardrobeReferenceImageUrl ?? null,
      alpha_url: resolvedAlphaUrl,
      alpha_generated: alphaGenerated,
      polarity_override: polarityOverride,
      prompt: body.prompt,
    };

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
      return json(502, { error: "beeble_no_render_url", beeble_job_id: jobId });
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

  // ---- "both" execution (two-pass chain) -------------------------------
  // Pass 1: wardrobe (custom) -> interim render. Pass 2: background (auto) on the
  // interim render -> final. Polls each pass to completion, so this only runs in
  // the async (callback) path or a sync probe — never queue_only.
  const executeBoth = async (): Promise<Response> => {
    // --- alpha for pass 1 ---
    let resolvedAlphaUrl: string | null = suppliedAlphaUrl;
    let alphaGenerated = false;
    if (!resolvedAlphaUrl) {
      try {
        resolvedAlphaUrl = await generateBodyPartsAlphaVideo(falKey, body.sourceVideoUrl, {
          keepPrompts: SAM_KEEP_PROMPTS,
          polarityOverride,
        });
        alphaGenerated = true;
      } catch (err: any) {
        return json(502, {
          error: "alpha_generation_failed",
          detail: String(err?.message ?? err).slice(0, 500),
        });
      }
    }

    // --- pass 1: wardrobe (custom) ---
    let wardrobeJobId = "";
    let interimUrl = "";
    let wardrobeFrames = 0;
    let wardrobeRes = "1080p";
    try {
      const submit1 = await submitSwitchXJob(beebleKey, {
        sourceVideoUrl: body.sourceVideoUrl,
        prompt: body.prompt,
        mode: "wardrobe",
        referenceImageUrl: null,
        wardrobeReferenceImageUrl: body.wardrobeReferenceImageUrl ?? null,
        alphaUrl: resolvedAlphaUrl,
      });
      wardrobeJobId = submit1?.id ?? "";
      if (!wardrobeJobId) {
        return json(502, { error: "both_pass1_no_job_id", detail: JSON.stringify(submit1).slice(0, 300) });
      }
      const final1 = await pollBeebleUntilDone(beebleKey, wardrobeJobId, BOTH_PASS_TIMEOUT_MS);
      if (final1.status === "failed") {
        return json(502, {
          error: "both_pass1_failed",
          detail: final1.error?.message ?? "unknown",
          wardrobe_job_id: wardrobeJobId,
        });
      }
      interimUrl = final1.result?.render ?? "";
      wardrobeFrames = final1.result?.frames_processed ?? 0;
      wardrobeRes = (final1.result?.resolution ?? "1080p").toLowerCase();
      if (!interimUrl) {
        return json(502, { error: "both_pass1_no_render_url", wardrobe_job_id: wardrobeJobId });
      }
    } catch (err: any) {
      return json(502, {
        error: "both_pass1_error",
        detail: String(err?.message ?? err).slice(0, 500),
        wardrobe_job_id: wardrobeJobId || undefined,
      });
    }

    // --- pass 2: background (auto) on the interim render ---
    let backgroundJobId = "";
    let finalUrl = "";
    let bgFrames = 0;
    let bgRes = "720p";
    try {
      const submit2 = await submitSwitchXJob(beebleKey, {
        sourceVideoUrl: interimUrl,
        prompt: body.prompt,
        mode: "background",
        referenceImageUrl: body.backgroundReferenceImageUrl ?? body.referenceImageUrl ?? null,
        wardrobeReferenceImageUrl: null,
        alphaUrl: null,
      });
      backgroundJobId = submit2?.id ?? "";
      if (!backgroundJobId) {
        return json(502, {
          error: "both_pass2_no_job_id",
          detail: JSON.stringify(submit2).slice(0, 300),
          wardrobe_job_id: wardrobeJobId,
          interim_video_url: interimUrl,
        });
      }
      const final2 = await pollBeebleUntilDone(beebleKey, backgroundJobId, BOTH_PASS_TIMEOUT_MS);
      if (final2.status === "failed") {
        return json(502, {
          error: "both_pass2_failed",
          detail: final2.error?.message ?? "unknown",
          background_job_id: backgroundJobId,
          interim_video_url: interimUrl,
        });
      }
      finalUrl = final2.result?.render ?? "";
      bgFrames = final2.result?.frames_processed ?? 0;
      bgRes = (final2.result?.resolution ?? "720p").toLowerCase();
      if (!finalUrl) {
        return json(502, {
          error: "both_pass2_no_render_url",
          background_job_id: backgroundJobId,
          interim_video_url: interimUrl,
        });
      }
    } catch (err: any) {
      return json(502, {
        error: "both_pass2_error",
        detail: String(err?.message ?? err).slice(0, 500),
        wardrobe_job_id: wardrobeJobId,
        background_job_id: backgroundJobId || undefined,
        interim_video_url: interimUrl,
      });
    }

    const costCents =
      estimateCostCents(wardrobeFrames, wardrobeRes) + estimateCostCents(bgFrames, bgRes);

    return json(200, {
      output_video_url: finalUrl,
      interim_video_url: interimUrl,
      wardrobe_job_id: wardrobeJobId,
      background_job_id: backgroundJobId,
      frames_processed: bgFrames,
      cost_cents: costCents,
      generation_metadata: {
        mode: "both",
        source_video_url: body.sourceVideoUrl,
        wardrobe_reference_image_url: body.wardrobeReferenceImageUrl ?? null,
        background_reference_image_url:
          body.backgroundReferenceImageUrl ?? body.referenceImageUrl ?? null,
        alpha_url: resolvedAlphaUrl,
        alpha_generated: alphaGenerated,
        polarity_override: polarityOverride,
        prompt: body.prompt,
        wardrobe_resolution: wardrobeRes,
        background_resolution: bgRes,
      },
    });
  };

  const execute = (pollForResult: boolean): Promise<Response> =>
    mode === "both" ? executeBoth() : executeSingle(pollForResult);

  // QUEUE-ONLY MODE — single mode only; submit + return job id.
  if (body.queue_only && !body.callback_url) {
    return await executeSingle(false);
  }

  // ASYNC MODE — return 200 queued immediately, finish in background.
  if (body.callback_url) {
    const callbackUrl = body.callback_url;
    const background = (async () => {
      let resp: Response;
      try {
        resp = await execute(true);
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
          interim_video_url: parsed.interim_video_url,
          frames_processed: parsed.frames_processed,
          cost_cents: parsed.cost_cents,
          beeble_job_id: parsed.beeble_job_id,
          wardrobe_job_id: parsed.wardrobe_job_id,
          background_job_id: parsed.background_job_id,
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

  // SYNC MODE — for curl smoke tests only. 140s ceiling ("both" only fits for a
  // short probe clip).
  return await execute(true);
});

// ---------------------------------------------------------------------------
// Beeble SwitchX API helpers
// ---------------------------------------------------------------------------
async function submitSwitchXJob(
  apiKey: string,
  input: {
    sourceVideoUrl: string;
    prompt: string;
    mode: Exclude<SwitchXMode, "both">;
    referenceImageUrl?: string | null;
    wardrobeReferenceImageUrl?: string | null;
    alphaUrl?: string | null;
  },
): Promise<BeebleSubmitResp> {
  // Beeble API request body. Field names per the live OpenAPI spec
  // (api.beeble.ai/v1/openapi.json, schema CreateSwitchXRequest). Flat top-level
  // *_uri fields; Beeble accepts plain signed HTTPS URLs. Required:
  // generation_type, source_uri, alpha_mode (+ at least one of prompt /
  // reference_image_uri). max_resolution is an integer: 720 or 1080 (default
  // 1080). alpha_keyframe_index is SELECT-only and ignored for custom — we don't
  // send it.
  const isWardrobe = input.mode === "wardrobe";
  const requestBody: Record<string, unknown> = {
    generation_type: "video",
    source_uri: input.sourceVideoUrl,
    prompt: isWardrobe ? buildWardrobePrompt(input.prompt) : input.prompt,
    alpha_mode: BEEBLE_ALPHA_MODE[input.mode],
    // 720 = cheaper (10c/30f); wardrobe runs at 1080 so the garment swap holds
    // fine detail.
    max_resolution: isWardrobe ? 1080 : 720,
  };

  if (isWardrobe || input.mode === "custom") {
    // Custom alpha path: caller-facing wardrobe, or raw custom passthrough.
    if (!input.alphaUrl) {
      throw new Error(`${input.mode}_missing_alpha_uri`);
    }
    requestBody.alpha_uri = input.alphaUrl;
    // reference_image_uri carries the new costume (Beeble applies wardrobe from
    // the reference into the BLACK/regenerate region). For wardrobe that's the
    // outfit ref; for raw custom it's the optional style ref.
    const ref = isWardrobe ? input.wardrobeReferenceImageUrl : input.referenceImageUrl;
    if (ref) requestBody.reference_image_uri = ref;
  } else if (input.referenceImageUrl) {
    // background / auto: scene/lighting reference only.
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
// Body-parts alpha VIDEO generation (wardrobe/both, when no alphaUrl supplied)
//
// Pipeline:
//   1. Submit the source video to Fal SAM-3 video-rle with the keep-region
//      prompts (comma-separated). apply_mask:false -> a segmented MASK video
//      where the prompted regions are WHITE and everything else is BLACK.
//   2. That polarity (WHITE=prompted=preserve) IS Beeble custom's required
//      polarity, so we pass it straight through as alpha_uri.
//
// POLARITY OVERRIDE: if the first probe shows the polarity reversed,
// polarityOverride:"invert" is requested. We CANNOT invert a video in this
// runtime — there is no fal video-negate/filter endpoint and no in-Deno H.264
// encoder. So we throw with guidance: supply a pre-inverted alphaUrl instead
// (the Nuke/AE workflow Beeble's own docs reference). See SWITCHX_HANDOFF.md.
//
// FORMAT NOTE: Beeble custom wants the alpha to match the source frame
// count / fps / resolution (<=240 frames, <=2.77 MP/frame). SAM-3 processes the
// source so frame count/fps track; if SAM-3 downscales the matte, verify on the
// first probe and re-host a matched-resolution alpha if Beeble rejects it.
// ---------------------------------------------------------------------------
async function generateBodyPartsAlphaVideo(
  falKey: string,
  sourceVideoUrl: string,
  opts: { keepPrompts: string[]; polarityOverride: "auto" | "invert" },
): Promise<string> {
  if (!falKey) throw new Error("fal_api_key_missing");
  if (opts.polarityOverride === "invert") {
    throw new Error(
      "polarity_invert_unsupported: cannot invert an alpha VIDEO in this runtime " +
        "(no fal video-negate endpoint, no in-Deno H.264 encoder). Supply a " +
        "pre-inverted alphaUrl (Beeble polarity: WHITE=preserve, BLACK=regenerate).",
    );
  }

  const samVideoUrl = await falSam3VideoMask(falKey, sourceVideoUrl, opts.keepPrompts.join(", "));
  if (!samVideoUrl) throw new Error("sam3_video_no_mask");
  return samVideoUrl;
}

// Fal SAM-3 video-rle text-prompted segmentation. Returns the segmented MASK
// video URL (prompted regions WHITE). `prompt` is a single comma-separated
// string per the fal sam-3/video-rle schema; apply_mask:false yields the matte
// rather than an overlay.
async function falSam3VideoMask(
  falKey: string,
  videoUrl: string,
  prompt: string,
): Promise<string | null> {
  const submitResp = await fetch(FAL_SAM3_VIDEO_URL, {
    method: "POST",
    headers: { Authorization: `Key ${falKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      video_url: videoUrl,
      prompt,
      apply_mask: true, // mask applied → segmented regions visible, rest black
      video_output_type: "X264 (.mp4)",
      detection_threshold: 0.5,
    }),
  });
  if (!submitResp.ok) {
    throw new Error(`sam3_video_submit_${submitResp.status}: ${await submitResp.text().catch(() => "")}`);
  }
  const { request_id, status_url, response_url } = await submitResp.json();
  // SAM-3 video segmentation of a 5s clip runs longer than image; give it 300s.
  const result = await pollFalUntilDone(falKey, request_id, status_url, response_url, 300_000);

  // SAM-3 video-rle response shape isn't well documented; try every reasonable
  // field name. If still null, raise an error with the actual top-level keys
  // so we can patch the extraction without guessing.
  const candidates = [
    result?.video?.url,
    result?.video_url,
    result?.image?.url,
    result?.output_video?.url,
    result?.output?.url,
    result?.output?.video?.url,
    result?.mask_video?.url,
    result?.mask?.url,
    result?.masks?.[0]?.url,
    result?.masks?.[0]?.video?.url,
    result?.file?.url,
    result?.url,
  ];
  const found = candidates.find((u): u is string => typeof u === "string" && u.length > 0);
  if (found) return found;

  // Surface the response shape so we can debug.
  const keysTop = result && typeof result === "object" ? Object.keys(result) : [];
  const keysOutput = result?.output && typeof result.output === "object"
    ? Object.keys(result.output) : null;
  throw new Error(
    `sam3_video_no_mask_shape_unknown: keys_top=${JSON.stringify(keysTop)} ` +
      `keys_output=${JSON.stringify(keysOutput)} ` +
      `sample=${JSON.stringify(result).slice(0, 600)}`,
  );
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

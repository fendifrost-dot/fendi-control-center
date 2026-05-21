// CC edge function -- compose-look
//
// Pure Fal orchestrator. AVT-side data access (caller auth, feature
// resolution, URL signing, storage upload, artist_looks insert) is owned
// by the compose-look-proxy edge function on the AVT side.
//
// Boundary contract:
//   Header:  X-Proxy-Secret (must equal COMPOSE_LOOK_PROXY_SECRET)
//   Input:   { recipe, signedUrls, loraUrl?, triggerWord? }
//   Output:  { fal_image_url, pipeline_used, cost_cents, generation_metadata }
//
// Env vars required:
//   - FAL_API_KEY
//   - COMPOSE_LOOK_PROXY_SECRET   (shared with AVT proxy)
//
// Removed in this refactor: AVT_SUPABASE_URL, AVT_SUPABASE_ANON_KEY,
// AVT_SUPABASE_SERVICE_ROLE_KEY. CC no longer touches AVT's database or
// storage; it only talks to Fal.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  buildBasePhotoPrompt,
  buildComposePrompt,
  constantTimeEqual,
  decidePipeline,
  type PipelineMode,
  type ResolvedFeatureLite,
} from "./helpers.ts";

type SignedUrls = {
  face?: string | null;
  wardrobe?: string[];
  jewelry?: string[];
  location?: string | null;
  props?: string[];
};

// Per-wardrobe-item passthrough for the lora_idm_vton pipeline. The proxy
// signs the FRONT-most reference image per wardrobe pick and forwards it
// here so CC can chain a sequence of IDM-VTON calls (one garment overlay
// per item) on top of the Stage 1 LoRA base photo. Older pipelines
// (lora_seedream, seedream_only, kontext_multi) ignore this field; they
// continue to read from signedUrls.wardrobe.
type WardrobeItemPassthrough = {
  feature_type: string;
  label: string;
  signed_url: string;
  dimensions_description?: string | null;
};

type Recipe = {
  artistId: string;
  faceFeatureId?: string;
  wardrobeFeatureIds?: string[];
  jewelryFeatureIds?: string[];
  locationId?: string;
  propIds?: string[];
  basePrompt: string;
  stylingNotes?: string | null;
  pipelinePreference?: PipelineMode;
  wardrobeLabels?: string[];
  wardrobeItems?: WardrobeItemPassthrough[];
  jewelryLabels?: string[];
  hasLocation?: boolean;
  hasFace?: boolean;
  propCount?: number;
};

type Body = {
  recipe: Recipe;
  signedUrls: SignedUrls;
  loraUrl?: string;
  triggerWord?: string;
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

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  // ---- env --------------------------------------------------------------
  const falKey = Deno.env.get("FAL_API_KEY") ?? "";
  const proxySecret = Deno.env.get("COMPOSE_LOOK_PROXY_SECRET") ?? "";
  if (!falKey || !proxySecret) {
    return json(500, { error: "server_misconfigured" });
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
  const recipe = body?.recipe;
  const signedUrls: SignedUrls = body?.signedUrls ?? {};
  if (!recipe?.basePrompt || recipe.basePrompt.trim().length < 4) {
    return json(400, { error: "basePrompt_too_short" });
  }

  // ---- pipeline selection ----------------------------------------------
  const requested = (recipe.pipelinePreference ?? "auto") as PipelineMode;
  const pipeline = decidePipeline(
    requested,
    !!(body.loraUrl && body.triggerWord),
  );

  // Lite feature objects from labels so the existing prompt helpers work
  // without AVT-side ResolvedFeature rows.
  const wardrobeLite: ResolvedFeatureLite[] = (recipe.wardrobeLabels ?? [])
    .filter(Boolean)
    .map((label) => ({ label }));
  const jewelryLite: ResolvedFeatureLite[] = (recipe.jewelryLabels ?? [])
    .filter(Boolean)
    .map((label) => ({ label }));
  const hasLocation = !!signedUrls.location || !!recipe.hasLocation;

  const stages: Array<{ stage: string; request_id?: string; image_url?: string }> = [];
  let costCents = 0;
  let falImageUrl: string | null = null;

  try {
    if (pipeline === "lora_seedream") {
      if (!body.loraUrl) {
        return json(400, { error: "lora_required_for_lora_seedream" });
      }
      const flux = await callFalFluxLora(falKey, {
        prompt: buildBasePhotoPrompt(
          body.triggerWord ?? "",
          recipe.basePrompt,
          recipe.stylingNotes ?? undefined,
        ),
        loraUrl: body.loraUrl,
        loraScale: 1.0,
      });
      stages.push({
        stage: "flux_lora",
        request_id: flux.request_id,
        image_url: flux.image_url,
      });
      costCents += 5;

      const imageUrls: string[] = [flux.image_url];
      imageUrls.push(...(signedUrls.wardrobe ?? []).slice(0, 2));
      if (signedUrls.location && imageUrls.length < 4) {
        imageUrls.push(signedUrls.location);
      }
      const compose = await callFalSeedreamEdit(falKey, {
        prompt: buildComposePrompt(
          recipe.basePrompt,
          recipe.stylingNotes ?? undefined,
          wardrobeLite,
          jewelryLite,
          hasLocation,
        ),
        imageUrls: imageUrls.slice(0, 4),
      });
      stages.push({
        stage: "seedream_edit",
        request_id: compose.request_id,
        image_url: compose.image_url,
      });
      costCents += 4;
      falImageUrl = compose.image_url;
    } else if (pipeline === "lora_idm_vton") {
      // ---------------------------------------------------------------
      // lora_idm_vton — Stage 1 (FLUX LoRA) generates a canonical base
      // photo of the artist with identity preamble baked in, then a
      // chain of IDM-VTON calls overlays each wardrobe garment on top.
      // Each VTON output feeds into the next as the "human_image_url",
      // so multiple garments compose cleanly.
      //
      // Footwear and accessories are skipped (IDM-VTON only handles
      // upper_body and lower_body garments). Items in those categories
      // continue to appear via the Stage 1 LoRA base photo (the
      // identity preamble locks eyewear, etc.) rather than via VTON.
      // ---------------------------------------------------------------
      if (!body.loraUrl) {
        return json(400, { error: "lora_required_for_lora_idm_vton" });
      }
      const flux = await callFalFluxLora(falKey, {
        prompt: buildBasePhotoPrompt(
          body.triggerWord ?? "",
          recipe.basePrompt,
          recipe.stylingNotes ?? undefined,
        ),
        loraUrl: body.loraUrl,
        loraScale: 1.0,
      });
      stages.push({
        stage: "flux_lora",
        request_id: flux.request_id,
        image_url: flux.image_url,
      });
      costCents += 5;

      // Build the list of garments to overlay. Prefer the per-item
      // passthrough (post-Phase-3 proxy); if it's missing (old proxy),
      // fall back to a best-effort using the flat signedUrls.wardrobe
      // + wardrobeLabels parallel arrays, assuming upper_body — the
      // most common case for outerwear/top picks.
      const garments: Array<{
        feature_type: string;
        label: string;
        signed_url: string;
      }> = [];
      if (Array.isArray(recipe.wardrobeItems) && recipe.wardrobeItems.length > 0) {
        for (const it of recipe.wardrobeItems) {
          if (it && it.signed_url) {
            garments.push({
              feature_type: it.feature_type ?? "wardrobe_top",
              label: it.label ?? "",
              signed_url: it.signed_url,
            });
          }
        }
      } else {
        // Fallback path. Pair flat wardrobe URLs with wardrobeLabels
        // (same order). Without feature_type we can't reliably skip
        // accessories, so include everything as upper_body — Phase 2
        // smoke tests will catch any miscategorization.
        const urls = signedUrls.wardrobe ?? [];
        const labels = recipe.wardrobeLabels ?? [];
        for (let i = 0; i < urls.length; i++) {
          garments.push({
            feature_type: "wardrobe_top",
            label: labels[i] ?? "",
            signed_url: urls[i],
          });
        }
      }

      // Filter to VTON-eligible categories. Outerwear and tops go in
      // as upper_body; bottoms go in as lower_body. Footwear and
      // accessories are skipped — accessories survive via the LoRA
      // Stage 1 base photo when the identity preamble references them
      // (e.g. eyewear lock); footwear is out of scope for the current
      // VTON endpoint (Leffa supports upper_body / lower_body / dresses
      // only). When the user picks footwear we silently skip it here —
      // a later iteration can rope shoes back in via a Seedream polish
      // pass if needed.
      const vtonEligible = garments.filter((g) => {
        const t = g.feature_type;
        return t === "wardrobe_outerwear" || t === "wardrobe_top" || t === "wardrobe_bottom";
      });

      // Chain order matters: each VTON call takes the previous output as
      // its human_image_url. We want layered composition where jackets
      // sit OVER shirts, so within the upper body we run TOP first then
      // OUTERWEAR. Bottoms come last (they're a separate region, but
      // running them last keeps stage indexing readable for the audit
      // log). Footwear/accessory items have already been filtered out.
      const orderPriority: Record<string, number> = {
        wardrobe_top: 0,
        wardrobe_outerwear: 1,
        wardrobe_bottom: 2,
      };
      vtonEligible.sort(
        (a, b) =>
          (orderPriority[a.feature_type] ?? 99) -
          (orderPriority[b.feature_type] ?? 99),
      );

      let currentHumanUrl: string = flux.image_url;
      for (let i = 0; i < vtonEligible.length; i++) {
        const g = vtonEligible[i];
        // Leffa accepts a strict garment_type enum: upper_body, lower_body,
        // dresses. We don't currently surface "dresses" because the
        // wardrobe schema doesn't have a wardrobe_dress feature_type;
        // when it does, add the mapping here.
        const garmentType =
          g.feature_type === "wardrobe_bottom" ? "lower_body" : "upper_body";
        const vton = await callFalLeffaVton(falKey, {
          humanImageUrl: currentHumanUrl,
          garmentImageUrl: g.signed_url,
          garmentType,
        });
        stages.push({
          stage: `leffa_vton_${i + 1}_${garmentType}`,
          request_id: vton.request_id,
          image_url: vton.image_url,
        });
        costCents += 5;
        currentHumanUrl = vton.image_url;
      }

      // If no eligible garments (e.g. only accessories picked), the
      // final result is the Stage 1 LoRA output — accessories are
      // already locked into identity-preamble so the LoRA photo IS
      // the look.
      falImageUrl = currentHumanUrl;
    } else if (pipeline === "seedream_only") {
      const imageUrls: string[] = [];
      if (signedUrls.face) imageUrls.push(signedUrls.face);
      imageUrls.push(...(signedUrls.wardrobe ?? []).slice(0, 2));
      if (signedUrls.location && imageUrls.length < 4) {
        imageUrls.push(signedUrls.location);
      }
      if (imageUrls.length === 0) {
        return json(400, { error: "no_references_provided" });
      }
      const compose = await callFalSeedreamEdit(falKey, {
        prompt: buildComposePrompt(
          recipe.basePrompt,
          recipe.stylingNotes ?? undefined,
          wardrobeLite,
          jewelryLite,
          hasLocation,
        ),
        imageUrls: imageUrls.slice(0, 4),
      });
      stages.push({
        stage: "seedream_edit",
        request_id: compose.request_id,
        image_url: compose.image_url,
      });
      costCents += 4;
      falImageUrl = compose.image_url;
    } else if (pipeline === "kontext_multi") {
      const imageUrls: string[] = [];
      if (signedUrls.face) imageUrls.push(signedUrls.face);
      imageUrls.push(...(signedUrls.wardrobe ?? []).slice(0, 2));
      if (signedUrls.location && imageUrls.length < 4) {
        imageUrls.push(signedUrls.location);
      }
      if (imageUrls.length === 0) {
        return json(400, { error: "no_references_provided" });
      }
      const compose = await callFalFluxKontextMulti(falKey, {
        prompt: buildComposePrompt(
          recipe.basePrompt,
          recipe.stylingNotes ?? undefined,
          wardrobeLite,
          jewelryLite,
          hasLocation,
        ),
        imageUrls: imageUrls.slice(0, 4),
      });
      stages.push({
        stage: "kontext_multi",
        request_id: compose.request_id,
        image_url: compose.image_url,
      });
      costCents += 4;
      falImageUrl = compose.image_url;
    } else {
      return json(400, { error: "unknown_pipeline", pipeline });
    }
  } catch (err: any) {
    return json(502, {
      error: "fal_error",
      detail: String(err?.message ?? err),
      stages,
    });
  }

  if (!falImageUrl) {
    return json(502, { error: "fal_no_image", stages });
  }

  return json(200, {
    fal_image_url: falImageUrl,
    pipeline_used: pipeline,
    cost_cents: costCents,
    generation_metadata: {
      stages,
      recipe_summary: {
        hasFace: recipe.hasFace ?? !!signedUrls.face,
        hasLocation,
        wardrobeLabels: recipe.wardrobeLabels ?? [],
        jewelryLabels: recipe.jewelryLabels ?? [],
        propCount: recipe.propCount ?? (signedUrls.props?.length ?? 0),
      },
    },
  });
});

// ---------------------------------------------------------------------------
// Fal call helpers (preserved verbatim from prior version)
// ---------------------------------------------------------------------------
async function callFalFluxLora(
  apiKey: string,
  input: { prompt: string; loraUrl: string; loraScale: number },
): Promise<FalImageResult> {
  const submitResp = await fetch("https://queue.fal.run/fal-ai/flux-lora", {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: input.prompt,
      loras: [{ path: input.loraUrl, scale: input.loraScale }],
      image_size: "portrait_4_3",
      num_inference_steps: 28,
      guidance_scale: 3.5,
      num_images: 1,
      output_format: "png",
      enable_safety_checker: false,
    }),
  });
  if (!submitResp.ok) {
    throw new Error(`flux_lora_submit_${submitResp.status}: ${await submitResp.text().catch(() => "")}`);
  }
  const { request_id, status_url, response_url } = await submitResp.json();
  const result = await pollFalUntilDone(apiKey, request_id, status_url, response_url);
  const url = result?.images?.[0]?.url;
  if (!url) throw new Error("flux_lora_no_image");
  return { request_id, image_url: url };
}

async function callFalSeedreamEdit(
  apiKey: string,
  input: { prompt: string; imageUrls: string[] },
): Promise<FalImageResult> {
  if (input.imageUrls.length === 0) throw new Error("seedream_no_inputs");
  const submitResp = await fetch("https://queue.fal.run/fal-ai/bytedance/seedream/v4/edit", {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: input.prompt,
      image_urls: input.imageUrls,
      image_size: "portrait_4_3",
      num_images: 1,
      enable_safety_checker: false,
      output_format: "png",
    }),
  });
  if (!submitResp.ok) {
    throw new Error(`seedream_submit_${submitResp.status}: ${await submitResp.text().catch(() => "")}`);
  }
  const { request_id, status_url, response_url } = await submitResp.json();
  const result = await pollFalUntilDone(apiKey, request_id, status_url, response_url);
  const url = result?.images?.[0]?.url;
  if (!url) throw new Error("seedream_no_image");
  return { request_id, image_url: url };
}

// Leffa Virtual Try-On (fal-ai/leffa/virtual-tryon). Garment-overlay
// VTON with an explicit category enum, which is the key thing we
// needed beyond IDM-VTON: routing bottoms to lower_body so jeans
// render as pants instead of getting mis-applied to the torso.
//
// Request body:
//   - human_image_url:        string (required)
//   - garment_image_url:      string (required)
//   - garment_type:           "upper_body" | "lower_body" | "dresses" (required)
//   - num_inference_steps:    int (optional, default 50)
//   - guidance_scale:         float (optional, default 2.5)
//   - seed:                   int (optional)
//   - enable_safety_checker:  bool (optional, default true)
//   - output_format:          "jpeg" | "png" (optional, default png)
//
// Response: { image: { url, content_type, width, height, ... }, seed,
//             has_nsfw_concepts } — same `image.url` extraction pattern
// as the other helpers.
async function callFalLeffaVton(
  apiKey: string,
  input: {
    humanImageUrl: string;
    garmentImageUrl: string;
    garmentType: "upper_body" | "lower_body" | "dresses";
  },
): Promise<FalImageResult> {
  if (!input.humanImageUrl) throw new Error("leffa_vton_no_human_image");
  if (!input.garmentImageUrl) throw new Error("leffa_vton_no_garment_image");
  const submitResp = await fetch("https://queue.fal.run/fal-ai/leffa/virtual-tryon", {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      human_image_url: input.humanImageUrl,
      garment_image_url: input.garmentImageUrl,
      garment_type: input.garmentType,
      output_format: "png",
      enable_safety_checker: false,
    }),
  });
  if (!submitResp.ok) {
    throw new Error(`leffa_vton_submit_${submitResp.status}: ${await submitResp.text().catch(() => "")}`);
  }
  const { request_id, status_url, response_url } = await submitResp.json();
  const result = await pollFalUntilDone(apiKey, request_id, status_url, response_url);
  const url = result?.image?.url ?? result?.images?.[0]?.url;
  if (!url) throw new Error("leffa_vton_no_image");
  return { request_id, image_url: url };
}

async function callFalFluxKontextMulti(
  apiKey: string,
  input: { prompt: string; imageUrls: string[] },
): Promise<FalImageResult> {
  if (input.imageUrls.length === 0) throw new Error("kontext_no_inputs");
  const submitResp = await fetch("https://queue.fal.run/fal-ai/flux-pro/kontext/multi", {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: input.prompt,
      image_urls: input.imageUrls.slice(0, 4),
      aspect_ratio: "3:4",
      output_format: "png",
      num_images: 1,
    }),
  });
  if (!submitResp.ok) {
    throw new Error(`kontext_submit_${submitResp.status}: ${await submitResp.text().catch(() => "")}`);
  }
  const { request_id, status_url, response_url } = await submitResp.json();
  const result = await pollFalUntilDone(apiKey, request_id, status_url, response_url);
  const url = result?.images?.[0]?.url;
  if (!url) throw new Error("kontext_no_image");
  return { request_id, image_url: url };
}

async function pollFalUntilDone(
  apiKey: string,
  requestId: string,
  statusUrl: string,
  responseUrl: string,
): Promise<any> {
  const start = Date.now();
  const POLL_INTERVAL_MS = 1500;
  const POLL_TIMEOUT_MS = 90_000;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusResp = await fetch(statusUrl, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!statusResp.ok) continue;
    const status = await statusResp.json();
    if (status?.status === "COMPLETED") {
      const respResp = await fetch(responseUrl, {
        headers: { Authorization: `Key ${apiKey}` },
      });
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


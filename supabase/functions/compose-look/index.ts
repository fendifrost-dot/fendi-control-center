// CC edge function -- compose-look
//
// Pure Fal orchestrator. AVT-side data access (caller auth, feature
// resolution, URL signing, storage upload, artist_looks insert) is owned
// by the compose-look-proxy edge function on the AVT side.
//
// Boundary contract:
//   Header:  X-Proxy-Secret (must equal COMPOSE_LOOK_PROXY_SECRET)
//   Input:   { recipe, signedUrls, loraUrl?, triggerWord?, loraScale? }
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
  buildIdentityFillPrompt,
  buildComposePrompt,
  buildSegmentedInpaintStage1Prompt,
  constantTimeEqual,
  decidePipeline,
  resolveComposePrompt,
  SEGMENTED_INPAINT_FLUX_IMAGE_SIZE,
  sortGarmentsForVtonChain,
  type PipelineMode,
  type ResolvedFeatureLite,
} from "./helpers.ts";
import {
  buildRegionInpaintPrompt,
  filterInpaintEligible,
  segmentPromptForGarment,
  stageSlug,
  type GarmentForInpaint,
} from "./segmented-inpaint.ts";

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
  /** Stage 2 / Seedream compose brief; defaults to basePrompt if absent. */
  composePrompt?: string | null;
  /** Narrow eyewear/jewelry polish — no wardrobe_rules / anti-crop. */
  jewelryPolishPrompt?: string | null;
  stylingNotes?: string | null;
  pipelinePreference?: PipelineMode;
  wardrobeLabels?: string[];
  wardrobeItems?: WardrobeItemPassthrough[];
  jewelryLabels?: string[];
  hasLocation?: boolean;
  hasFace?: boolean;
  propCount?: number;
  /**
   * Canonical-base architecture (per ChatGPT recommendation): when present,
   * the lora_segmented_inpaint pipeline SKIPS the Stage 1 callFalFluxLora
   * call and uses this pre-locked identity image as the canvas. This removes
   * the per-look probabilistic regeneration of identity — wardrobe inpaint
   * still runs, but every look starts from the same face/body/proportions.
   * Set on the artist via identity_profile_json.canonical_base_image_url,
   * passed through by compose-look-proxy.
   */
  canonicalBaseImageUrl?: string | null;
};

type Body = {
  recipe: Recipe;
  signedUrls: SignedUrls;
  loraUrl?: string;
  triggerWord?: string;
  /**
   * Optional identity-LoRA strength for the flux-lora-fill inpaint in the
   * identity_inpaint pipeline. Defaults to 1.0 (full strength). Lower it
   * (e.g. 0.8) if the LoRA's identity prior overrides the canvas head pose
   * / lighting. Only consumed by identity_inpaint; other pipelines set their
   * own scale.
   */
  loraScale?: number;
  // Async mode (Phase 4 refactor): when present, CC returns
  // `{ status: 'queued' }` immediately and runs the pipeline in the
  // background via EdgeRuntime.waitUntil. When the pipeline finishes (or
  // fails), CC POSTs the result to `callback_url` with the X-Proxy-Secret
  // header. When absent, CC behaves as before (synchronous response).
  callback_url?: string;
};

// Seedream v4 edit accepts up to 10 image_urls; lora_seedream uses 8 refs.
const SEEDREAM_COMPOSE_MAX_DEFAULT = 4;
const SEEDREAM_COMPOSE_MAX_LORA_SEEDREAM = 8;

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
  const runwayKey = Deno.env.get("RUNWAY_API_KEY") ?? "";
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
  const composeText = resolveComposePrompt(recipe);

  const stages: Array<{ stage: string; request_id?: string; image_url?: string }> = [];
  let costCents = 0;
  let falImageUrl: string | null = null;

  // ---------------------------------------------------------------------
  // executePipelineResponse — Phase 4 refactor.
  //
  // The pipeline switch is wrapped in an inner closure so we can reuse it
  // for both sync and async modes:
  //   - SYNC mode (no callback_url): we await this and return the Response
  //     directly. The legacy contract is preserved verbatim — same status
  //     codes, same body shape.
  //   - ASYNC mode (callback_url present): we run it inside
  //     EdgeRuntime.waitUntil and intercept its Response body to POST to
  //     the callback. The platform's 150s synchronous-response wall no
  //     longer applies because we returned `{ status: 'queued' }` first.
  //
  // The inner-function variables (stages, costCents, falImageUrl) close
  // over the outer-scope declarations so the existing switch body needs
  // no edits beyond this wrapper.
  // ---------------------------------------------------------------------
  const executePipelineResponse = async (): Promise<Response> => {
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

      const maxRefs = SEEDREAM_COMPOSE_MAX_LORA_SEEDREAM;
      const imageUrls: string[] = [flux.image_url];
      imageUrls.push(...(signedUrls.wardrobe ?? []));
      if (signedUrls.jewelry) {
        for (const u of signedUrls.jewelry) {
          if (imageUrls.length >= maxRefs) break;
          imageUrls.push(u);
        }
      }
      if (signedUrls.location && imageUrls.length < maxRefs) {
        imageUrls.push(signedUrls.location);
      }
      const compose = await callFalSeedreamEdit(falKey, {
        prompt: buildComposePrompt(
          composeText,
          recipe.stylingNotes ?? undefined,
          wardrobeLite,
          jewelryLite,
          hasLocation,
        ),
        imageUrls: imageUrls.slice(0, maxRefs),
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
      // Chain order: bottoms → shirt (top) → jacket (outerwear) so the
      // outer layer sees pants + shirt underneath. Footwear/accessory
      // items are filtered out of VTON (Leffa has no footwear category).
      const vtonEligible = sortGarmentsForVtonChain(
        garments.filter((g) => {
          const t = g.feature_type;
          return t === "wardrobe_outerwear" || t === "wardrobe_top" ||
            t === "wardrobe_bottom";
        }),
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

      // ---------------------------------------------------------------
      // Jewelry polish pass (character_features jewelry — e.g. Cazals).
      //
      // Narrow Seedream call: face + jewelry refs only, jewelryPolishPrompt
      // from AVT (no wardrobe_rules, fit details, or anti-crop). Runs
      // before wardrobe_accessory polish so glasses land before hats etc.
      // ---------------------------------------------------------------
      const jewelryRefs = (signedUrls.jewelry ?? []).filter(Boolean).slice(0, 2);
      if (jewelryRefs.length > 0 && currentHumanUrl) {
        const polishPrompt = (recipe.jewelryPolishPrompt ?? "").trim() ||
          `Apply the jewelry or eyewear from the reference image(s): ${
            (recipe.jewelryLabels ?? []).filter(Boolean).join(", ") || "selected items"
          }. Preserve face, body, clothing, and background exactly. Change ONLY the jewelry/eyewear. CRITICAL: glasses lenses must be CLEAR prescription, not tinted or sunglasses. The glasses are proportional to the wearer's face — same width as the temples, lenses sized to cover the eyes naturally without extending past the cheekbones or eyebrows. Match the reference frame proportions exactly. Do NOT render oversized or magnified versions.`;
        const polishUrls: string[] = [currentHumanUrl];
        if (signedUrls.face) polishUrls.push(signedUrls.face);
        for (const u of jewelryRefs) {
          if (polishUrls.length >= 3) break;
          polishUrls.push(u);
        }
        try {
          const jewelryPolish = await callFalSeedreamEdit(falKey, {
            prompt: polishPrompt,
            imageUrls: polishUrls.slice(0, 3),
          });
          stages.push({
            stage: "jewelry_polish_seedream",
            request_id: jewelryPolish.request_id,
            image_url: jewelryPolish.image_url,
          });
          costCents += 4;
          currentHumanUrl = jewelryPolish.image_url;
        } catch (_err) {
          stages.push({ stage: "jewelry_polish_seedream_failed" });
        }
      }

      // ---------------------------------------------------------------
      // Wardrobe accessory polish (glasses/hats picked as wardrobe_accessory).
      // Same narrow pattern — not the full composePrompt brief.
      // ---------------------------------------------------------------
      const accessories = garments.filter((g) => g.feature_type === "wardrobe_accessory");
      if (accessories.length > 0 && currentHumanUrl) {
        const accessoryRefs = accessories
          .slice(0, 2)
          .map((a) => a.signed_url)
          .filter((u): u is string => !!u);
        // Hard cap at 3 total (1 human + ≤2 accessory refs) per the
        // task spec; Seedream Edit can take more but we want this pass
        // narrow and stable.
        const polishImageUrls = [currentHumanUrl, ...accessoryRefs].slice(0, 3);
        const accessoryLabels = accessories
          .slice(0, 2)
          .map((a) => a.label)
          .filter(Boolean)
          .join(", ");
        const polishPrompt =
          `Apply the accessory shown in the reference image(s) to the subject's face/head` +
          (accessoryLabels ? `: ${accessoryLabels}.` : ".") +
          ` Preserve identity, body, clothing, and background exactly — change ONLY the accessory placement on the subject.` +
          ` If the accessory is eyewear/glasses, lenses must be CLEAR prescription (not tinted, not sunglasses, not dark, not mirrored);` +
          ` the wearer's eyes must remain fully visible through the lenses.`;
        try {
          const polish = await callFalSeedreamEdit(falKey, {
            prompt: polishPrompt,
            imageUrls: polishImageUrls,
          });
          stages.push({
            stage: "accessories_polish_seedream",
            request_id: polish.request_id,
            image_url: polish.image_url,
          });
          costCents += 4;
          currentHumanUrl = polish.image_url;
        } catch (_err) {
          // Don't fail the whole pipeline if the polish pass errors —
          // the VTON output is still usable as the look. Record the
          // failure in the stage log so callers can see we tried.
          stages.push({ stage: "accessories_polish_seedream_failed" });
        }
      }

      // If no eligible garments AND no accessories, the final result
      // is the Stage 1 LoRA output (currentHumanUrl was initialised
      // to flux.image_url above).
      falImageUrl = currentHumanUrl;
    } else if (pipeline === "lora_segmented_inpaint") {
      if (!body.loraUrl) {
        return json(400, { error: "lora_required_for_lora_segmented_inpaint" });
      }

      // Canonical-base short-circuit. When the artist has a locked identity
      // base image (identity_profile_json.canonical_base_image_url,
      // forwarded by the proxy as recipe.canonicalBaseImageUrl), skip the
      // Stage 1 FLUX_LoRA call entirely and use the canonical image as the
      // canvas. This stops the per-look identity drift that comes from
      // re-generating the base photo probabilistically each time. The
      // garment inpaint passes below then operate on a stable identity.
      let stage1ImageUrl: string;
      const canonicalUrl = (recipe.canonicalBaseImageUrl ?? "").trim();
      if (canonicalUrl) {
        stage1ImageUrl = canonicalUrl;
        stages.push({
          stage: "canonical_base",
          image_url: canonicalUrl,
        });
        // No costCents bump — no Fal call was made.
      } else {
        const flux = await callFalFluxLora(falKey, {
          prompt: buildSegmentedInpaintStage1Prompt(
            body.triggerWord ?? "",
            recipe.basePrompt,
            recipe.stylingNotes ?? undefined,
          ),
          loraUrl: body.loraUrl,
          loraScale: 0.6,
          imageSize: SEGMENTED_INPAINT_FLUX_IMAGE_SIZE,
        });
        stages.push({
          stage: "flux_lora",
          request_id: flux.request_id,
          image_url: flux.image_url,
        });
        costCents += 5;
        stage1ImageUrl = flux.image_url;
      }

      const garmentSources: GarmentForInpaint[] = [];
      if (Array.isArray(recipe.wardrobeItems) && recipe.wardrobeItems.length > 0) {
        for (const it of recipe.wardrobeItems) {
          if (it?.signed_url) {
            garmentSources.push({
              feature_type: it.feature_type ?? "wardrobe_top",
              label: it.label ?? "",
              signed_url: it.signed_url,
              dimensions_description: it.dimensions_description ?? null,
            });
          }
        }
      } else {
        const urls = signedUrls.wardrobe ?? [];
        const labels = recipe.wardrobeLabels ?? [];
        for (let i = 0; i < urls.length; i++) {
          garmentSources.push({
            feature_type: "wardrobe_top",
            label: labels[i] ?? "",
            signed_url: urls[i],
            dimensions_description: null,
          });
        }
      }

      const inpaintQueue = sortGarmentsForVtonChain(
        filterInpaintEligible(garmentSources),
      );

      let canvasUrl: string = stage1ImageUrl;
      for (const g of inpaintQueue) {
        const segPrompt = segmentPromptForGarment(g);
        const slug = stageSlug(g.label, g.feature_type);
        const seg = await callFalSam3Segment(falKey, {
          imageUrl: canvasUrl,
          prompt: segPrompt,
        });
        if (!seg.mask_url) {
          stages.push({
            stage: `segmentation_skipped_${slug}`,
            request_id: seg.request_id,
            reason: "sam3_no_mask",
          });
          continue;
        }
        stages.push({
          stage: `sam3_segment_${slug}`,
          request_id: seg.request_id,
          image_url: seg.mask_url,
        });
        costCents += 2;
        const maskUrl = seg.mask_url;

        const fillPrompt = buildRegionInpaintPrompt(g);
        const fill = await callFalFluxLoraFill(falKey, {
          prompt: fillPrompt,
          imageUrl: canvasUrl,
          maskUrl,
          garmentImageUrl: g.signed_url,
        });
        stages.push({
          stage: `flux_fill_${g.feature_type}_${stageSlug(g.label, g.feature_type)}`,
          request_id: fill.request_id,
          image_url: fill.image_url,
        });
        costCents += 7;
        canvasUrl = fill.image_url;
      }

      let currentHumanUrl: string = canvasUrl;

      const jewelryRefs = (signedUrls.jewelry ?? []).filter(Boolean).slice(0, 2);
      if (jewelryRefs.length > 0 && currentHumanUrl) {
        const polishPrompt = (recipe.jewelryPolishPrompt ?? "").trim() ||
          `Apply the jewelry or eyewear from the reference image(s): ${
            (recipe.jewelryLabels ?? []).filter(Boolean).join(", ") || "selected items"
          }. Preserve face, body, clothing, and background exactly. Change ONLY the jewelry/eyewear. CRITICAL: glasses lenses must be CLEAR prescription, not tinted or sunglasses. The glasses are proportional to the wearer's face — same width as the temples, lenses sized to cover the eyes naturally without extending past the cheekbones or eyebrows. Match the reference frame proportions exactly. Do NOT render oversized or magnified versions.`;
        const polishUrls: string[] = [currentHumanUrl];
        if (signedUrls.face) polishUrls.push(signedUrls.face);
        for (const u of jewelryRefs) {
          if (polishUrls.length >= 3) break;
          polishUrls.push(u);
        }
        try {
          const jewelryPolish = await callFalSeedreamEdit(falKey, {
            prompt: polishPrompt,
            imageUrls: polishUrls.slice(0, 3),
          });
          stages.push({
            stage: "jewelry_polish_seedream",
            request_id: jewelryPolish.request_id,
            image_url: jewelryPolish.image_url,
          });
          costCents += 4;
          currentHumanUrl = jewelryPolish.image_url;
        } catch (_err) {
          stages.push({ stage: "jewelry_polish_seedream_failed" });
        }
      }

      const accessories = garmentSources.filter(
        (g) => g.feature_type === "wardrobe_accessory",
      );
      if (accessories.length > 0 && currentHumanUrl) {
        const accessoryRefs = accessories
          .slice(0, 2)
          .map((a) => a.signed_url)
          .filter((u): u is string => !!u);
        const polishImageUrls = [currentHumanUrl, ...accessoryRefs].slice(0, 3);
        const accessoryLabels = accessories
          .slice(0, 2)
          .map((a) => a.label)
          .filter(Boolean)
          .join(", ");
        const polishPrompt =
          `Apply the accessory shown in the reference image(s) to the subject's face/head` +
          (accessoryLabels ? `: ${accessoryLabels}.` : ".") +
          ` Preserve identity, body, clothing, and background exactly — change ONLY the accessory placement on the subject.` +
          ` If the accessory is eyewear/glasses, lenses must be CLEAR prescription (not tinted, not sunglasses, not dark, not mirrored);` +
          ` the wearer's eyes must remain fully visible through the lenses.`;
        try {
          const polish = await callFalSeedreamEdit(falKey, {
            prompt: polishPrompt,
            imageUrls: polishImageUrls,
          });
          stages.push({
            stage: "accessories_polish_seedream",
            request_id: polish.request_id,
            image_url: polish.image_url,
          });
          costCents += 4;
          currentHumanUrl = polish.image_url;
        } catch (_err) {
          stages.push({ stage: "accessories_polish_seedream_failed" });
        }
      }

      falImageUrl = currentHumanUrl;
    } else if (pipeline === "identity_inpaint") {
      // Grok-canvas workflow: a fully-clothed stand-in image is the canvas;
      // SAM-3 masks the head/neck and FLUX-LoRA-fill renders the artist's
      // identity into it. Clothing pixels outside the mask are untouched.
      if (!body.loraUrl) {
        return json(400, { error: "lora_required_for_identity_inpaint" });
      }
      const canvas = (recipe.canonicalBaseImageUrl ?? "").trim();
      if (!canvas) {
        return json(400, { error: "canvas_required_for_identity_inpaint" });
      }
      stages.push({ stage: "identity_canvas", image_url: canvas });

      const seg = await callFalSam3Segment(falKey, {
        imageUrl: canvas,
        prompt: "the person's head, face, hair, beard, ears, and neck",
      });
      if (!seg.mask_url) {
        throw new Error("identity_region_not_found: SAM-3 could not isolate a head/neck region in the canvas image");
      }
      stages.push({
        stage: "sam3_segment_identity",
        request_id: seg.request_id,
        image_url: seg.mask_url,
      });
      costCents += 2;

      const fill = await callFalFluxLoraFill(falKey, {
        prompt: buildIdentityFillPrompt(body.triggerWord ?? "", recipe.basePrompt),
        imageUrl: canvas,
        maskUrl: seg.mask_url,
        garmentImageUrl: signedUrls.face ?? null,
        loraUrl: body.loraUrl,
        loraScale: body.loraScale ?? 0.85,
        guidanceScale: 28,
        numInferenceSteps: 32,
      });
      stages.push({
        stage: "flux_fill_identity",
        request_id: fill.request_id,
        image_url: fill.image_url,
      });
      costCents += 7;

      // Phase 2 — clarity-upscaler refinement pass. flux-lora-fill at the
      // Fal-floor guidance of 28 locks identity but leaves a plastic-skin
      // ceiling. SUPIR-family upscaler injects pore-level texture without
      // shifting facial geometry (creativity 0.3 + resemblance 0.85 = lock
      // structure, rework surface). resemblance is ControlNet strength on a
      // 0-1 scale; upscale_factor 1 refines at native res without enlarging.
      const refine = await callFalClarityUpscaler(falKey, {
        imageUrl: fill.image_url,
      });
      stages.push({
        stage: "clarity_upscaler_refine",
        request_id: refine.request_id,
        image_url: refine.image_url,
      });
      costCents += 4;
      let currentImageUrl = refine.image_url;

      // Phase 3 — Runway gen4_image polish (optional final stage).
      // Cinematic finish on top of the clarity-upscaler texture pass.
      // Wrapped in try/catch: if RUNWAY_API_KEY isn't set or the call
      // fails, fall back cleanly to the Phase 2 output. The look still
      // completes; the stage log records the skip/failure for debug.
      if (runwayKey) {
        try {
          const polish = await callRunwayPolish(runwayKey, {
            imageUrl: currentImageUrl,
          });
          stages.push({
            stage: "runway_polish",
            request_id: polish.request_id,
            image_url: polish.image_url,
          });
          costCents += 10;
          currentImageUrl = polish.image_url;
        } catch (err: any) {
          stages.push({
            stage: "runway_polish_failed",
            error: String(err?.message ?? err).slice(0, 200),
          });
        }
      } else {
        stages.push({ stage: "runway_polish_skipped_no_key" });
      }
      falImageUrl = currentImageUrl;
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
          composeText,
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
          composeText,
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
  }; // <- closes executePipelineResponse

  // -------------------------------------------------------------------
  // ASYNC MODE: callback_url present.
  //
  // Return `{ status: 'queued' }` immediately, run the pipeline in the
  // background via EdgeRuntime.waitUntil, and POST the result (or
  // failure) to the callback URL when done. This is the workaround for
  // Supabase Edge Functions' ~150s synchronous-response wall — the
  // chained LoRA + Leffa-VTON + Seedream-polish pipeline routinely
  // pushes past 150s, so we couldn't synchronously return success.
  // -------------------------------------------------------------------
  if (body.callback_url) {
    const callbackUrl = body.callback_url;
    const background = (async () => {
      let resp: Response;
      try {
        resp = await executePipelineResponse();
      } catch (err: any) {
        // Belt-and-suspenders: executePipelineResponse should always
        // resolve with a Response. If something escapes the try/catch
        // inside it, still surface it to the callback as a failure so
        // the look doesn't hang in 'pending'.
        await postCallback(callbackUrl, proxySecret, {
          status: "failed",
          error: `cc_unhandled: ${String(err?.message ?? err).slice(0, 500)}`,
        });
        return;
      }
      const respText = await resp.text().catch(() => "");
      let parsed: any = null;
      try { parsed = JSON.parse(respText); } catch { /* ignore */ }
      if (resp.ok && parsed?.fal_image_url) {
        await postCallback(callbackUrl, proxySecret, {
          status: "complete",
          fal_image_url: parsed.fal_image_url,
          pipeline_used: parsed.pipeline_used,
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
      // Fallback for local/Deno-test runs: fire-and-forget without the
      // platform-provided lifetime extension. The promise still runs in
      // the same process; we just don't get the keep-alive guarantee.
      background.catch(() => {});
    }
    return json(200, { status: "queued" });
  }

  // -------------------------------------------------------------------
  // SYNC MODE: no callback_url — legacy contract preserved.
  // -------------------------------------------------------------------
  return await executePipelineResponse();
});

// ---------------------------------------------------------------------------
// postCallback — small helper used by the async branch to ship a result
// payload back to AVT's compose-look-callback endpoint. Failures here are
// swallowed: the look stays in 'pending' and the UI's poll resolves to a
// "still generating" notice. We could add a sink later if dropped
// callbacks become a real operational concern.
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
    // Drop — see comment above.
  }
}

// ---------------------------------------------------------------------------
// Fal call helpers (preserved verbatim from prior version)
// ---------------------------------------------------------------------------
type FluxLoraImageSize =
  | string
  | { width: number; height: number };

async function callFalFluxLora(
  apiKey: string,
  input: {
    prompt: string;
    loraUrl: string;
    loraScale: number;
    imageSize?: FluxLoraImageSize;
  },
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
      image_size: input.imageSize ?? "portrait_4_3",
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
  input: { prompt: string; imageUrls: string[]; maxImages?: number },
): Promise<FalImageResult> {
  if (input.imageUrls.length === 0) throw new Error("seedream_no_inputs");
  const cap = input.maxImages ?? SEEDREAM_COMPOSE_MAX_DEFAULT;
  const submitResp = await fetch("https://queue.fal.run/fal-ai/bytedance/seedream/v4/edit", {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: input.prompt,
      image_urls: input.imageUrls.slice(0, cap),
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

// SAM-3 text-prompted segmentation — returns a mask image URL for inpainting.
async function callFalSam3Segment(
  apiKey: string,
  input: { imageUrl: string; prompt: string },
): Promise<{ request_id: string; mask_url: string | null }> {
  const submitResp = await fetch("https://queue.fal.run/fal-ai/sam-3/image", {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      image_url: input.imageUrl,
      prompt: input.prompt,
      apply_mask: false,
      output_format: "png",
      max_masks: 1,
    }),
  });
  if (!submitResp.ok) {
    throw new Error(`sam3_submit_${submitResp.status}: ${await submitResp.text().catch(() => "")}`);
  }
  const { request_id, status_url, response_url } = await submitResp.json();
  const result = await pollFalUntilDone(apiKey, request_id, status_url, response_url, 90_000);
  const maskUrl =
    result?.masks?.[0]?.url ??
    result?.image?.url ??
    null;
  return { request_id, mask_url: maskUrl };
}

// FLUX LoRA Fill — regional inpaint with optional garment reference via fill_image.
async function callFalFluxLoraFill(
  apiKey: string,
  input: {
    prompt: string;
    imageUrl: string;
    maskUrl: string;
    garmentImageUrl?: string | null;
    loraUrl?: string | null;
    loraScale?: number;
    guidanceScale?: number;
    numInferenceSteps?: number;
  },
): Promise<FalImageResult> {
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    image_url: input.imageUrl,
    mask_url: input.maskUrl,
    ...(input.loraUrl ? { loras: [{ path: input.loraUrl, scale: input.loraScale ?? 1.0 }] } : {}),
    paste_back: true,
    resize_to_original: true,
    output_format: "png",
    enable_safety_checker: false,
    num_inference_steps: input.numInferenceSteps ?? 28,
    guidance_scale: input.guidanceScale ?? 30,
  };
  if (input.garmentImageUrl) {
    body.fill_image = { image_url: input.garmentImageUrl };
  }
  const submitResp = await fetch("https://queue.fal.run/fal-ai/flux-lora-fill", {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!submitResp.ok) {
    throw new Error(`flux_fill_submit_${submitResp.status}: ${await submitResp.text().catch(() => "")}`);
  }
  const { request_id, status_url, response_url } = await submitResp.json();
  const result = await pollFalUntilDone(apiKey, request_id, status_url, response_url, 120_000);
  const url = result?.images?.[0]?.url;
  if (!url) throw new Error("flux_fill_no_image");
  return { request_id, image_url: url };
}

// Clarity-upscaler (SUPIR-family) — refinement pass that injects
// pore-level skin texture without shifting facial geometry.
async function callFalClarityUpscaler(
  apiKey: string,
  input: {
    imageUrl: string;
    prompt?: string;
    negativePrompt?: string;
  },
): Promise<FalImageResult> {
  const submitResp = await fetch("https://queue.fal.run/fal-ai/clarity-upscaler", {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      image_url: input.imageUrl,
      prompt: input.prompt ?? "raw cinematic photograph, visible skin pores and natural texture, beard hair detail, 35mm film grain, Arri Alexa 35",
      negative_prompt: input.negativePrompt ?? "plastic skin, airbrushed, smooth skin filter, CGI, blurred edges, doll-like, glossy",
      upscale_factor: 1,
      creativity: 0.45,
      resemblance: 0.6,
      num_inference_steps: 18,
      guidance_scale: 4,
      enable_safety_checker: false,
    }),
  });
  if (!submitResp.ok) {
    throw new Error(`clarity_upscaler_submit_${submitResp.status}: ${await submitResp.text().catch(() => "")}`);
  }
  const { request_id, status_url, response_url } = await submitResp.json();
  const result = await pollFalUntilDone(apiKey, request_id, status_url, response_url, 120_000);
  const url = result?.image?.url ?? result?.images?.[0]?.url;
  if (!url) throw new Error("clarity_upscaler_no_image");
  return { request_id, image_url: url };
}

// Runway gen4_image polish — cinematic finish pass on top of Phase 2.
// Uses Runway's official Image-to-Image API. The request body shape and
// response shape may need iteration; the call site wraps this in
// try/catch so a 4xx surface here doesn't break looks. See runway_polish
// or runway_polish_failed stage entries to debug.
async function callRunwayPolish(
  apiKey: string,
  input: {
    imageUrl: string;
    prompt?: string;
  },
): Promise<{ request_id: string; image_url: string }> {
  const promptText = input.prompt ??
    "raw cinematic photograph, Arri Alexa 35 filmic rendering, natural skin texture and pores, real beard hair detail, soft anamorphic lens, 35mm film grain, photographic micro-imperfections — preserve face, outfit, pose, and background exactly";
  const submitResp = await fetch("https://api.dev.runwayml.com/v1/image_to_image", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Runway-Version": "2024-11-06",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gen4_image",
      promptImage: input.imageUrl,
      promptText,
      ratio: "1152:1728",
    }),
  });
  if (!submitResp.ok) {
    throw new Error(`runway_submit_${submitResp.status}: ${await submitResp.text().catch(() => "")}`);
  }
  const submit = await submitResp.json();
  const taskId = submit?.id;
  if (!taskId) throw new Error("runway_no_task_id");

  const start = Date.now();
  const POLL_INTERVAL_MS = 2000;
  const POLL_TIMEOUT_MS = 180_000;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusResp = await fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Runway-Version": "2024-11-06",
      },
    });
    if (!statusResp.ok) continue;
    const status = await statusResp.json();
    if (status?.status === "SUCCEEDED") {
      const url = status?.output?.[0] ?? status?.output_url ?? status?.outputs?.[0]?.url;
      if (!url) throw new Error("runway_no_output_url");
      return { request_id: taskId, image_url: url };
    }
    if (status?.status === "FAILED") {
      throw new Error(`runway_failed: ${status?.failure ?? "unknown"}`);
    }
  }
  throw new Error("runway_poll_timeout");
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
// Public wrapper. Single auto-retry on transient network / 5xx / poll-
// timeout errors. The IDM-VTON smoke tests showed first-click 502s on
// every run with success on retry; this hides that flake from callers.
// We deliberately do NOT retry on logical errors (4xx with body, no-image,
// fal_failed) — those will just fail again and waste another 60s.
async function callFalLeffaVton(
  apiKey: string,
  input: {
    humanImageUrl: string;
    garmentImageUrl: string;
    garmentType: "upper_body" | "lower_body" | "dresses";
  },
): Promise<FalImageResult> {
  try {
    return await callFalLeffaVtonOnce(apiKey, input);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    const isTransient =
      err instanceof TypeError ||
      /Failed to fetch/i.test(msg) ||
      /leffa_vton_submit_5\d\d/.test(msg) ||
      /fal_response_5\d\d/.test(msg) ||
      /fal_poll_timeout/.test(msg);
    if (!isTransient) throw err;
    // Brief backoff before the single retry — gives Fal a moment to
    // recover from a queue blip / cold start.
    await new Promise((r) => setTimeout(r, 1500));
    return await callFalLeffaVtonOnce(apiKey, input);
  }
}

async function callFalLeffaVtonOnce(
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
  // Leffa VTON runs are slower than the other Fal models — bottoms in
  // particular were tipping over the default 90s poll timeout. Bump to
  // 120s for this call only; other callers retain the 90s default.
  const result = await pollFalUntilDone(apiKey, request_id, status_url, response_url, 120_000);
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
  // Per-call timeout override. The IDM-VTON / Leffa-VTON runs are
  // routinely 60–100s end-to-end (FLUX-LoRA Stage 1 + multi-step VTON);
  // the original 90s default was right on the edge and caused timeouts
  // for bottoms. Callers that know they're slow pass 120_000.
  timeoutMs: number = 90_000,
): Promise<any> {
  const start = Date.now();
  const POLL_INTERVAL_MS = 1500;
  const POLL_TIMEOUT_MS = timeoutMs;
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


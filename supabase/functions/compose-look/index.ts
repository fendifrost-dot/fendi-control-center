// CC edge function — compose-look (pure Fal orchestration)
//
// Stateless: receives recipe + pre-signed reference URLs from AVT's
// compose-look-proxy, runs the FLUX-LoRA -> Seedream pipeline on Fal,
// and returns the Fal-hosted image URL plus metadata. NO AVT writes.
//
// Auth: shared header COMPOSE_LOOK_PROXY_SECRET (constant-time compare).
// Required secrets: FAL_API_KEY, COMPOSE_LOOK_PROXY_SECRET.
//
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  buildBasePhotoPrompt,
  buildComposePrompt,
  constantTimeEqual,
  decidePipeline,
  type PipelineMode,
} from "./helpers.ts";

type Recipe = {
  artistId: string;
  faceFeatureId?: string;
  wardrobeFeatureIds?: string[];
  jewelryFeatureIds?: string[];
  locationId?: string;
  propIds?: string[];
  basePrompt: string;
  stylingNotes?: string;
  pipelinePreference?: PipelineMode;
  // Optional labels for prompt construction (improves Seedream prompt quality)
  wardrobeLabels?: string[];
  jewelryLabels?: string[];
};

type SignedUrls = {
  face?: string;
  wardrobe?: string[];
  jewelry?: string[];
  location?: string;
  props?: string[];
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const falKey = Deno.env.get("FAL_API_KEY") ?? "";
  const proxySecret = Deno.env.get("COMPOSE_LOOK_PROXY_SECRET") ?? "";
  if (!falKey || !proxySecret) return json(500, { error: "server_misconfigured" });

  const headerSecret = req.headers.get("x-proxy-secret") ?? "";
  if (!constantTimeEqual(headerSecret, proxySecret)) {
    return json(401, { error: "bad_proxy_secret" });
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const recipe = body?.recipe;
  const urls = body?.signedUrls ?? {};
  if (!recipe?.artistId) return json(400, { error: "missing_artist_id" });
  if (!recipe?.basePrompt || recipe.basePrompt.trim().length < 4) {
    return json(400, { error: "basePrompt_too_short" });
  }
  const wardrobeUrls = Array.isArray(urls.wardrobe) ? urls.wardrobe : [];
  const jewelryUrls = Array.isArray(urls.jewelry) ? urls.jewelry : [];
  const propUrls = Array.isArray(urls.props) ? urls.props : [];
  if (wardrobeUrls.length === 0) return json(400, { error: "wardrobe_required" });

  const loraUrl = typeof body.loraUrl === "string" && body.loraUrl ? body.loraUrl : null;
  const triggerWord = typeof body.triggerWord === "string" ? body.triggerWord : "";
  const pipeline = decidePipeline(recipe.pipelinePreference ?? "auto", !!loraUrl);

  const wardrobeLabels = (recipe.wardrobeLabels ?? []).map((l) => ({ label: l }));
  const jewelryLabels = (recipe.jewelryLabels ?? []).map((l) => ({ label: l }));

  const stages: any[] = [];
  let costCents = 0;
  let finalImageUrl: string;

  try {
    if (pipeline === "lora_seedream") {
      const basePhotoPrompt = buildBasePhotoPrompt(triggerWord, recipe.basePrompt, recipe.stylingNotes);
      const lora = await callFalFluxLora(falKey, {
        prompt: basePhotoPrompt,
        loraUrl: loraUrl!,
        loraScale: 1.0,
      });
      stages.push({ stage: "flux_lora", request_id: lora.request_id, image_url: lora.image_url });
      costCents += 3;

      const imageUrls = [lora.image_url, ...wardrobeUrls, ...jewelryUrls];
      if (urls.location) imageUrls.push(urls.location);
      imageUrls.push(...propUrls);
      const compose = await callFalSeedreamEdit(falKey, {
        prompt: buildComposePrompt(recipe.basePrompt, recipe.stylingNotes, wardrobeLabels, jewelryLabels, !!urls.location),
        imageUrls: imageUrls.slice(0, 10),
      });
      stages.push({ stage: "seedream_edit", request_id: compose.request_id, image_url: compose.image_url });
      costCents += 4;
      finalImageUrl = compose.image_url;
    } else if (pipeline === "seedream_only") {
      const imageUrls: string[] = [];
      if (urls.face) imageUrls.push(urls.face);
      imageUrls.push(...wardrobeUrls, ...jewelryUrls);
      if (urls.location) imageUrls.push(urls.location);
      imageUrls.push(...propUrls);
      if (imageUrls.length === 0) return json(400, { error: "no_references_provided" });
      const compose = await callFalSeedreamEdit(falKey, {
        prompt: buildComposePrompt(recipe.basePrompt, recipe.stylingNotes, wardrobeLabels, jewelryLabels, !!urls.location),
        imageUrls: imageUrls.slice(0, 10),
      });
      stages.push({ stage: "seedream_edit", request_id: compose.request_id, image_url: compose.image_url });
      costCents += 4;
      finalImageUrl = compose.image_url;
    } else {
      const imageUrls: string[] = [];
      if (urls.face) imageUrls.push(urls.face);
      imageUrls.push(...wardrobeUrls, ...jewelryUrls);
      if (urls.location) imageUrls.push(urls.location);
      imageUrls.push(...propUrls);
      if (imageUrls.length === 0) return json(400, { error: "no_references_provided" });
      const compose = await callFalFluxKontextMulti(falKey, {
        prompt: buildComposePrompt(recipe.basePrompt, recipe.stylingNotes, wardrobeLabels, jewelryLabels, !!urls.location),
        imageUrls: imageUrls.slice(0, 4),
      });
      stages.push({ stage: "flux_kontext_multi", request_id: compose.request_id, image_url: compose.image_url });
      costCents += 5;
      finalImageUrl = compose.image_url;
    }
  } catch (err) {
    return json(502, { error: "fal_pipeline_failed", detail: String(err), stages });
  }

  return json(200, {
    fal_image_url: finalImageUrl,
    pipeline_used: pipeline,
    cost_cents: costCents,
    generation_metadata: {
      artist_id: recipe.artistId,
      lora_url: loraUrl,
      trigger_word: triggerWord,
      stages,
    },
  });
});

// ---------------------------------------------------------------------------
// Fal calls
// ---------------------------------------------------------------------------
type FalImageResult = { request_id: string; image_url: string };

async function callFalFluxLora(
  apiKey: string,
  input: { prompt: string; loraUrl: string; loraScale: number },
): Promise<FalImageResult> {
  const submitResp = await fetch("https://queue.fal.run/fal-ai/flux-lora", {
    method: "POST",
    headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
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
  const result = await pollFalUntilDone(apiKey, status_url, response_url);
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
    headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
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
  const result = await pollFalUntilDone(apiKey, status_url, response_url);
  const url = result?.images?.[0]?.url;
  if (!url) throw new Error("seedream_no_image");
  return { request_id, image_url: url };
}

async function callFalFluxKontextMulti(
  apiKey: string,
  input: { prompt: string; imageUrls: string[] },
): Promise<FalImageResult> {
  if (input.imageUrls.length === 0) throw new Error("kontext_no_inputs");
  const submitResp = await fetch("https://queue.fal.run/fal-ai/flux-pro/kontext/multi", {
    method: "POST",
    headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
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
  const result = await pollFalUntilDone(apiKey, status_url, response_url);
  const url = result?.images?.[0]?.url;
  if (!url) throw new Error("kontext_no_image");
  return { request_id, image_url: url };
}

async function pollFalUntilDone(
  apiKey: string,
  statusUrl: string,
  responseUrl: string,
): Promise<any> {
  const start = Date.now();
  const POLL_INTERVAL_MS = 1500;
  const POLL_TIMEOUT_MS = 90_000;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
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

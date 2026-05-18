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
        loraScale: 0.95,
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

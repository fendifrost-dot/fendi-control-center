// CC edge function — compose-look
//
// Takes a set of feature IDs (face/wardrobe/jewelry refs in AVT's
// character_features table), runs the 3-stage identity-locked composition
// pipeline through Fal, uploads the rendered look to AVT's look-composites
// bucket and writes the artist_looks row.
//
// Pipeline modes:
//   - lora_seedream  : flux-lora (base photo) → seedream/v4/edit (compose)
//   - seedream_only  : seedream/v4/edit directly with face as image[0]
//   - kontext_multi  : flux-kontext (fallback, single-pass)
//
// Auth:
//   - The AVT proxy injects X-Internal-Proxy-Secret + the user's
//     Supabase JWT. We verify the secret (constant-time), then verify the JWT
//     against AVT's anon key and use the user id from the verified token.
//
// Env vars required:
//   - AVT_SUPABASE_URL                  (AVT project base URL)
//   - AVT_SUPABASE_ANON_KEY             (for JWT verification)
//   - AVT_SUPABASE_SERVICE_ROLE_KEY     (storage upload + row insert)
//   - FAL_API_KEY
//   - COMPOSE_LOOK_PROXY_SECRET         (shared secret with AVT proxy)
//
// deno-lint-ignore-file no-explicit-any

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  buildBasePhotoPrompt,
  buildComposePrompt,
  constantTimeEqual,
  decidePipeline,
  defaultLookName,
  type PipelineMode,
  sniffMime,
} from "./helpers.ts";

type Body = {
  artistId: string;
  faceFeatureId?: string;
  wardrobeFeatureIds: string[];
  jewelryFeatureIds?: string[];
  locationId?: string;
  propIds?: string[];
  basePrompt: string;
  stylingNotes?: string;
  pipelinePreference?: PipelineMode;
  parentLookId?: string;
  name?: string;
};

type ResolvedFeature = {
  id: string;
  feature_type: string;
  label: string;
  storage_path: string | null;
  file_url: string | null;
  bucket: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-proxy-secret, x-user-jwt",
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
  const avtUrl = Deno.env.get("AVT_SUPABASE_URL") ?? "";
  const avtAnon = Deno.env.get("AVT_SUPABASE_ANON_KEY") ?? "";
  const avtServiceRole = Deno.env.get("AVT_SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const falKey = Deno.env.get("FAL_API_KEY") ?? "";
  const proxySecret = Deno.env.get("COMPOSE_LOOK_PROXY_SECRET") ?? "";
  if (!avtUrl || !avtAnon || !avtServiceRole || !falKey || !proxySecret) {
    return json(500, { error: "server_misconfigured" });
  }

  // ---- proxy auth ------------------------------------------------------
  const headerSecret = req.headers.get("x-internal-proxy-secret") ?? "";
  if (!constantTimeEqual(headerSecret, proxySecret)) {
    return json(401, { error: "bad_proxy_secret" });
  }

  // ---- user auth (verify JWT via AVT anon key) -------------------------
  const userJwt = req.headers.get("x-user-jwt") ?? "";
  if (!userJwt) return json(401, { error: "missing_user_jwt" });
  const userClient = createClient(avtUrl, avtAnon, {
    global: { headers: { Authorization: `Bearer ${userJwt}` } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return json(401, { error: "invalid_user_jwt" });
  }
  const userId = userData.user.id;

  // ---- body ------------------------------------------------------------
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (!body?.artistId) return json(400, { error: "missing_artist_id" });
  if (!Array.isArray(body.wardrobeFeatureIds) || body.wardrobeFeatureIds.length === 0) {
    return json(400, { error: "wardrobe_required" });
  }
  if (!body.basePrompt || body.basePrompt.trim().length < 4) {
    return json(400, { error: "basePrompt_too_short" });
  }

  const admin = createClient(avtUrl, avtServiceRole, {
    auth: { persistSession: false },
  });

  // ---- artist + LoRA ---------------------------------------------------
  const { data: artist, error: artistErr } = await admin
    .from("artists")
    .select("id, user_id, name, identity_profile_json")
    .eq("id", body.artistId)
    .maybeSingle();
  if (artistErr) return json(500, { error: "artist_query_failed", detail: artistErr.message });
  if (!artist) return json(404, { error: "artist_not_found" });
  if (artist.user_id !== userId) return json(403, { error: "artist_forbidden" });

  const identity = (artist.identity_profile_json ?? {}) as Record<string, any>;
  const loraInfo = identity.lora ?? null;
  const loraUrl: string | null =
    typeof loraInfo?.url === "string" ? loraInfo.url : null;
  const loraTrigger: string =
    typeof loraInfo?.trigger === "string" ? loraInfo.trigger : "";

  // ---- decide pipeline -------------------------------------------------
  const pipeline = decidePipeline(body.pipelinePreference ?? "auto", !!loraUrl);

  // ---- resolve feature refs into signed URLs --------------------------
  const allFeatureIds = [
    body.faceFeatureId,
    ...body.wardrobeFeatureIds,
    ...(body.jewelryFeatureIds ?? []),
  ].filter(Boolean) as string[];

  const features = await resolveFeatures(admin, allFeatureIds, body.artistId);
  const faceFeature = body.faceFeatureId
    ? features.find((f) => f.id === body.faceFeatureId) ?? null
    : await defaultFaceFeature(admin, body.artistId);
  const wardrobeFeatures = body.wardrobeFeatureIds
    .map((id) => features.find((f) => f.id === id))
    .filter((f): f is ResolvedFeature => !!f);
  const jewelryFeatures = (body.jewelryFeatureIds ?? [])
    .map((id) => features.find((f) => f.id === id))
    .filter((f): f is ResolvedFeature => !!f);

  // location + props (separate tables)
  const locationFeature = body.locationId
    ? await resolveLibraryItem(admin, "location_library", body.locationId, userId, "location-refs")
    : null;
  const propsFeatures: ResolvedFeature[] = [];
  for (const pid of body.propIds ?? []) {
    const p = await resolveLibraryItem(admin, "prop_library", pid, userId, "prop-refs");
    if (p) propsFeatures.push(p);
  }

  // Sign URLs for everything (45-minute lifetime — Fal pulls them quickly)
  const SIGN_TTL = 2700;
  const faceUrl = faceFeature
    ? await signUrl(admin, faceFeature.bucket, faceFeature.storage_path ?? faceFeature.file_url, SIGN_TTL)
    : null;
  const wardrobeUrls: string[] = [];
  for (const w of wardrobeFeatures) {
    const u = await signUrl(admin, w.bucket, w.storage_path ?? w.file_url, SIGN_TTL);
    if (u) wardrobeUrls.push(u);
  }
  const jewelryUrls: string[] = [];
  for (const j of jewelryFeatures) {
    const u = await signUrl(admin, j.bucket, j.storage_path ?? j.file_url, SIGN_TTL);
    if (u) jewelryUrls.push(u);
  }
  const locationUrl = locationFeature
    ? await signUrl(admin, locationFeature.bucket, locationFeature.storage_path ?? locationFeature.file_url, SIGN_TTL)
    : null;
  const propUrls: string[] = [];
  for (const p of propsFeatures) {
    const u = await signUrl(admin, p.bucket, p.storage_path ?? p.file_url, SIGN_TTL);
    if (u) propUrls.push(u);
  }

  // ---- pre-allocate look_id so storage path can be set before insert --
  const lookId = crypto.randomUUID();

  // ---- run pipeline ---------------------------------------------------
  let composedBytes: Uint8Array;
  let mime: "image/png" | "image/jpeg" | "image/webp";
  let costCents = 0;
  let stages: any[] = [];

  try {
    if (pipeline === "lora_seedream") {
      // Step 1: base photo from LoRA
      const basePhotoPrompt = buildBasePhotoPrompt(loraTrigger, body.basePrompt, body.stylingNotes);
      const lora = await callFalFluxLora(falKey, {
        prompt: basePhotoPrompt,
        loraUrl: loraUrl!,
        loraScale: 1.0,
      });
      stages.push({ stage: "flux_lora", request_id: lora.request_id, image_url: lora.image_url });
      costCents += 3; // ~$0.025

      // Step 2: seedream/v4/edit
      // DEBUG cap (smoke test): face/base + first 2 wardrobe + optional location = max 4 inputs.
      // Dropping jewelry + props + extra wardrobe to rule out Seedream URL-count failures.
      const imageUrls = [lora.image_url, ...wardrobeUrls.slice(0, 2)];
      if (locationUrl && imageUrls.length < 4) imageUrls.push(locationUrl);
      const compose = await callFalSeedreamEdit(falKey, {
        prompt: buildComposePrompt(body.basePrompt, body.stylingNotes, wardrobeFeatures, jewelryFeatures, !!locationFeature),
        imageUrls: imageUrls.slice(0, 4),
      });
      stages.push({ stage: "seedream_edit", request_id: compose.request_id, image_url: compose.image_url });
      costCents += 4;

      ({ bytes: composedBytes, mime } = await downloadImage(compose.image_url));
    } else if (pipeline === "seedream_only") {
      // DEBUG cap (smoke test): face + first 2 wardrobe + optional location = max 4 inputs.
      const imageUrls: string[] = [];
      if (faceUrl) imageUrls.push(faceUrl);
      imageUrls.push(...wardrobeUrls.slice(0, 2));
      if (locationUrl && imageUrls.length < 4) imageUrls.push(locationUrl);
      if (imageUrls.length === 0) {
        return json(400, { error: "no_references_provided" });
      }
      const compose = await callFalSeedreamEdit(falKey, {
        prompt: buildComposePrompt(body.basePrompt, body.stylingNotes, wardrobeFeatures, jewelryFeatures, !!locationFeature),
        imageUrls: imageUrls.slice(0, 4),
      });
      stages.push({ stage: "seedream_edit", request_id: compose.request_id, image_url: compose.image_url });
      costCents += 4;
      ({ bytes: composedBytes, mime } = await downloadImage(compose.image_url));
    } else {
      // kontext_multi
      const imageUrls: string[] = [];
      if (faceUrl) imageUrls.push(faceUrl);
      imageUrls.push(...wardrobeUrls, ...jewelryUrls);
      if (locationUrl) imageUrls.push(locationUrl);
      for (const p of propUrls) imageUrls.push(p);
      if (imageUrls.length === 0) return json(400, { error: "no_references_provided" });
      const compose = await callFalFluxKontextMulti(falKey, {
        prompt: buildComposePrompt(body.basePrompt, body.stylingNotes, wardrobeFeatures, jewelryFeatures, !!locationFeature),
        imageUrls: imageUrls.slice(0, 4),
      });
      stages.push({ stage: "flux_kontext_multi", request_id: compose.request_id, image_url: compose.image_url });
      costCents += 5;
      ({ bytes: composedBytes, mime } = await downloadImage(compose.image_url));
    }
  } catch (err) {
    return json(502, { error: "fal_pipeline_failed", detail: String(err), stages });
  }

  // ---- upload to look-composites bucket -------------------------------
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  const storagePath = `${userId}/${body.artistId}/${lookId}.${ext}`;
  const { error: uploadErr } = await admin.storage
    .from("look-composites")
    .upload(storagePath, composedBytes, {
      contentType: mime,
      cacheControl: "3600",
      upsert: false,
    });
  if (uploadErr) {
    return json(500, { error: "upload_failed", detail: uploadErr.message });
  }

  // ---- insert artist_looks row ----------------------------------------
  const recipe = {
    face_feature_id: faceFeature?.id ?? null,
    wardrobe_feature_ids: wardrobeFeatures.map((f) => f.id),
    jewelry_feature_ids: jewelryFeatures.map((f) => f.id),
    location_id: locationFeature?.id ?? null,
    prop_ids: propsFeatures.map((p) => p.id),
    base_prompt: body.basePrompt,
    styling_notes: body.stylingNotes ?? null,
    lora_url: loraUrl,
    lora_trigger: loraTrigger,
    stages,
  };

  const { data: lookRow, error: insertErr } = await admin
    .from("artist_looks")
    .insert({
      id: lookId,
      artist_id: body.artistId,
      user_id: userId,
      name: body.name ?? defaultLookName(wardrobeFeatures),
      description: body.basePrompt,
      status: "draft",
      generated_image_url: storagePath,
      generated_storage_path: storagePath,
      composition_recipe_json: recipe,
      pipeline_used: pipeline,
      cost_cents: costCents,
      iterations: body.parentLookId ? 2 : 1,
      parent_look_id: body.parentLookId ?? null,
    })
    .select("*")
    .single();
  if (insertErr) {
    return json(500, { error: "insert_failed", detail: insertErr.message });
  }

  // Sign the result for the response
  const signedResult = await signUrl(admin, "look-composites", storagePath, 3600);

  return json(200, {
    look: lookRow,
    signed_url: signedResult,
    pipeline_used: pipeline,
    cost_cents: costCents,
    stages,
  });
});

// ---------------------------------------------------------------------------
// Feature resolution helpers
// ---------------------------------------------------------------------------
async function resolveFeatures(
  admin: any,
  ids: string[],
  artistId: string,
): Promise<ResolvedFeature[]> {
  if (ids.length === 0) return [];
  const { data, error } = await admin
    .from("character_features")
    .select("id, feature_type, label, storage_path, file_url")
    .in("id", ids)
    .eq("artist_id", artistId);
  if (error) throw new Error(`features_query_failed: ${error.message}`);
  return (data ?? []).map((r: any) => ({
    id: r.id,
    feature_type: r.feature_type,
    label: r.label,
    storage_path: r.storage_path ?? null,
    file_url: r.file_url ?? null,
    // wardrobe/jewelry refs are in wardrobe-refs; older face/character-DNA refs
    // are in artist-assets. The bucket lookup leans on the feature_type prefix.
    bucket: r.feature_type?.startsWith?.("wardrobe_") ? "wardrobe-refs" : "artist-assets",
  }));
}

async function defaultFaceFeature(
  admin: any,
  artistId: string,
): Promise<ResolvedFeature | null> {
  // Pick the most-locked face feature, then primary, then most recent.
  const { data, error } = await admin
    .from("character_features")
    .select("id, feature_type, label, storage_path, file_url, is_locked, is_primary, uploaded_at")
    .eq("artist_id", artistId)
    .eq("feature_type", "face")
    .order("is_locked", { ascending: false })
    .order("is_primary", { ascending: false })
    .order("uploaded_at", { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const r = data[0];
  return {
    id: r.id,
    feature_type: r.feature_type,
    label: r.label,
    storage_path: r.storage_path ?? null,
    file_url: r.file_url ?? null,
    bucket: "artist-assets",
  };
}

async function resolveLibraryItem(
  admin: any,
  table: "location_library" | "prop_library",
  id: string,
  userId: string,
  bucket: string,
): Promise<ResolvedFeature | null> {
  const { data, error } = await admin
    .from(table)
    .select("id, name, storage_path, file_url")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id,
    feature_type: table === "location_library" ? "location" : "prop",
    label: data.name,
    storage_path: data.storage_path ?? null,
    file_url: data.file_url ?? null,
    bucket,
  };
}

async function signUrl(
  admin: any,
  bucket: string,
  pathOrFileUrl: string | null,
  expiresIn: number,
): Promise<string | null> {
  if (!pathOrFileUrl) return null;
  // file_url and storage_path are stored as bucket-relative paths in our schema.
  const { data, error } = await admin.storage.from(bucket).createSignedUrl(pathOrFileUrl, expiresIn);
  if (error) return null;
  return data?.signedUrl ?? null;
}

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

// ---------------------------------------------------------------------------
// Image download
// ---------------------------------------------------------------------------
async function downloadImage(
  url: string,
): Promise<{ bytes: Uint8Array; mime: "image/png" | "image/jpeg" | "image/webp" }> {
  const resp = await fetch(url, {
    headers: { Accept: "image/png, image/jpeg, image/webp" },
  });
  if (!resp.ok) throw new Error(`download_${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  const mime = sniffMime(buf);
  if (!mime) throw new Error("unknown_mime");
  return { bytes: buf, mime };
}

// helpers.ts hosts the pure helpers — sniffMime / buildBasePhotoPrompt /
// buildComposePrompt / defaultLookName — so they can be unit tested without
// booting the HTTP server.

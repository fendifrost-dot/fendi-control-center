# Cursor handoff: AVT photorealism Phase 2 — skin detail + catchlights + specularity

## Context

After v8 (commit `1bc72d4`), the film-treatment pipeline is locked: identity-grafted via Fal face-swap, outfit preserved, grain in the right places (shadow-weighted, organic, HF preservation), warm cast gated to non-neutral mid-luma pixels. Fendi's verdict: photographic, but the remaining gap to "indistinguishable from reality" needs three things AI consistently misses:

1. **Skin pore detail** — Fal's `identity-faceswap` produces clean skin without the pore-level micro-texture real cameras capture. Grain helps but doesn't add real texture structure.
2. **Eye catchlights** — specular reflections of light sources in the iris/pupil. Real photos almost always have them; AI portraits often don't.
3. **Skin specularity** — natural oil sheen on forehead, nose tip, cheekbones. Subtle highlight bloom that real skin produces, AI-rendered skin lacks.

This handoff adds those three as a second post-process chain AFTER `applyFilmTreatment`. Implemented as a chain of Fal model calls (for skin detail) plus algorithmic enhancements (for catchlights + specularity).

## Scope

- **File:** `supabase/functions/faceswap-callback/index.ts` (only the `look_id` / `identity_faceswap` branch — VLONE / `job_id` branch untouched)
- **Repo:** `fendifrost-dot/ai-video-tool`
- **No schema changes.** Pure code addition.
- **PAT in `~/fendi-control-center/.git/config` is EXPIRED** — use `gh` CLI auth (Fendi's logged in as `fendifrost-dot` with `repo`+`workflow` scopes) to push. The clone works fine because the repo is public.
- **No Lovable chat for code.** Chat is only for `redeploy edge function faceswap-callback`.

## Architecture

The new chain inserts BETWEEN Fal swap completion and `applyFilmTreatment`. This way:
1. Fal swap produces the identity-grafted result (existing)
2. Skin detail restoration adds pore-level texture (NEW)
3. Catchlight enhancement adds eye specular highlights (NEW)
4. Skin specularity adds subtle face-region highlights (NEW)
5. `applyFilmTreatment` applies grain + halation + Portra + warm + vignette (existing)

The order matters: restore pore detail FIRST while the image is "clean," then add catchlights/specularity (which need clean reference data to land), THEN run film treatment to age the whole thing.

## Stage 1 — Skin pore detail via Fal `face-fix` (or `clarity-upscaler`)

### Approach

Fal has two relevant models:
- **`fal-ai/face-fix`** — face-specific detail restoration, adds pore-level micro-texture, ~$0.02/image. Best for portraits.
- **`fal-ai/clarity-upscaler`** — general-purpose detail enhancement, can over-sharpen if used too aggressively. Useful fallback if `face-fix` isn't available.

Try `face-fix` first; fall back to `clarity-upscaler` at low strength if `face-fix` returns an error.

### Implementation

Add this helper after the existing Fal swap completion:

```ts
async function applyFalSkinDetail(imageUrl: string, falApiKey: string): Promise<string> {
  try {
    // Try face-fix first — purpose-built for portrait skin detail
    const response = await fetch("https://queue.fal.run/fal-ai/face-fix", {
      method: "POST",
      headers: {
        "Authorization": `Key ${falApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image_url: imageUrl,
        // Conservative settings — we want detail restoration, not aggressive sharpening
        strength: 0.65,
      }),
    });

    if (!response.ok) {
      throw new Error(`face-fix failed: ${response.status}`);
    }

    const queueData = await response.json();
    const requestId = queueData.request_id;

    // Poll for completion (typical 10-30s)
    let result;
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      const statusResp = await fetch(`https://queue.fal.run/fal-ai/face-fix/requests/${requestId}`, {
        headers: { "Authorization": `Key ${falApiKey}` },
      });
      const statusData = await statusResp.json();
      if (statusData.status === "COMPLETED") {
        result = statusData;
        break;
      }
      if (statusData.status === "FAILED") {
        throw new Error(`face-fix job failed`);
      }
    }

    if (!result?.images?.[0]?.url) {
      throw new Error("face-fix returned no image URL");
    }

    return result.images[0].url;

  } catch (err) {
    console.warn(`face-fix failed, falling back to clarity-upscaler: ${err.message}`);

    // Fallback: clarity-upscaler at low strength
    const fallbackResp = await fetch("https://queue.fal.run/fal-ai/clarity-upscaler", {
      method: "POST",
      headers: {
        "Authorization": `Key ${falApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image_url: imageUrl,
        scale: 1, // don't upscale, just enhance
        creativity: 0.15, // low — we want detail restoration, not generative changes
        resemblance: 0.85, // high — stay close to source
      }),
    });

    if (!fallbackResp.ok) {
      console.error("Both face-fix and clarity-upscaler failed; returning original");
      return imageUrl; // graceful degradation
    }

    const data = await fallbackResp.json();
    return data.images?.[0]?.url ?? imageUrl;
  }
}
```

The Fal API key is already in the edge function (used by the existing swap pipeline). Reuse the same env var.

## Stage 2 — Eye catchlight enhancement

### Approach

Catchlights are tiny specular highlights in the pupil/iris from light sources. Detecting them requires face landmark detection. Fal has `fal-ai/face-landmark` or we can use a lightweight in-Deno approach.

**Pragmatic implementation:** Detect bright spots within high-saturation low-luma regions (iris area is darker than skin). Add a 3-5px Gaussian glow at those points with slight blue-white tint (sky reflection color).

This is heuristic — not as precise as landmark detection — but ships in one PR without external dependencies.

### Implementation

```ts
function applyEyeCatchlights(bitmap: Uint8ClampedArray, w: number, h: number): void {
  // Build a "potential iris" mask: pixels that are dark (luma 30-100) AND have color
  // (not pure gray) AND are surrounded by lighter pixels (likely eye sockets).
  // This is a rough heuristic — doesn't need to be perfect, just better than nothing.

  const candidates: { x: number; y: number; score: number }[] = [];

  // Skip border pixels to allow 5x5 sampling
  for (let y = 5; y < h - 5; y++) {
    for (let x = 5; x < w - 5; x++) {
      const idx = (y * w + x) * 4;
      const r = bitmap[idx], g = bitmap[idx + 1], b = bitmap[idx + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;

      if (luma < 30 || luma > 100) continue; // not iris brightness
      if (Math.abs(r - g) < 5 && Math.abs(g - b) < 5) continue; // too neutral

      // Check that surrounding pixels are brighter (eye socket whites + lashes)
      let brighterNeighbors = 0;
      for (let dy = -5; dy <= 5; dy += 5) {
        for (let dx = -5; dx <= 5; dx += 5) {
          if (dy === 0 && dx === 0) continue;
          const nIdx = ((y + dy) * w + (x + dx)) * 4;
          const nLuma = 0.299 * bitmap[nIdx] + 0.587 * bitmap[nIdx + 1] + 0.114 * bitmap[nIdx + 2];
          if (nLuma > luma + 30) brighterNeighbors++;
        }
      }

      if (brighterNeighbors >= 3) {
        candidates.push({ x, y, score: brighterNeighbors });
      }
    }
  }

  // Sort by score, take top 2-6 candidates (likely the iris centers of both eyes)
  candidates.sort((a, b) => b.score - a.score);
  const catchlights = candidates.slice(0, 6);

  // For each catchlight, add a small bright spot with slight blue-white tint
  // Gaussian-shaped, 3-5px radius
  const catchlightRadius = 3;
  for (const { x, y } of catchlights) {
    for (let dy = -catchlightRadius; dy <= catchlightRadius; dy++) {
      for (let dx = -catchlightRadius; dx <= catchlightRadius; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > catchlightRadius) continue;
        const falloff = Math.exp(-(dist * dist) / (catchlightRadius));
        const idx = ((y + dy) * w + (x + dx)) * 4;
        if (idx < 0 || idx >= bitmap.length) continue;

        // Slight blue-white catchlight (mimics sky reflection)
        const boost = 80 * falloff;
        bitmap[idx] = Math.min(255, bitmap[idx] + boost * 0.95);
        bitmap[idx + 1] = Math.min(255, bitmap[idx + 1] + boost * 0.98);
        bitmap[idx + 2] = Math.min(255, bitmap[idx + 2] + boost * 1.00);
      }
    }
  }
}
```

This is a quick heuristic. It will sometimes add catchlights in non-eye regions (e.g., dark earrings, jewelry), but most of the time those would also look natural with a slight specular highlight. If false positives become annoying, the next iteration would be to use `fal-ai/face-landmark` for precise eye location — surface that as a future enhancement.

## Stage 3 — Skin specularity (subtle highlight bloom on face)

### Approach

Real skin produces oil-sheen highlights on the forehead, nose bridge, cheekbones, chin. Camera sensors register these as soft bright spots. AI-rendered skin looks matte.

Detect high-luma areas in skin-tone pixels (R > G > B, with R-B differential indicating warm skin tones), and add a very subtle bloom — small Gaussian glow that slightly brightens the area without adding new bright pixels.

### Implementation

```ts
function applySkinSpecularity(bitmap: Uint8ClampedArray, w: number, h: number): void {
  // Find skin-tone pixels (warm hue, mid-to-high luma)
  // Boost specular highlights subtly within them

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const r = bitmap[idx], g = bitmap[idx + 1], b = bitmap[idx + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;

      // Skin-tone heuristic: warm hue (R > G > B), mid-to-high luma
      const isSkinTone =
        r > g && g > b &&         // warm hue
        luma > 100 && luma < 230 && // mid-to-high luma (not deep shadow, not pure white)
        r - b > 10 &&             // significant warmth
        r - g < 60;               // not too saturated (would be too red)

      if (!isSkinTone) continue;

      // Within skin tones: brighter pixels get a very subtle additional boost
      // (mimics specular highlight)
      const specularBoost = Math.max(0, (luma - 150) / 80); // 0 below luma 150, 1 at luma 230
      const boost = 8 * specularBoost; // max +8 on bright skin pixels

      bitmap[idx] = Math.min(255, r + boost);
      bitmap[idx + 1] = Math.min(255, g + boost * 0.95);
      bitmap[idx + 2] = Math.min(255, b + boost * 0.90); // slightly less blue boost (warm specular)
    }
  }
}
```

This is intentionally subtle — at most +8 on the brightest skin pixels, falling off completely below luma 150. The goal is "skin doesn't look matte" not "skin looks oily."

## Wire-up in `handleLookCallback`

Insert these stages between the existing Fal swap completion and the `applyFilmTreatment` call:

```ts
// existing: get falResultUrl from Fal swap completion

// NEW Stage 1: Skin detail restoration (Fal model chain)
const detailEnhancedUrl = await applyFalSkinDetail(falResultUrl, FAL_API_KEY);

// Download the detail-enhanced image
const resultResp = await fetch(detailEnhancedUrl);
let resultBlob = await resultResp.blob();
const arrayBuffer = await resultBlob.arrayBuffer();
const img = await Image.decode(new Uint8Array(arrayBuffer));

// NEW Stage 2: Eye catchlights (in-Deno)
applyEyeCatchlights(img.bitmap, img.width, img.height);

// NEW Stage 3: Skin specularity (in-Deno)
applySkinSpecularity(img.bitmap, img.width, img.height);

// Re-encode for downstream film treatment
const encoded = await img.encode(95);
resultBlob = new Blob([encoded], { type: "image/jpeg" });

// EXISTING: film treatment (grain, halation, Portra, warm, vignette, etc.)
if (lookId) {
  resultBlob = await applyFilmTreatment(resultBlob, "light");
}

// EXISTING: upload to look-composites bucket
```

## Cost expectations

- Skin detail (Fal `face-fix`): +$0.02-0.04 per swap
- Eye catchlights (in-Deno): free
- Skin specularity (in-Deno): free
- Total new cost per identity swap: **+$0.02-0.04** (up from $0.05 → ~$0.07-0.09)
- Latency: +10-30s (Fal queue) on top of existing ~150s

## Test plan after pushing

1. Lovable chat: `redeploy edge function faceswap-callback`
2. Re-run Apply-my-identity on Pair 2 (`6880cd16-22bb-45ba-aada-14552ea56742`)
3. Expected v9 result:
   - All v8 wins preserved (grain, warm gating, identity, outfit)
   - **NEW:** Visible pore texture on skin under zoom (clearly more than v8's grain alone provides)
   - **NEW:** Tiny catchlights visible in eyes (small bright spots in pupils)
   - **NEW:** Subtle bright spots on forehead, nose bridge, cheekbones (specularity)
   - Compare to v8 at face-zoom — the skin should clearly look "shot" rather than "rendered"

Risk surface:
- If `applyFalSkinDetail` over-sharpens, the face may look "HDR processed." Fallback parameters can tune down (`strength: 0.5` instead of `0.65`).
- If catchlights land in wrong places (jewelry, dark fabric), surface and we'll gate by face-region only via landmark detection in a follow-up.
- If specularity is invisible at "light" film treatment strength (the grain may mask it), step the specularity boost from 8 to 12.

## Hard rules

- No Lovable chat for code edits.
- No schema changes.
- Don't touch `applyFilmTreatment` or any of the existing stages.
- Only `look_id` branch — VLONE `job_id` path stays untouched.
- Push to `main` directly.
- Match existing code style.

## Commit message

```
feat(avt): photorealism phase 2 — skin detail, catchlights, specularity

Adds three new stages after Fal swap completion and before applyFilmTreatment
to close the remaining AI-vs-photo gap on skin texture, eye liveness, and
natural skin highlights:

1. applyFalSkinDetail() — chains fal-ai/face-fix (with clarity-upscaler
   fallback) to add pore-level micro-texture. ~$0.02-0.04 per swap.
2. applyEyeCatchlights() — heuristic detection of iris pixels, adds Gaussian
   specular highlights (blue-white tint mimicking sky reflection). In-Deno,
   no API cost.
3. applySkinSpecularity() — detects warm skin tones, adds subtle highlight
   bloom on cheekbones/forehead/nose. In-Deno, no API cost.

Wired between Fal swap and applyFilmTreatment in the look_id branch only;
VLONE / job_id path unchanged. applyFilmTreatment runs on top to age the
restored detail with grain + warmth.

Future enhancement: replace heuristic catchlight detection with
fal-ai/face-landmark for precise eye targeting. Out of scope for this PR.
```

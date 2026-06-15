# Cursor handoff: film-treatment v2 — land the 6 review improvements + flip default to "light"

## Context

Commit `8d371d6` shipped the 8-stage pipeline successfully — all functions present, edge function redeployed, identity + outfit preserved. But the v5 production test on Pair 2 confirmed exactly what your own pre-ship review predicted:

- **Background HF energy jumped 4.5×** (0.48 → 2.19) — grain is dumping into the studio backdrop where it doesn't belong
- **Background R-B went from -3.3 (cool) to +16.9 (warm)** — warm cast is hitting neutrals, reads as "Instagram filter"
- **Highlight pixels (>230 luma) exploded 250×** (~1,600 → 516,000) — tonal curve + halation too aggressive at "medium" default
- Skin pores survived (lucky — high-freq preservation would've been belt-and-suspenders, not strictly needed)

The 6 review improvements you wrote up before shipping address exactly these failures. None landed in `8d371d6`. This handoff is just landing those 6 + flipping the default. No new architecture.

## Repo + scope

- **File:** `supabase/functions/faceswap-callback/index.ts`
- **Push to `main` directly.** Single PR, no schema, no frontend.
- **No Lovable chat for code.** Chat only for `redeploy edge function faceswap-callback`.

## The 6 changes

### 1. Luminance-based grain (replaces current per-RGB-channel noise)

**Current behavior:** independent noise samples per R/G/B channel = chroma speckle. Reads digital.

**Replace with:** one noise sample per pixel applied to luma, then scale R/G/B proportionally.

```ts
function applyGrain(bitmap: Uint8ClampedArray, sigma: number, desatPct: number): void {
  for (let i = 0; i < bitmap.length; i += 4) {
    const r = bitmap[i], g = bitmap[i + 1], b = bitmap[i + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;

    // ONE noise sample, applied to luma
    let noise = gaussianRandom(0, sigma);

    // Shadow-weighted: stronger grain in shadows, weaker in highlights (real ISO grain behavior)
    const shadowWeight = Math.pow(1 - luma / 255, 0.5);
    noise *= shadowWeight;

    const newLuma = Math.max(0, Math.min(255, luma + noise));
    const scale = newLuma / (luma || 1);

    let newR = r * scale;
    let newG = g * scale;
    let newB = b * scale;

    // Desat toward gray
    const gray = (newR + newG + newB) / 3;
    newR = newR * (1 - desatPct) + gray * desatPct;
    newG = newG * (1 - desatPct) + gray * desatPct;
    newB = newB * (1 - desatPct) + gray * desatPct;

    bitmap[i] = Math.max(0, Math.min(255, newR));
    bitmap[i + 1] = Math.max(0, Math.min(255, newG));
    bitmap[i + 2] = Math.max(0, Math.min(255, newB));
  }
}
```

This bundles improvements **1 (luminance grain)** and **6 (shadow-weighted)** in one function rewrite.

### 2. Organic grain structure (downsample + upscale instead of per-pixel TV static)

**Current behavior:** noise sample per pixel = digital static.

**Replace with:** generate noise at 1/4 resolution into a buffer, upscale with bilinear interpolation + light blur, then add to bitmap. The result has structure like film emulsion rather than per-pixel noise.

Rewrite the grain pass to generate noise at a downsampled resolution first:

```ts
function applyOrganicGrain(bitmap: Uint8ClampedArray, w: number, h: number, sigma: number, desatPct: number): void {
  // Generate noise at 1/4 res
  const dw = Math.ceil(w / 4);
  const dh = Math.ceil(h / 4);
  const noiseLow = new Float32Array(dw * dh);
  for (let i = 0; i < noiseLow.length; i++) {
    noiseLow[i] = gaussianRandom(0, sigma);
  }

  // Bilinear upscale into a full-res noise buffer
  const noiseFull = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y / 4;
    const y0 = Math.floor(sy), y1 = Math.min(dh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = x / 4;
      const x0 = Math.floor(sx), x1 = Math.min(dw - 1, x0 + 1);
      const fx = sx - x0;
      const n00 = noiseLow[y0 * dw + x0];
      const n10 = noiseLow[y0 * dw + x1];
      const n01 = noiseLow[y1 * dw + x0];
      const n11 = noiseLow[y1 * dw + x1];
      noiseFull[y * w + x] = n00 * (1 - fx) * (1 - fy) + n10 * fx * (1 - fy) + n01 * (1 - fx) * fy + n11 * fx * fy;
    }
  }

  // Light Gaussian smoothing on the upscaled noise (separable 1D, sigma 0.5)
  // ... use the same blur helper as applyGaussianBlur but on noiseFull as a single-channel image

  // Apply to bitmap with shadow weighting + luminance scaling
  for (let i = 0, p = 0; i < bitmap.length; i += 4, p++) {
    const r = bitmap[i], g = bitmap[i + 1], b = bitmap[i + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const shadowWeight = Math.pow(1 - luma / 255, 0.5);
    const noise = noiseFull[p] * shadowWeight;
    const newLuma = Math.max(0, Math.min(255, luma + noise));
    const scale = newLuma / (luma || 1);
    let newR = r * scale, newG = g * scale, newB = b * scale;
    const gray = (newR + newG + newB) / 3;
    newR = newR * (1 - desatPct) + gray * desatPct;
    newG = newG * (1 - desatPct) + gray * desatPct;
    newB = newB * (1 - desatPct) + gray * desatPct;
    bitmap[i] = Math.max(0, Math.min(255, newR));
    bitmap[i + 1] = Math.max(0, Math.min(255, newG));
    bitmap[i + 2] = Math.max(0, Math.min(255, newB));
  }
}
```

You can pick: keep `applyGrain` simple (luminance + shadow-weighted, no downsampling — improvement 1+6 only) OR replace with `applyOrganicGrain` (adds improvement 2). I'd ship organic — the 1/4 res downsample is cheap and meaningfully more film-like. Wire `applyOrganicGrain` in place of the current `applyGrain` call in `applyFilmTreatment`.

### 3. High-frequency preservation around the blur

**Current behavior:** blur is applied to the bitmap destructively — pore-level detail can be lost before grain tries to restore it.

**Replace with:** copy original bitmap, blur the copy, then mix back high-frequency detail (original - blurred) at 75-85% strength after the rest of the pipeline.

```ts
async function applyFilmTreatment(imageBlob: Blob, strength: FilmStrength = "light"): Promise<Blob> {
  const arrayBuffer = await imageBlob.arrayBuffer();
  const img = await Image.decode(new Uint8Array(arrayBuffer));
  const w = img.width, h = img.height;
  const bitmap = img.bitmap;

  // NEW: capture original BEFORE any processing
  const original = new Uint8ClampedArray(bitmap);

  const params = { /* same as before */ };

  // Stage 1: Soft blur (destructive — that's fine, we'll add HF back at the end)
  applyGaussianBlur(bitmap, w, h, params.blur);

  // Stages 2-8: grain, halation, tonal, color, etc.
  applyOrganicGrain(bitmap, w, h, params.grainSigma, params.grainDesat);
  applyHalation(bitmap, w, h, 200, params.haloSigma, params.haloIntensity);
  // ... existing tonal, portra, CA, warm cast, vignette stages ...

  // NEW: at the end, add high-frequency detail back from original at 80% strength
  const hfStrength = 0.80;
  for (let i = 0; i < bitmap.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      // Estimate high-freq = original - blurred (approximate the blurred state from the noise-free original convolution result)
      // Cheap shortcut: HF = original - average of original's neighbors
      // OR: re-blur original with same sigma, compute hf = original - re_blurred, add hf * strength
      // (the cleanest is to apply blur to a copy of original and subtract)
    }
  }

  // (Detail below for cleanest implementation)

  const out = await img.encode(95);
  return new Blob([out], { type: "image/jpeg" });
}
```

**Cleanest implementation of HF preservation:**

```ts
// Right after Stage 1 blur, BEFORE any other stages:
const blurred = new Uint8ClampedArray(original);  // copy original
applyGaussianBlur(blurred, w, h, params.blur);    // blur it
// Now `blurred` is what `bitmap` currently looks like (post-blur, pre-everything-else)
// `original` is the unblurred reference

// Stages 2-8 modify `bitmap` (the blurred image) — leave them as-is

// At the very END, before encode:
for (let i = 0; i < bitmap.length; i += 4) {
  for (let c = 0; c < 3; c++) {
    const hf = original[i + c] - blurred[i + c];   // high-frequency component
    const newValue = bitmap[i + c] + hf * hfStrength;
    bitmap[i + c] = Math.max(0, Math.min(255, newValue));
  }
}
```

This means face detail (pores, hair fine strands, fabric weave) survives the blur stage instead of being permanently lost.

### 4. Default strength = "light"

In the `handleLookCallback` wire-up:

```ts
// CURRENT (line ~303):
resultBlob = await applyFilmTreatment(resultBlob, "medium");

// CHANGE TO:
resultBlob = await applyFilmTreatment(resultBlob, "light");
```

Also change the function signature default:

```ts
// CURRENT:
async function applyFilmTreatment(imageBlob: Blob, strength: FilmStrength = "medium"): Promise<Blob>

// CHANGE TO:
async function applyFilmTreatment(imageBlob: Blob, strength: FilmStrength = "light"): Promise<Blob>
```

### 5. Corner-weighted chromatic aberration

**Current behavior:** uniform 1px R/B shift across entire image — invisible in the center where the face is, weird if visible anywhere.

**Replace with:** shift scales with distance from optical center.

```ts
function applyChromaticAberration(bitmap: Uint8ClampedArray, w: number, h: number, maxShiftPx = 2): void {
  const cx = w / 2, cy = h / 2;
  const maxR = Math.sqrt(cx * cx + cy * cy);
  const original = new Uint8ClampedArray(bitmap);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy) / maxR;
      // Shift scales with r^2 (real CA grows quadratically with distance from center)
      const shift = Math.round(maxShiftPx * r * r);
      if (shift === 0) continue;

      const idx = (y * w + x) * 4;
      const rx = Math.min(w - 1, x + shift);
      bitmap[idx] = original[(y * w + rx) * 4];
      const bx = Math.max(0, x - shift);
      bitmap[idx + 2] = original[(y * w + bx) * 4 + 2];
    }
  }
}
```

Strength params: light maxShiftPx=2, medium maxShiftPx=2, heavy maxShiftPx=3. (Subtle is fine — CA shouldn't dominate.)

### 6. (Already covered by change #1 — shadow-weighted grain is folded into the luminance-grain rewrite)

The shadow weighting `Math.pow(1 - luma/255, 0.5)` in the new `applyGrain` / `applyOrganicGrain` function from change #1 IS improvement #6. The two are interdependent — luminance-scaled grain naturally invites shadow weighting on the noise term.

## What this delta addresses from the v5 test

| v5 failure | Fix |
|---|---|
| Background HF +358% (grain dumping into studio backdrop) | Shadow-weighted grain (#1) — backdrop is bright, gets little noise |
| Background R-B +20 (warm cast hitting neutrals) | Default "light" (#4) — tonalBlend 0.6 instead of 1.0, halation 0.25 instead of 0.40 |
| Highlight pixels 250× explosion (tonal over-cooking) | Default "light" (#4) |
| Chroma speckle vs film grain | Luminance grain (#1) |
| Per-pixel TV static structure | Organic grain downsample/upscale (#2) |
| Skin detail risk from blur | High-freq preservation (#3) |
| CA invisible center / weird edges | Corner-weighted CA (#5) |

## Test plan after pushing

Same as last time:

1. Lovable chat: `redeploy edge function faceswap-callback`
2. Wait for confirmation
3. Re-run Apply-my-identity on Pair 2: `https://aivideotool.lovable.app/artists/8d4a4d22-41c0-43ab-ba99-92750f81e335/looks/6880cd16-22bb-45ba-aada-14552ea56742`
4. Expected wins on v6 vs v5:
   - Background HF should drop from 2.19 closer to v2's 0.48 (shadow-weighted grain killing the backdrop grain)
   - Background R-B should drop from +16.9 closer to neutral (light default + tonalBlend 0.6)
   - Skin grain still present (it's in shadow/midtone areas where shadowWeight is highest)
   - Halation visible but subtle (intensity 0.25 vs 0.40)
   - Skin pores still visible (HF preservation)
   - CA visible at corners only

## Hard rules

- **No Lovable chat for code.** Only `redeploy edge function faceswap-callback`.
- **No schema changes.**
- **Don't touch `faceswap-proxy`, frontend, or VLONE / `job_id` branch.**
- **Single PR, push to main directly.**

## Commit message

```
fix(avt): apply v2 review improvements to film treatment

- Replace per-channel RGB noise with luminance-based grain (one noise
  sample per pixel applied to luma, RGB scaled proportionally)
- Add shadow-weighted grain (noise stronger in shadows, weaker in
  highlights — real ISO grain behavior)
- Use organic grain structure (noise generated at 1/4 res, upscaled
  with bilinear interp) instead of per-pixel digital noise
- Add high-frequency preservation around the blur stage (preserve
  pore-level detail by mixing back original HF after pipeline)
- Corner-weighted chromatic aberration (shift scales with r^2 from
  optical center, not uniform)
- Flip default strength from "medium" to "light" (medium was over-
  driving the warm cast, tonal curve, and halation — light has the
  same stages but at conservative intensity)

Addresses overcooking observed in commit 8d371d6 production test:
background HF +358%, R-B +20 warmth bleed, highlight band 250× explosion.
```

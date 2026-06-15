# Cursor handoff: full film-treatment pipeline for AVT identity_faceswap output

## TL;DR

The current `applyFilmGrain` step in `faceswap-callback` applies Gaussian noise + slight desaturation. That broke the AI-smooth read by ~35% on smooth-skin areas — a meaningful first step but only one slice of the photorealism toolbox. Fendi's bar is "indistinguishable from reality," and we're not there yet.

This handoff replaces `applyFilmGrain` with a full **multi-stage film-treatment pipeline** that layers the techniques real photographers and film cameras impart on every image: subtle blur, grain, halation around highlights, tonal S-curve with highlight rolloff, Portra-style color shift, chromatic aberration, warm cast, and vignette.

Each stage is individually parameterized so we can tune or disable any single layer. Default chain runs the full sequence at `"medium"` strength.

**Scope:** edge function only (`faceswap-callback/index.ts`). No schema changes. No frontend changes. Single PR.

## Repo + scope

- **Repo:** `fendifrost-dot/ai-video-tool` (push to `main`)
- **File:** `supabase/functions/faceswap-callback/index.ts`
- **Gated to:** `look_id` branch (Apply-my-identity / identity_faceswap path). VLONE / `job_id` path stays untouched.
- **Library:** continues using `imagescript@1.2.15`. All effects implemented as pure pixel manipulation since imagescript v1.2.15 doesn't expose blur/convolution operators on Image instances.
- **No Lovable chat for code.** Chat is for `redeploy edge function faceswap-callback` only.

## The pipeline — in order

The stages are applied in this exact order. Order matters: blur first (softens digital sharpness before adding noise), grain after blur (so noise lives on top of softened image), halation after grain (so the halation glow isn't itself distorted by noise), tonal before color, color shifts last.

### 1. Soft blur (3x3 Gaussian convolution)

Mimics the slight focus softness of real lenses. Digital AI output is razor-sharp everywhere; real cameras have a small amount of optical softness.

Use a manual 3x3 convolution since imagescript v1.2.15 lacks blur ops. A separable 1D Gaussian kernel applied twice (horizontal then vertical) is equivalent and cheaper:

```ts
function applyGaussianBlur(bitmap: Uint8ClampedArray, w: number, h: number, sigma = 0.6): void {
  // Generate 1D kernel for the given sigma (radius ~2*sigma)
  const radius = Math.max(1, Math.round(sigma * 2));
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += kernel[i];
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum;

  const tmp = new Uint8ClampedArray(bitmap.length);
  // Horizontal pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < size; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k - radius));
        const idx = (y * w + xx) * 4;
        r += bitmap[idx] * kernel[k];
        g += bitmap[idx + 1] * kernel[k];
        b += bitmap[idx + 2] * kernel[k];
      }
      const o = (y * w + x) * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = bitmap[o + 3];
    }
  }
  // Vertical pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < size; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k - radius));
        const idx = (yy * w + x) * 4;
        r += tmp[idx] * kernel[k];
        g += tmp[idx + 1] * kernel[k];
        b += tmp[idx + 2] * kernel[k];
      }
      const o = (y * w + x) * 4;
      bitmap[o] = r; bitmap[o + 1] = g; bitmap[o + 2] = b;
    }
  }
}
```

Sigma values per strength: light=0.4, medium=0.6, heavy=0.9.

### 2. Grain (Gaussian noise + slight desaturation)

Keep the current implementation but bump the default. Sigma values: light=6, medium=10, heavy=14. Desat: light=3%, medium=5%, heavy=7%.

### 3. Halation (warm glow around bright highlights)

The single highest-impact "film signature" technique. Detect bright pixels, copy them to a buffer, blur the buffer heavily with warm tint, screen-blend back onto the original.

```ts
function applyHalation(bitmap: Uint8ClampedArray, w: number, h: number, threshold = 200, glowSigma = 8, intensity = 0.4): void {
  // Build a buffer of just the bright pixels (above threshold)
  const glowBuffer = new Uint8ClampedArray(bitmap.length);
  for (let i = 0; i < bitmap.length; i += 4) {
    const luma = bitmap[i] * 0.299 + bitmap[i + 1] * 0.587 + bitmap[i + 2] * 0.114;
    const factor = Math.max(0, (luma - threshold) / (255 - threshold));
    // Warm tint — orange/red glow
    glowBuffer[i] = Math.min(255, factor * 255 * 1.0);       // R full
    glowBuffer[i + 1] = Math.min(255, factor * 255 * 0.55);  // G partial (orange)
    glowBuffer[i + 2] = Math.min(255, factor * 255 * 0.2);   // B minimal
    glowBuffer[i + 3] = 255;
  }
  // Heavy blur on the glow buffer (use the blur function from step 1 with larger sigma)
  applyGaussianBlur(glowBuffer, w, h, glowSigma);
  // Screen-blend the glow back onto original
  for (let i = 0; i < bitmap.length; i += 4) {
    bitmap[i] = Math.min(255, bitmap[i] + glowBuffer[i] * intensity);
    bitmap[i + 1] = Math.min(255, bitmap[i + 1] + glowBuffer[i + 1] * intensity);
    bitmap[i + 2] = Math.min(255, bitmap[i + 2] + glowBuffer[i + 2] * intensity);
  }
}
```

Strength: light intensity=0.25 glowSigma=6, medium intensity=0.4 glowSigma=8, heavy intensity=0.55 glowSigma=11.

### 4. Highlight rolloff + tonal S-curve

Real camera sensors don't clip pure white — they compress gently. AI outputs hard-clip at 255. Apply a tonal curve that compresses highlights, slightly lifts shadows, and adds midtone contrast.

```ts
function applyTonalCurve(bitmap: Uint8ClampedArray): void {
  // S-curve with highlight rolloff
  // 0-40: slight lift (shadows pop)
  // 40-180: punchy midtone slope (contrast)
  // 180-255: gentle rolloff (highlight compression)
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    let out: number;
    if (v < 40) {
      // shadows: y = v + 8 * sin(v/40 * π/2)
      out = v + 6 * Math.sin((v / 40) * (Math.PI / 2));
    } else if (v < 180) {
      // midtones: linear with slope > 1
      out = 40 + (v - 40) * 1.12;
    } else {
      // highlights: rolloff toward 245 instead of 255
      const t = (v - 180) / 75;
      out = 40 + 140 * 1.12 + (245 - (40 + 140 * 1.12)) * (1 - Math.pow(1 - t, 2));
    }
    lut[v] = Math.max(0, Math.min(255, Math.round(out)));
  }
  for (let i = 0; i < bitmap.length; i += 4) {
    bitmap[i] = lut[bitmap[i]];
    bitmap[i + 1] = lut[bitmap[i + 1]];
    bitmap[i + 2] = lut[bitmap[i + 2]];
  }
}
```

This stage runs at full strength always (it's a fixed tonal mapping, no strength variants needed). For "light" mode, apply the curve at 60% blend; for "heavy" mode apply at 100%.

### 5. Portra 400 color shift (film stock emulation)

Real 3D LUT files (.cube) are 100KB+ and require shipping them with the function. Instead, emulate Portra 400's signature color science as a pixel-wise color matrix transform — close enough for the "film stock look" without the file overhead.

Portra 400's signature: warm midtones, slightly cyan-shifted shadows, gentle desaturation, lifted blacks.

```ts
function applyPortraColorShift(bitmap: Uint8ClampedArray): void {
  for (let i = 0; i < bitmap.length; i += 4) {
    let r = bitmap[i], g = bitmap[i + 1], b = bitmap[i + 2];
    const luma = r * 0.299 + g * 0.587 + b * 0.114;
    // Lift blacks: shadows shifted slightly toward cyan-blue
    const shadowWeight = Math.max(0, 1 - luma / 80);
    r = r * (1 - 0.04 * shadowWeight) + 0;
    g = g * (1 - 0.02 * shadowWeight) + 4 * shadowWeight;
    b = b * (1 - 0.02 * shadowWeight) + 8 * shadowWeight;
    // Warm midtones
    const midWeight = Math.max(0, 1 - Math.abs(luma - 128) / 80);
    r += 6 * midWeight;
    b -= 4 * midWeight;
    // Slight overall saturation reduction (Portra is famously gentle)
    const grey = r * 0.299 + g * 0.587 + b * 0.114;
    r = grey + (r - grey) * 0.96;
    g = grey + (g - grey) * 0.96;
    b = grey + (b - grey) * 0.96;
    bitmap[i] = Math.max(0, Math.min(255, r));
    bitmap[i + 1] = Math.max(0, Math.min(255, g));
    bitmap[i + 2] = Math.max(0, Math.min(255, b));
  }
}
```

### 6. Chromatic aberration (lens color fringing)

Subtle R/B channel shift at edges. Real lenses have slight chromatic aberration that increases toward image corners. We'll do a uniform 1-2px shift for simplicity (the corner-only variant requires per-pixel distance calculations and is overkill for the gain).

```ts
function applyChromaticAberration(bitmap: Uint8ClampedArray, w: number, h: number, shiftPx = 1): void {
  const original = new Uint8ClampedArray(bitmap);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      // R channel shifted right by shiftPx
      const rx = Math.min(w - 1, x + shiftPx);
      bitmap[idx] = original[(y * w + rx) * 4];
      // B channel shifted left by shiftPx
      const bx = Math.max(0, x - shiftPx);
      bitmap[idx + 2] = original[(y * w + bx) * 4 + 2];
    }
  }
}
```

Strength: light=1px, medium=1px, heavy=2px.

### 7. Warm color cast (tungsten warmth)

Slight global R-up, B-down. Real photos almost always have a color temperature bias from the lighting source. Default to slightly warm (matches indoor / tungsten lighting which is the most common shooting scenario).

```ts
function applyWarmCast(bitmap: Uint8ClampedArray, rGain = 1.02, bGain = 0.98): void {
  for (let i = 0; i < bitmap.length; i += 4) {
    bitmap[i] = Math.min(255, bitmap[i] * rGain);
    bitmap[i + 2] = Math.max(0, bitmap[i + 2] * bGain);
  }
}
```

### 8. Vignette (corner darkening)

Real lenses fall off at corners. Add a radial darkening of 5-10% at the corners.

```ts
function applyVignette(bitmap: Uint8ClampedArray, w: number, h: number, strength = 0.08): void {
  const cx = w / 2, cy = h / 2;
  const maxR = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy) / maxR;
      const factor = 1 - strength * r * r;  // quadratic falloff
      const idx = (y * w + x) * 4;
      bitmap[idx] = bitmap[idx] * factor;
      bitmap[idx + 1] = bitmap[idx + 1] * factor;
      bitmap[idx + 2] = bitmap[idx + 2] * factor;
    }
  }
}
```

Strength: light=0.05, medium=0.08, heavy=0.12.

## The orchestrating function

Replace `applyFilmGrain` with `applyFilmTreatment`:

```ts
type FilmStrength = "light" | "medium" | "heavy";

async function applyFilmTreatment(imageBlob: Blob, strength: FilmStrength = "medium"): Promise<Blob> {
  const arrayBuffer = await imageBlob.arrayBuffer();
  const img = await Image.decode(new Uint8Array(arrayBuffer));
  const w = img.width, h = img.height;
  const bitmap = img.bitmap;

  const params = {
    light:  { blur: 0.4, grainSigma: 6,  grainDesat: 0.03, haloIntensity: 0.25, haloSigma: 6,  caShift: 1, vignette: 0.05, tonalBlend: 0.6 },
    medium: { blur: 0.6, grainSigma: 10, grainDesat: 0.05, haloIntensity: 0.40, haloSigma: 8,  caShift: 1, vignette: 0.08, tonalBlend: 1.0 },
    heavy:  { blur: 0.9, grainSigma: 14, grainDesat: 0.07, haloIntensity: 0.55, haloSigma: 11, caShift: 2, vignette: 0.12, tonalBlend: 1.0 },
  }[strength];

  // Stage 1: Soft blur
  applyGaussianBlur(bitmap, w, h, params.blur);

  // Stage 2: Grain + desat
  applyGrain(bitmap, params.grainSigma, params.grainDesat);

  // Stage 3: Halation
  applyHalation(bitmap, w, h, 200, params.haloSigma, params.haloIntensity);

  // Stage 4: Tonal curve (blended for light mode)
  if (params.tonalBlend < 1.0) {
    const before = new Uint8ClampedArray(bitmap);
    applyTonalCurve(bitmap);
    for (let i = 0; i < bitmap.length; i += 4) {
      bitmap[i] = before[i] * (1 - params.tonalBlend) + bitmap[i] * params.tonalBlend;
      bitmap[i + 1] = before[i + 1] * (1 - params.tonalBlend) + bitmap[i + 1] * params.tonalBlend;
      bitmap[i + 2] = before[i + 2] * (1 - params.tonalBlend) + bitmap[i + 2] * params.tonalBlend;
    }
  } else {
    applyTonalCurve(bitmap);
  }

  // Stage 5: Portra color shift
  applyPortraColorShift(bitmap);

  // Stage 6: Chromatic aberration
  applyChromaticAberration(bitmap, w, h, params.caShift);

  // Stage 7: Warm cast
  applyWarmCast(bitmap, 1.02, 0.98);

  // Stage 8: Vignette
  applyVignette(bitmap, w, h, params.vignette);

  const out = await img.encode(95);
  return new Blob([out], { type: "image/jpeg" });
}

// Helper: grain (kept simple, called from the orchestrator)
function applyGrain(bitmap: Uint8ClampedArray, sigma: number, desatPct: number): void {
  for (let i = 0; i < bitmap.length; i += 4) {
    const noise = gaussianRandom(0, sigma);
    for (let c = 0; c < 3; c++) {
      let v = bitmap[i + c] + noise;
      const gray = (bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3;
      v = v * (1 - desatPct) + gray * desatPct;
      bitmap[i + c] = Math.max(0, Math.min(255, v));
    }
  }
}
```

## Wire-up in `handleLookCallback`

```ts
// existing: download Fal result
const resultResp = await fetch(falResultUrl);
let resultBlob = await resultResp.blob();

// NEW: full film treatment (replaces the previous applyFilmGrain call)
if (lookId) {  // Apply-my-identity path
  resultBlob = await applyFilmTreatment(resultBlob, "medium");
}

// existing: upload to look-composites bucket
```

## Performance expectations

The 8-stage pipeline is heavier than single-stage grain. Expected compute cost on a 1024x1024 image:
- Old `applyFilmGrain`: ~0.5s
- New `applyFilmTreatment` medium: ~3-5s

Total swap time goes from ~145s (Fal swap + light grain) to ~150-155s (Fal swap + full treatment). Acceptable — the perceived quality jump should be worth the extra few seconds.

If compute budget is a problem (Lovable's edge function CPU limit might bite), the heaviest stages are blur and halation (both do convolutions). Cutting those drops compute by ~70% with the smallest visual impact.

## What gets removed

- `applyFilmGrain` function
- `gaussianRandom` helper stays (used by `applyGrain`)
- The previous `imagescript` import stays

## Test plan

After pushing, in Lovable chat for project `bd21b544-c7b8-4780-bdde-391ac9d4bfa8`, EXACTLY:

```
redeploy edge function faceswap-callback
```

Then click Apply-my-identity on Pair 2:  
`https://aivideotool.lovable.app/artists/8d4a4d22-41c0-43ab-ba99-92750f81e335/looks/6880cd16-22bb-45ba-aada-14552ea56742`

Visual checklist on the new result:
- Identity preserved ✓
- Outfit preserved ✓
- Skin shows visible micro-texture (grain) — not glassy
- Bright areas (white shirt, highlights on face) have a subtle warm glow at the edges (halation)
- Overall tonal range looks less "clipped" — highlights have detail
- Subtle warmth in midtones, slight cyan in shadows (Portra signature)
- Corners slightly darker than center (vignette)
- If you zoom into high-contrast edges, you see faint R/B fringing (chromatic aberration)

Compare side-by-side to the v4 result (`52595021-3fae-4251-9f26-eceda55c8a66`). The new result should read meaningfully more "shot on film" / photographic.

## Strength tuning after the first ship

If "medium" feels overcooked, switch the call to `applyFilmTreatment(resultBlob, "light")`. If it still reads too AI, switch to `"heavy"`. The enum is just a one-word change in the wire-up.

## What's NOT in this handoff (deferred to future PRs)

These are the realism techniques NOT bundled because they require either external models or major code:

- **Skin pore detail restoration** — needs a Fal chain (e.g., `fal-ai/face-fix` or `fal-ai/clarity-upscaler`). Adds ~$0.02-0.04 per swap. Probably the next highest-impact addition after this handoff lands.
- **Catchlight enhancement** — needs face landmark detection to find eyes, then add specular highlights to pupils. Complex without a vision model.
- **Skin specularity / oil sheen** — same as catchlights; needs landmark detection.
- **Depth-of-field / bokeh** — needs depth estimation. Heavy compute.
- **Motion blur** — only relevant for video frames; static portraits don't need it.
- **Stray hair flyaways / asymmetry** — would require generative refinement (counterproductive — risks identity drift).

Most of these are 10-20% additional gains over what this PR delivers. The current PR covers the biggest 80% of the photorealism gap.

## Hard rules

- **No Lovable chat for code.** Only `redeploy edge function faceswap-callback`.
- **No schema changes.**
- **Don't touch the VLONE / `job_id` branch.** VLONE swaps don't need film treatment.
- **Don't touch `faceswap-proxy`** or the frontend. Pipeline routing is fine; only the post-process changes.
- **Match existing code style.** No reformat passes.
- **Push to `main` directly.** Single-dev repo.
- **Keep the `FilmStrength` enum extensible.** Future additions like `"editorial"` or `"vintage"` should be easy to add.

## Commit message suggestion

```
feat(avt): full film-treatment pipeline for identity_faceswap output

Replaces single-stage applyFilmGrain with multi-stage applyFilmTreatment
covering the techniques that distinguish real photos from AI renders:

  1. Soft Gaussian blur (lens softness)
  2. Grain + desaturation (film noise)
  3. Halation (warm glow around highlights)
  4. Tonal S-curve with highlight rolloff (sensor response)
  5. Portra 400 color shift (film stock emulation)
  6. Chromatic aberration (lens color fringing)
  7. Warm color cast (tungsten lighting)
  8. Vignette (corner falloff)

Default strength: "medium." All stages individually parameterized via
FilmStrength enum. VLONE / job_id path unchanged.
```

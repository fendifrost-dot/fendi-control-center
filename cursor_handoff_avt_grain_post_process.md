# Cursor handoff: add film-grain post-process to AVT Apply-my-identity output

## TL;DR

After the Fal `identity-faceswap` chain completes (currently producing identity-locked, outfit-preserved swaps via the new `faceswap-proxy → faceswap-generate → Fal → faceswap-callback → identity_faceswap` chain), the output reads as "AI-rendered" because the source Grok image carries that hyper-smooth aesthetic and the swap inherits it. Fendi's diagnosis: identity is fine, the AI-smooth resolution is what's throwing him off.

The fix: add a **light film-grain post-process step** to the swap callback so every Apply-my-identity output gets a small dose of real-camera texture (ISO grain + micro-noise + subtle desaturation + optional chromatic aberration) before it's written to `artist_looks`. Output reads as a 35mm portrait, not an AI render.

This is a single-step addition to `faceswap-callback`. No model upgrade, no schema change, no UI change.

## Repo + scope

- **Repo:** `fendifrost-dot/ai-video-tool` (push to `main`)
- **Edge function to modify:** `supabase/functions/faceswap-callback/index.ts`
- **No schema changes.** Pure code addition.
- **No Lovable chat** for code. Code through GitHub `main`, redeploy via chat.

## What "good" grain looks like

A smoke test on the v2 Pair 2 swap result (`8f748d64-...`) produced two grain variants for visual comparison:

- **Variant A (light grain):** Gaussian noise σ≈6, slight Gaussian softening (radius 0.4) to mimic film, 3% desaturation. Should read as 35mm at ISO 400.
- **Variant B (stronger grain):** Gaussian noise σ≈10-12, slight chromatic aberration (1-2px R/B channel shift), 5% desaturation. Should read as 35mm at ISO 800.

Use the lighter variant (A) as default. Strong grain risks looking gimmicky — we want subtle "real photo" texture, not Instagram filter.

The smoke-test script (saved alongside this handoff) is in `outputs/grain_smoke.py` from session `local_634625af-8241-4d6b-bb47-e650d8622d62` — the algorithm is reproducible in either Python or TypeScript.

## The change

### Current behavior (faceswap-callback)

When Fal sends the webhook with the swap result:
1. Download Fal result image
2. Upload to `look-composites` bucket
3. Mark child look `complete` with `pipeline_used: "identity_faceswap"`

### Desired behavior (with grain post-process)

Same steps, but between (1) and (2): apply film-grain transformation to the downloaded image before uploading. The grain step is gated to ONLY run for `pipeline_used: "identity_faceswap"` — don't apply grain to other swap flows (VLONE / project_assets path) unless explicitly opted in.

### Implementation in TypeScript (Deno runtime — Lovable edge functions)

Add this helper inside `faceswap-callback/index.ts`:

```ts
async function applyFilmGrain(imageBlob: Blob, strength: "light" | "medium" = "light"): Promise<Blob> {
  // Decode image to ImageData
  const arrayBuffer = await imageBlob.arrayBuffer();
  const img = await Image.decode(new Uint8Array(arrayBuffer)); // imagescript or equivalent

  const sigma = strength === "light" ? 6 : 11;
  const desatPct = strength === "light" ? 0.03 : 0.05;

  // Apply Gaussian noise per pixel + slight desat
  for (let i = 0; i < img.bitmap.length; i += 4) {
    const noise = gaussianRandom(0, sigma);
    for (let c = 0; c < 3; c++) {
      const v = img.bitmap[i + c] + noise;
      // desaturate toward gray
      const gray = (img.bitmap[i] + img.bitmap[i + 1] + img.bitmap[i + 2]) / 3;
      img.bitmap[i + c] = Math.max(0, Math.min(255, v * (1 - desatPct) + gray * desatPct));
    }
  }

  // Light Gaussian blur on noise for film feel (very subtle, radius ~0.4)
  // Most TS image libs support .blur(radius) — call at radius 0.4 to 0.5

  const out = await img.encode(95); // JPEG quality 95
  return new Blob([out], { type: "image/jpeg" });
}

// Box-Muller for Gaussian random
function gaussianRandom(mean = 0, stdDev = 1): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stdDev;
}
```

Then in the callback's main flow, after downloading Fal's result and BEFORE uploading to storage:

```ts
// existing code: download Fal result
const resultResp = await fetch(falResultUrl);
let resultBlob = await resultResp.blob();

// NEW: apply grain if this is the identity_faceswap path
if (lookId) {  // i.e., parent_look_id path, the Apply-my-identity flow
  resultBlob = await applyFilmGrain(resultBlob, "light");
}

// existing code: upload to look-composites bucket
const uploadResult = await supabase.storage
  .from("look-composites")
  .upload(targetPath, resultBlob, { contentType: "image/jpeg", upsert: true });
```

### Library choice for Deno

Deno doesn't have PIL/numpy. Two viable options:

1. **`imagescript`** (`https://deno.land/x/imagescript`) — pure-TS image decoder/encoder with bitmap access. Smallest dependency, simplest.
2. **`std/imagescript` polyfill** if `imagescript` not available — use `Image.decode()` from `@oslojs/imageprocess` or similar.

Pick whichever works in the Lovable Deno runtime. If neither is easily available, a third option:

3. **Defer grain to a separate Fal call** — Fal has a `fal-ai/film-grain` operator. Add a second Fal call after the swap completes: pass the swap result through Fal's grain model. Adds ~$0.01-0.02 and ~5s latency per identity job. Cleanest if Deno bitmap libs are problematic.

If you go with option 3 (Fal grain), the change is even smaller — just chain a second `fetch` to `https://queue.fal.run/fal-ai/film-grain` after Fal returns the swap result, swap in that result before uploading.

### Recommended: try option 1 first

Pure-TS grain is fastest, free, and Deno-native. Falls back to option 3 if `imagescript` doesn't load cleanly in Lovable's edge runtime.

## Discovery — verify these paths before editing

```bash
cd ai-video-tool

# Find the callback file
ls supabase/functions/faceswap-callback/

# Confirm current flow (where it downloads + uploads)
grep -n "fetch\|storage.from\|upload\|download" supabase/functions/faceswap-callback/index.ts

# Confirm the look_id branch (the Apply-my-identity path)
grep -n "look_id\|parent_look_id" supabase/functions/faceswap-callback/index.ts

# Check if imagescript is already imported anywhere
grep -rn "imagescript" supabase/functions/
```

## Test plan after pushing

1. **Redeploy via Lovable chat** for project `bd21b544-c7b8-4780-bdde-391ac9d4bfa8`, EXACTLY:
   ```
   redeploy edge function faceswap-callback
   ```
   Wait for confirmation.

2. **Re-run Apply-my-identity on Pair 2** at `https://aivideotool.lovable.app/artists/8d4a4d22-41c0-43ab-ba99-92750f81e335/looks/6880cd16-22bb-45ba-aada-14552ea56742`.

3. **Visual verification:**
   - Identity should still be locked (same as v2)
   - Outfit should still be preserved (denim trucker + tie unchanged)
   - **New:** skin should have visible micro-noise / grain on close inspection. Look at smooth areas like cheeks and forehead — they should have texture, not be glassy
   - **Critical:** grain should be subtle. If the image looks like it was passed through a heavy filter, the strength is too high — drop sigma from 6 to 4 or skip the chromatic aberration

4. **Compare to the v2 result (`8f748d64-...`):**
   - Side-by-side, the new output should read more like a 35mm camera shot
   - Reduced "AI-rendered" sheen
   - No identity drift, no outfit changes

## Knobs Fendi might want to tune later

- **Grain strength:** `"light"` (default) vs `"medium"` (stronger ISO 800 feel). Easy enum to toggle.
- **Disable for specific looks:** if some swaps are meant to read as polished/editorial (no grain), add a `skip_grain: true` flag on the request that's passed through to the callback.
- **Per-artist preference:** could later be stored in `identity_profile_json.grain_strength` so different artists can have different aesthetic defaults.

These are future enhancements — out of scope for THIS handoff. Keep it simple: one grain step, gated to `identity_faceswap`, light by default.

## Hard rules (carry into Cursor session)

- **No Lovable chat** for code. Lovable chat is for `redeploy edge function faceswap-callback` only.
- **No schema changes.** This is a code-only edge function edit.
- **No changes to faceswap-proxy or the frontend.** Pipeline routing is fine; only the post-process step is new.
- **Single-dev repo, push to `main` directly.**
- **Match existing code style.** No reformat passes.
- **Don't apply grain to the VLONE path** (where `job_id` is set instead of `look_id`). VLONE swaps already work cleanly and don't have the AI-smooth source problem.

## Commit message suggestion

```
feat(avt): add film-grain post-process to identity_faceswap callback

Apply-my-identity outputs were inheriting Grok's hyper-smooth AI aesthetic
from source canvases, causing results to read as "AI-rendered" even when
identity transfer was successful. Add a light film-grain pass (Gaussian
noise σ=6, slight desaturation, subtle softening) to the swap result before
uploading. Only applies to identity_faceswap path (look_id present); VLONE
flow (job_id present) is unchanged.

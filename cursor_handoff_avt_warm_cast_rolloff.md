# Cursor handoff: warm-cast highlight protection + neutral protection

## Context

v7 (commit `0b4825b`) locked grain in the right place: skin reads subtle, backdrop stays clean, highlight texture preserved. Fendi: "much better."

The remaining gap: **warm cast still bleeds onto bright neutrals.** Studio backdrop measures R−B ≈ +18 (vs grok source's −3 to −6, i.e., subtly cool). The current `applyWarmCast` and `applyPortraColorShift` apply globally regardless of luma or saturation, so a clean white/gray backdrop gets the same warm shift as Fendi's face would.

Real photographers don't warm an already-white backdrop — they warm the skin tones. We need the warm stages to gate themselves to (a) non-highlight luma AND (b) non-neutral pixels (pixels that actually have color).

## The change — two gating helpers + one-line tweaks

### Helper 1: highlight protection factor

Add this helper near `gaussianRandom`:

```ts
/**
 * Returns 1.0 for shadow/midtone pixels, rolls off to 0.0 above luma 180.
 * Use to multiply the DELTA of a color-shifting stage so highlights stay neutral.
 */
function highlightProtection(luma: number): number {
  if (luma <= 180) return 1.0;
  if (luma >= 255) return 0.0;
  return 1.0 - (luma - 180) / 75;
}
```

### Helper 2: color presence factor (saturation gating)

```ts
/**
 * Returns ~0 for neutral pixels (R≈G≈B), ~1 for saturated pixels.
 * Use to skip warm shifts on white/gray backdrops while still warming skin.
 */
function colorPresence(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  const saturation = (max - min) / max;
  // Boost moderately saturated pixels to 1.0, leave near-neutral at ~0
  return Math.min(1.0, saturation * 5);
}
```

### Tweak 1: `applyWarmCast` — gate by both factors

```ts
// CURRENT:
function applyWarmCast(bitmap: Uint8ClampedArray, rGain = 1.02, bGain = 0.98): void {
  for (let i = 0; i < bitmap.length; i += 4) {
    bitmap[i] = Math.min(255, bitmap[i] * rGain);
    bitmap[i + 2] = Math.max(0, bitmap[i + 2] * bGain);
  }
}

// CHANGE TO:
function applyWarmCast(bitmap: Uint8ClampedArray, rGain = 1.02, bGain = 0.98): void {
  for (let i = 0; i < bitmap.length; i += 4) {
    const r = bitmap[i], g = bitmap[i + 1], b = bitmap[i + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;

    const gate = highlightProtection(luma) * colorPresence(r, g, b);

    // Apply the warm shift as a delta scaled by the gate
    const rDelta = (r * rGain - r) * gate;
    const bDelta = (b * bGain - b) * gate;

    bitmap[i] = Math.min(255, r + rDelta);
    bitmap[i + 2] = Math.max(0, b + bDelta);
  }
}
```

### Tweak 2: `applyPortraColorShift` — gate the mid-tone warming + shadow tinting

The Portra function does three things: lifts blacks toward cyan-blue (shadow weight), warms midtones, slight overall desaturation. Gate the midtone warming AND the shadow tint by `colorPresence` so a neutral backdrop doesn't pick up the color shifts. Highlights are already rolling off via `highlightProtection`.

```ts
function applyPortraColorShift(bitmap: Uint8ClampedArray): void {
  for (let i = 0; i < bitmap.length; i += 4) {
    let r = bitmap[i], g = bitmap[i + 1], b = bitmap[i + 2];
    const luma = r * 0.299 + g * 0.587 + b * 0.114;

    // NEW: gate the color-shifting parts by saturation so neutrals stay neutral
    const cp = colorPresence(r, g, b);
    const hp = highlightProtection(luma);
    const gate = cp * hp;

    // Lift blacks: shadows shifted slightly toward cyan-blue — gated
    const shadowWeight = Math.max(0, 1 - luma / 80);
    r = r * (1 - 0.04 * shadowWeight * gate) + 0;
    g = g * (1 - 0.02 * shadowWeight * gate) + 4 * shadowWeight * gate;
    b = b * (1 - 0.02 * shadowWeight * gate) + 8 * shadowWeight * gate;

    // Warm midtones — gated
    const midWeight = Math.max(0, 1 - Math.abs(luma - 128) / 80);
    r += 6 * midWeight * gate;
    b -= 4 * midWeight * gate;

    // Overall saturation reduction — this can stay un-gated (it's subtle and applies to all)
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

### Halation — leave alone

Halation is already threshold-based (`luma > 200`). It correctly fires only on bright areas, which is what it's designed to do. The halation glow CAN add warmth to highlight edges but that's a real film phenomenon — leave it. If after this PR the halation feels too warm on the v8 test, we can tune the warm tint ratio (currently `1.0 / 0.55 / 0.2` for R/G/B) but not in this PR.

## What this fixes

| Failure (from v6/v7 measurements) | Fix |
|---|---|
| Background R−B +18 (warm) vs grok −3 (cool) | `colorPresence` gates warm cast and Portra shifts away from low-saturation pixels (white/gray backdrop) |
| Highlight R−B +14 (warm) vs grok +1 (neutral) | `highlightProtection` rolls off warm shifts above luma 180 |
| Skin tones still get full warmth | Skin is mid-luma + saturated → gate ≈ 1.0 → no change to skin warming |

## Hard rules

- No Lovable chat for code. Only `redeploy edge function faceswap-callback`.
- No schema changes.
- Don't touch grain stages, blur, halation, tonal curve, CA, or vignette.
- Push to main directly.

## Test plan after pushing

1. Lovable chat: `redeploy edge function faceswap-callback`
2. Wait for confirm
3. Re-run Apply-my-identity on Pair 2: `https://aivideotool.lovable.app/artists/8d4a4d22-41c0-43ab-ba99-92750f81e335/looks/6880cd16-22bb-45ba-aada-14552ea56742`
4. Expected v8 measurements vs v7:
   - Background R−B: drop from +18 toward 0 to +5 (close to grok's −3 to −6 — film WILL add some warmth but should be subtle on neutrals)
   - Highlight R−B: drop from +14 toward +2 to +6 (close to grok's +1)
   - Cheek R−B: should change very little (skin is saturated mid-luma, full warmth still applies)
   - Grain stats unchanged (no grain pipeline changes)

Visual expectation:
- Backdrop reads neutral / lightly warm instead of cream-tinted
- Highlights on shirt + bright face areas read whiter instead of peachy
- Skin still has the warm film tonality
- Identity + outfit unchanged

## Commit message

```
fix(avt): gate warm-cast and Portra shifts by luma and saturation

Backdrop neutrals and bright highlights were getting the same warm shift
as skin tones, producing a cream-tinted backdrop and orange-warm highlights
on Pair 2 production tests (R-B +18 background, +14 highlight vs grok's
-3 and +1).

Add two gating helpers:
- highlightProtection(luma): 1.0 below luma 180, linear rolloff to 0.0
  at luma 255
- colorPresence(r,g,b): saturation-based, 0.0 for neutrals, ~1.0 for
  saturated mid-tones (boost saturation * 5, cap at 1)

Apply both as multipliers to the deltas in:
- applyWarmCast (red gain / blue cut)
- applyPortraColorShift (shadow cyan tint + midtone warming)

Overall Portra desat (factor 0.96) stays ungated — it's subtle and
applies uniformly. Halation is threshold-gated already and is left alone.

Skin (saturated mid-luma) gets full warmth as before. Backdrops (low-sat
or high-luma) get little to no shift. Highlights roll off cleanly.
```

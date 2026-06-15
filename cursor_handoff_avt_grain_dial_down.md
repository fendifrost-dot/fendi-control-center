# Cursor handoff: dial down grain intensity in `applyFilmTreatment`

## Context

v6 (commit `dfcae5a`) landed all 6 review improvements cleanly. Production test on Pair 2 confirmed shadow-weighted grain is killing backdrop noise (BG HF 2.23 → 0.64) and HF preservation is keeping skin pores visible. But Fendi's feedback: "grain seems a little too much."

The grain is in the right places now (shadows + midtones, not highlights, not backdrops) — there's just too much of it visible on skin. Pure intensity tuning, no architectural change.

## The change — two tiny tweaks in `applyFilmTreatment` params

### Tweak 1: Concentrate grain harder toward shadows

In the grain function (`applyOrganicGrain` or wherever the shadow weighting is computed), bump the exponent from 0.5 to 1.0:

```ts
// CURRENT:
const shadowWeight = Math.pow(1 - luma / 255, 0.5);

// CHANGE TO:
const shadowWeight = Math.pow(1 - luma / 255, 1.0);
```

What this does — comparing weights at different luma values:

| Luma | Current (exp=0.5) | New (exp=1.0) |
|---|---|---|
| 0 (deep shadow) | 1.00 | 1.00 |
| 64 | 0.866 | 0.749 |
| 128 (midtone) | **0.707** | **0.498** |
| 192 | 0.500 | 0.247 |
| 230 (highlight) | 0.313 | 0.098 |

Midtone grain gets cut by ~30%, highlight grain by ~70%. Deep shadows unchanged. Result: skin (which lives mostly in midtones) reads cleaner, while still keeping the textural variation in the shadow side of the face.

### Tweak 2: Lower grain sigma in "light" mode

In the params dictionary:

```ts
// CURRENT:
light:  { blur: 0.4, grainSigma: 6,  grainDesat: 0.03, haloIntensity: 0.25, haloSigma: 6,  caShift: 1, vignette: 0.05, tonalBlend: 0.6 },

// CHANGE TO:
light:  { blur: 0.4, grainSigma: 4,  grainDesat: 0.03, haloIntensity: 0.25, haloSigma: 6,  caShift: 1, vignette: 0.05, tonalBlend: 0.6 },
```

Just sigma 6 → 4. Smaller noise amplitude across the board.

Leave medium and heavy params alone — they're for future heavier looks if Fendi wants more film character on a specific shot.

## What NOT to change

- Don't touch the warm-cast / Portra / halation stages. Those are a separate problem (highlight warmth bleed) flagged for a future handoff. Solving grain first.
- Don't touch the HF preservation, the blur stage, or any other pipeline stage. Just grain intensity.
- Don't add new strength variants. We have light/medium/heavy; "light" gets dialed down.

## Test plan after pushing

1. Lovable chat (project `bd21b544-c7b8-4780-bdde-391ac9d4bfa8`): `redeploy edge function faceswap-callback`
2. Wait for confirmation
3. Re-run Apply-my-identity on Pair 2: `https://aivideotool.lovable.app/artists/8d4a4d22-41c0-43ab-ba99-92750f81e335/looks/6880cd16-22bb-45ba-aada-14552ea56742`
4. Expected v7 measurements vs v6:
   - Cheek HF should drop from 7.25 closer to 5-6 (visible but subtle grain on skin)
   - Background HF should stay around 0.5-0.7 (still clean)
   - Highlight HF should drop from 11.34 toward 10-11 (matches source 11.16)
   - Color stats should be unchanged (no Portra/warm tuning in this PR)

Visual expectation: skin grain still present but less obvious; same warm-cast issue on backdrop (saved for next handoff).

## Hard rules

- No Lovable chat for code. Only `redeploy edge function faceswap-callback`.
- No schema changes.
- Single PR, push to main directly.

## Commit message

```
fix(avt): dial down film-treatment grain intensity

v6 (dfcae5a) shipped all 6 review improvements and grain landed in the
right places (shadows + midtones, not on backdrops or in highlights),
but cheek/skin grain still reads as too prominent for the "light" default.

Two intensity tweaks, no architectural change:
- Bump shadow-weight exponent from 0.5 to 1.0 (concentrates grain harder
  in shadows; midtone grain ~30% less, highlight grain ~70% less)
- Lower grainSigma in "light" params from 6 to 4 (smaller noise amplitude)

Medium and heavy params unchanged for future heavier-look options.
```

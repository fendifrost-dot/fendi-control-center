# Claude Code handoff: wire FENDIFROST identity LoRA into CC `faceswap-generate`

## TL;DR

The FENDIFROST identity LoRA finished training on Fal yesterday. Replace the generic `fal-ai/face-swap` swap step in `supabase/functions/faceswap-generate/index.ts` with a Flux LoRA inpaint call that conditions on the FENDIFROST LoRA + existing SAM3 head/neck mask. This is the architecture Fendi has wanted since session start — identity transfer driven by 39 real photos of him, not a generic embedding from one frame.

Easy to revert if it underperforms v8 — single endpoint + request body change.

## What's already done (no work needed)

- FENDIFROST LoRA trained: `https://v3b.fal.media/files/b/0a9e02c8/3xZC2FmwnV_0FzmLPYJAr_pytorch_lora_weights.safetensors` (89.7 MB, trigger word `FENDIFROST`, 1500 steps, identity mode)
- Training config: `https://v3b.fal.media/files/b/0a9e02c9/-r0vSGDH7hB0YpLFjK_uO_config.json`
- SAM3 head/neck mask generation already in pipeline (downstream consumer of the swap call already builds and passes the mask)
- The HEIC upload work and the new canonical reference photo are already live

## The change

**Target file:** `supabase/functions/faceswap-generate/index.ts` in `fendifrost-dot/fendi-control-center` (CC repo).

**Auth:** `gh` CLI (PAT in `.git/config` is expired — `gh` is the working fallback, confirmed by prior commits this session including `86c7a22`, `3eb4f66`, `a34c973`).

**Branch:** `main` directly.

### Constant change

```ts
// Before:
const MODEL = "fal-ai/face-swap";
const COST_ESTIMATE_CENTS = 5;

// After:
const MODEL = "fal-ai/flux-lora-inpaint";
const COST_ESTIMATE_CENTS = 8; // Flux inpaint slightly higher than face-swap
const FENDIFROST_LORA_URL = "https://v3b.fal.media/files/b/0a9e02c8/3xZC2FmwnV_0FzmLPYJAr_pytorch_lora_weights.safetensors";
const FENDIFROST_LORA_SCALE = 1.0; // start at full strength; tune to 0.8 if it overrides canvas pose
```

### Request body shape

The current `face-swap` call sends face_image_url + target_image_url. The new flow needs:

- `image_url` — source canvas (was target_image_url)
- `mask_image_url` — SAM3 head/neck mask (already generated upstream — currently used elsewhere or computed in the callback?)
- `loras: [{ path: FENDIFROST_LORA_URL, scale: FENDIFROST_LORA_SCALE }]`
- `prompt` — short identity-anchoring prompt with the trigger word
- `num_inference_steps: 28`
- `guidance_scale: 5.0`
- `strength: 0.85` (inpaint denoise strength — leave most of the unmasked image untouched)

Verify the exact request schema for `fal-ai/flux-lora-inpaint` on Fal's docs first — if the model name has changed or the schema is slightly different, adjust before pushing. Backup endpoint if `flux-lora-inpaint` is unavailable: `fal-ai/flux-lora-fill` or `fal-ai/flux-dev-inpaint` with `loras` param.

### Prompt template

The prompt should be short and identity-focused. Suggested:

```ts
const prompt = `FENDIFROST, photorealistic close-up portrait, natural skin texture, sharp focus, 35mm film camera, neutral expression`;
```

The trigger word `FENDIFROST` activates the trained LoRA's identity embedding. The rest are quality anchors.

### Mask passthrough

The existing pipeline generates the SAM3 head/neck mask either in this function or upstream — review the code path before the Fal call to confirm where `mask_image_url` lives in the current request flow. The mask is the CRITICAL piece. Without it, Flux regenerates the whole image and the outfit/canvas drift breaks the v8 outfit preservation guarantee.

## What NOT to change

- Don't touch the async webhook pattern (`faceswap-generate-callback` relay to AVT). Same shape works.
- Don't change `COMPOSE_LOOK_PROXY_SECRET` auth.
- Don't touch `applyFilmTreatment` post-process — that runs on the result of this swap, still applies the same way.
- Don't touch the VLONE path or any other generation pipeline.

## Test plan after push

1. Push to `main` directly via `gh` CLI.
2. In CC Lovable chat at `https://lovable.dev/projects/7fce9fc6-fd96-4a31-8a89-649f00298c51`, send EXACTLY:
   ```
   redeploy edge function faceswap-generate
   ```
   Wait for "redeployed successfully" before testing.
3. From AVT (`https://aivideotool.lovable.app/`), navigate to artist `8d4a4d22-41c0-43ab-ba99-92750f81e335` → look `6880cd16-22bb-45ba-aada-14552ea56742` (Pair 2 canonical test canvas — denim trucker, white shirt, red striped tie).
4. Click "Apply my identity (~$0.09)". Wait for completion.
5. Compare to v8 baseline `91e570a1-7814-41a9-974a-054721bb6f41` at face zoom.

### Pass criteria (all must hold)

- **Identity:** unmistakably Fendi — the LoRA's whole point is bone structure + pore-level fidelity. Should be a clear visible step-up vs. v8's "OK" tier.
- **Outfit:** denim trucker + white shirt + red striped tie ALL UNCHANGED. If the outfit drifted, the mask wasn't applied — STOP and fix the mask passthrough.
- **Background:** studio backdrop unchanged.
- **Skin texture:** visible pores at face zoom, not glassy. (One of Fendi's specific gap calls vs. v8.)
- **Eyes:** natural catchlights, no orbital distortion.

### Fail/revert path

If the result is worse than v8 OR if outfit/background drifted (mask issue), revert the endpoint constant change:

```bash
git revert HEAD --no-edit
git push origin main
```

Then redeploy `faceswap-generate` again. v8 state restored. The LoRA stays trained and usable for a future attempt with strength adjustments.

## Commit message

```
feat(cc): wire FENDIFROST identity LoRA into faceswap-generate

Replaces fal-ai/face-swap with fal-ai/flux-lora-inpaint conditioned on
the FENDIFROST LoRA + existing SAM3 head/neck mask. Trained on 39 real
photos of Fendi (1500 steps, identity mode) — the identity prior is
specific to him, not a generic face-swap embedding from a single ref
frame.

LoRA: pytorch_lora_weights.safetensors (89.7 MB) hosted on Fal CDN.
Trigger word: FENDIFROST. Strength: 1.0 (tune to 0.8 if it overrides
canvas pose adaptation).

Mask passthrough unchanged — outfit / background preservation comes
from the same SAM3 mask the prior face-swap step used. applyFilmTreatment
post-process runs on the result the same way.

Cost: $0.08 per swap (up from $0.05 face-swap baseline). Async webhook
flow via faceswap-generate-callback unchanged.

If Pair 2 result regresses vs v8 (91e570a1...) — revert this commit
and v8 state is restored. LoRA stays trained for future attempts.
```

## After this lands, orchestrator will

1. Drive `redeploy edge function faceswap-generate` via CC Lovable chat.
2. Run Apply-my-identity on Pair 2 from AVT UI.
3. Capture face-zoom screenshot, compare side-by-side to v8 baseline.
4. Report identity tier (STRONG/OK/WEAK), outfit preservation (yes/no), skin texture (yes/no), eye catchlights (yes/no).
5. If pass → lock as production default. If fail → revert + report which dimension regressed.

## Hard rules

- NO Lovable chat for code edits — only `redeploy edge function faceswap-generate` after the push lands.
- Push to `main` directly.
- Use `gh` CLI auth (PAT expired).
- Match existing code style. No reformat passes.
- DO verify the `fal-ai/flux-lora-inpaint` endpoint name and request schema against current Fal docs before pushing — model names occasionally change.

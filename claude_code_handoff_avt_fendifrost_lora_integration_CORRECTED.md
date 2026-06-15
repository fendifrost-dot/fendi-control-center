# CORRECTED handoff: wire FENDIFROST identity LoRA (do NOT touch faceswap-generate)

> Supersedes `claude_code_handoff_avt_fendifrost_lora_integration.md`. That handoff
> was built on a wrong premise about `faceswap-generate`. Read this before acting.

## The premise that was wrong

The original handoff said: swap `faceswap-generate`'s `fal-ai/face-swap` step for
`fal-ai/flux-lora-inpaint` conditioned on the FENDIFROST LoRA + "the existing SAM3
head/neck mask", and "preserve the existing mask passthrough."

Verified against the code: **`faceswap-generate` has no mask in its request flow.**
- It calls `fal-ai/face-swap`, which does its own internal face detection — no mask.
- Its `SubmitBody` (the body AVT sends it) carries only
  `mode, callbackUrl, callbackSecret, faceImageUrl, targetImageUrl, gender,
  workflowType, upscale`. There is no mask field, and no `mask_image_url` anywhere
  in the function. A repo-wide grep for `mask` / `SAM3` in `faceswap-generate`
  returns zero hits.

So switching that function to a Flux inpaint endpoint would send **no mask** →
Flux regenerates the whole frame → outfit + background destroyed. That is the exact
catastrophic failure the original handoff itself flagged as STOP-and-fix.

## Where the SAM-3 mask + LoRA inpaint actually lives

`compose-look`'s `identity_inpaint` pipeline already implements the architecture the
handoff wanted to build, and it is live and outfit-safe:

```
compose-look/index.ts  → pipeline === "identity_inpaint":
  seg  = callFalSam3Segment(canvas, "head, face, hair, beard, ears, neck")  → mask_url
  fill = callFalFluxLoraFill({
           prompt: buildIdentityFillPrompt(triggerWord, basePrompt),
           imageUrl: canvas, maskUrl: seg.mask_url,
           loraUrl: body.loraUrl, loraScale: body.loraScale ?? 1.0,
         })
  // callFalFluxLoraFill → fal-ai/flux-lora-fill,
  //   loras:[{path: loraUrl, scale: loraScale}], paste_back:true,
  //   resize_to_original:true   ← every unmasked pixel (outfit/bg) preserved
```

- The LoRA URL + trigger word are supplied by **AVT** (`compose-look-proxy` forwards
  `{ recipe, signedUrls, loraUrl?, triggerWord?, loraScale? }`). CC has **no
  hardcoded LoRA**.
- Cost = 2¢ (SAM-3) + 7¢ (flux-fill) = **9¢**, which matches the "Apply my identity
  (~$0.09)" button — i.e. the identity button already maps to this pipeline's cost,
  not face-swap's 5¢.

## What actually needs to happen (AVT-side, NOT a CC endpoint swap)

Set on Fendi's artist record so `compose-look-proxy` forwards them to `compose-look`:

| field          | value                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `loraUrl`      | `https://v3b.fal.media/files/b/0a9e02c8/3xZC2FmwnV_0FzmLPYJAr_pytorch_lora_weights.safetensors`           |
| `triggerWord`  | `FENDIFROST`                                                                                              |
| `loraScale`    | `1.0` (optional; drop to `0.8` if the LoRA overrides canvas head pose/lighting — see CC change below)     |
| pipeline       | `identity_inpaint` (auto-selected once `loraUrl` is present)                                              |
| artist         | `8d4a4d22-41c0-43ab-ba99-92750f81e335`                                                                    |

Once those are set, "Apply my identity" runs FENDIFROST through the existing,
outfit-preserving masked inpaint. **No `faceswap-generate` swap, and no
`redeploy edge function faceswap-generate` is needed for this.**

## CC change that DID land (commit b320826, pushed to main)

`compose-look` now accepts an optional `loraScale` on its input contract and threads
it into the identity_inpaint `flux-lora-fill` call (default `1.0`, so nothing changes
for existing artists). This makes the original handoff's "tune to 0.8 if it overrides
canvas pose" adjustable from AVT per-look, with no further CC edit.

- Redeploy target for THIS change: **`compose-look`** (not faceswap-generate):
  ```
  redeploy edge function compose-look
  ```
- After redeploy, set `loraScale` in AVT only if the 1.0 result overrides pose.

## Test plan (unchanged targets, corrected mechanism)

1. AVT-side: set Fendi's artist `loraUrl` + `triggerWord = FENDIFROST` (+ optional
   `loraScale`).
2. Redeploy `compose-look` (only needed to pick up the `loraScale` field).
3. From AVT, artist `8d4a4d22-41c0-43ab-ba99-92750f81e335` → look
   `6880cd16-22bb-45ba-aada-14552ea56742` → "Apply my identity (~$0.09)".
4. Compare to v8 baseline `91e570a1-7814-41a9-974a-054721bb6f41` at face zoom.

Pass criteria identical to the original handoff (identity step-up, outfit unchanged,
studio bg unchanged, pore-level skin, natural eye catchlights). If outfit drifts,
the mask is the issue — but in this pipeline the mask is already wired, so a drift
would point at SAM-3 segmentation on that specific canvas, not a missing passthrough.

## Hard rules

- **Do NOT swap `faceswap-generate` to a Flux inpaint endpoint.** It has no mask;
  that breaks outfit preservation.
- The FENDIFROST wiring is AVT-side artist config, not a CC endpoint change.
- The only CC code change here is the additive `loraScale` plumbing in `compose-look`
  (already pushed as b320826).

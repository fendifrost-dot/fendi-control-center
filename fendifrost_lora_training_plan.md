# FENDIFROST identity LoRA — training plan

## TL;DR

Train a custom Flux LoRA on 20-30 photos of you so AVT's face-swap pipeline can use YOUR face as the identity prior, not a generic embedding extracted from a single reference frame. This is the path from v8's "OK" identity tier to "STRONG / indistinguishable from reality."

- **Cost:** $3-8 for training, $0.05/swap after (same as today)
- **Time:** 30-45 min training on Fal, runs in background
- **Integration:** small Cursor handoff after training (CC `faceswap-generate` swaps from `fal-ai/face-swap` → Flux LoRA inpaint with FENDIFROST LoRA)
- **What you do now:** read the photo spec below, collect/take a handful of shots, drop them in chat when you're back at the computer

## What I need from you — photo collection brief

**Target:** 25 photos. Floor is 20, ceiling is 35. Quality beats quantity, but undertrained LoRAs are weak.

### Angle variety (most important)

Aim for the rough mix:

- **15 frontal** — face directly at camera, eyes engaged. Bone structure across forehead, cheekbones, jaw all clearly visible.
- **6 three-quarter** — head turned 15-30° off-axis. Captures cheekbone-to-jaw transitions the frontal angle hides.
- **4 near-profile** — head turned 45-75° off-axis. Captures jawline, ear placement, nose profile.

Avoid: pure 90° side profile (too little face data for identity prior), top-down or bottom-up severe angles, photos where over half the face is in deep shadow.

### Lighting variety (second most important)

Aim for ~5 distinct lighting setups across the 25. Mix of:

- Natural daylight (window, outdoor overcast, golden hour)
- Indoor warm (tungsten, lamp light) — the lighting style your existing reference has
- Indoor neutral (overhead daylight bulbs, ring light)
- Mixed/moody (one strong source, partial shadow) — useful but cap at ~20% of the set

Avoid: all 25 in the same room/lighting. The LoRA will overfit to that condition and produce washed-out or mis-toned swaps when AVT runs it on a different canvas lighting.

### Expression / accessory variety

- **Neutral expressions** dominate (~70%) — slight smile or relaxed face. The LoRA needs neutral as its baseline; expressive shots are flavor.
- **With Cazals on** is fine — clear lenses, so eyes are still visible behind them. Useful since AVT outputs often have you in Cazals.
- **Without Cazals** for at least 5-8 of the shots. Otherwise the LoRA will hallucinate Cazals onto swaps even when they shouldn't be there.
- **Beard at current length** across all shots. Don't include old photos where the beard is significantly different — the LoRA will be confused about which Fendi to render.
- **Bald / current hair state** consistently. Same logic.

### Framing rules

- **Head + neck + a slice of shoulders.** Tightly framed face = best LoRA training signal.
- Subject fills 40-70% of the frame height. Not zoomed to nose-only, not full-body.
- **You are the only person in the photo.** No friends, no group shots, no kids in the background (LoRA will learn them too).

### Technical floor

- **Resolution:** ≥1024px on shortest side. Higher is better, the trainer downscales.
- **Sharp focus** — no motion blur, no heavy bokeh on the face.
- **JPEG or HEIC fine.** AVT preprocessing handles both.
- **No heavy filters / makeup.** The LoRA will faithfully learn whatever's in the photo — if 10 shots have a B&W filter, expect washed-out swaps later.

### Quick mental checklist before sending

For each shot ask:
1. Is my face clearly the main subject?
2. Can I see both my eyes (open, looking somewhere)?
3. Is the lighting different from at least 3 other shots in the set?
4. Is this an angle I'm not already covering?
5. Is my current beard / hair / glasses state captured?

If yes to most → include. If no to multiple → skip.

## What happens when you send them

1. **Pre-process** — I'll dedupe near-identicals, drop any below the technical floor, rotate/crop as needed, normalize to JPEG.
2. **Caption** — each photo gets a caption with trigger word `FENDIFROST` plus angle + lighting + glasses state. Example: `FENDIFROST front-facing portrait, neutral expression, warm indoor lighting, Cazals glasses on, denim shirt`. Captions matter — they teach the model what the trigger word means.
3. **Upload + train on Fal** — endpoint is `fal-ai/flux-lora-portrait-trainer`. 1000-1500 steps, default learning rate, resolution 1024. Runs ~30-45 min on their hardware.
4. **You get a LoRA artifact** — Fal returns a hosted `.safetensors` URL.

## Integration after training (the part that needs a code push)

The current AVT pipeline calls `fal-ai/face-swap` and feeds it the single reference photo. To use a LoRA instead, the call shape changes:

- New endpoint: `fal-ai/flux-lora-inpaint` (or similar Flux inpaint with LoRA conditioning)
- Inputs: source canvas + SAM3 head/neck mask + FENDIFROST LoRA URL + prompt with trigger word
- The mask is the critical piece — without it, Flux regenerates the whole image and the outfit drifts. SAM3 mask generation is already in the pipeline.

This is the same architectural pattern that PuLID-Flux was attempting in the v11 commit you rejected. The difference: PuLID extracted identity from one reference frame (generic), the LoRA extracts identity from 25 frames trained specifically on your face. Much stronger identity prior, same architecture.

**Cursor handoff for the integration will be ~2-line endpoint swap in CC `supabase/functions/faceswap-generate/index.ts` plus the LoRA URL injected into the request body.** Cheap PR, easy to revert if the LoRA underperforms.

## Costs in detail

- **Training:** $3-8 one-time. `flux-lora-portrait-trainer` is ~$0.003/step × 1000-1500 steps + a small overhead.
- **Per swap after:** ~$0.05 (same as today's face-swap)
- **Total to first usable result:** $3-8 + 30-45 min training + 5 min integration push

## Risks / caveats

1. **Photo set quality is the gate.** If 25 photos are all from the same shoot in the same lighting, the LoRA overfits and AVT outputs look "off" outside that condition. The angle/lighting variety brief above exists to prevent this.
2. **LoRA might preserve identity TOO strongly.** If swaps come back looking like a photocopy of you with no canvas-pose adaptation, we dial down `lora_scale` from 1.0 → 0.7 in the inference call.
3. **First training run might miss.** Sometimes the model overweights one angle or expression. Cheap to retrain ($3-8) with adjusted captions or photo set.
4. **Reverting is easy.** The LoRA pathway is gated by one endpoint URL in `faceswap-generate`. If it's worse than v8, revert that one line, redeploy, back to v8 in 5 min.

## Outstanding before kickoff

When you're back at the computer, you'll need to:

1. Drop the 25 photos in chat (or save them to a Drive folder and share the link).
2. Confirm trigger word is `FENDIFROST` (default — matches the existing project convention).
3. Greenlight the $3-8 training cost.

That's it. I drive everything else.

## Why this beats the cheaper alternatives

- **Reference photo swap alone** keeps the same generic-embedding architecture. Better input, same ceiling. Likely lifts identity tier from "OK" to "OK+" — marginal.
- **Inswapper A/B** is a different generic-embedding model. Maybe slightly better than `face-swap`, maybe slightly worse. Same architectural ceiling.
- **LoRA training** rebuilds the identity prior from the ground up using YOUR face specifically. This is the architecture used by every studio shipping "indistinguishable from reality" character work. It's the right tool.

The cheap alternatives are still on the table as parallel A/B tests once you're at the computer, but the LoRA is the play that closes the gap for good.

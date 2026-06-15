# Cursor handoff: AVT swap model upgrade — Fal `identity-faceswap` → PuLID-Flux (or current SOTA identity-preserving model)

## TL;DR

The current AVT swap pipeline calls Fal's `identity-faceswap` operator. v8 with the full `applyFilmTreatment` chain is good, but Fendi's bar is "indistinguishable from reality" — the gap is at the swap step (face geometry, skin texture, pore-level detail, natural eye specularity), not the post-process step. Algorithmic post-processing (the v9 Phase 2 attempt with `face-fix` + heuristic catchlights + specularity heuristics) was reverted because it over-cooked.

This handoff upgrades the swap model itself to a SOTA identity-preserving option — primarily targeting **`fal-ai/pulid-flux`** — which produces natural pore-level skin detail, eye catchlights, and specular highlights AT THE SWAP STEP via the model's identity embedding rather than as post-process tricks.

## Scope

- **Repo:** `fendifrost-dot/ai-video-tool`
- **Likely file:** the edge function that calls Fal for the swap. Need to verify — could be in `supabase/functions/faceswap-generate/index.ts`, or in CC's `faceswap-generate`, or wherever the actual Fal endpoint call lives. The proxy chain is `AVT faceswap-proxy → CC faceswap-generate → Fal` per project memory.
- **No schema changes.** Pure model swap at the API call layer.
- **No Lovable chat for code.** Only `redeploy edge function faceswap-generate` (or whatever is changed) after the push.
- **PAT in `.git/config` is expired.** Use `gh` CLI auth for the push (worked for `1bc72d4` and `210fef2`).

## Critical architectural note before starting

**PuLID-Flux is identity-conditioned image generation, NOT a drop-in face-swap.** It takes `[prompt + identity reference]` and generates a new image. To use it for OUR use case (graft Fendi's face onto a Grok canvas while preserving outfit/composition), you'll need to use it as an **inpaint with identity conditioning** on the masked head/neck region.

Two viable wire-up patterns:

### Pattern A — PuLID-Flux inpaint (preferred if available)
1. Detect head/neck region via SAM3 or face landmarks (existing `identity_faceswap` already does this)
2. Pass the source canvas + mask + Fendi's identity reference to PuLID-Flux inpaint endpoint
3. PuLID conditions generation on the identity embedding while filling the mask
4. Result: outfit/composition preserved, face is high-fidelity Fendi

### Pattern B — Different SOTA face-swap model (fallback)
If PuLID-Flux doesn't support inpaint masking cleanly, fall back to:
- `fal-ai/face-swap` (different from `fal-ai/identity-faceswap` — usually newer / more SOTA)
- `fal-ai/inswapper` (InsightFace-based, industry standard)
- `fal-ai/instant-id` (InstantID for identity-preserving generation)

Pick whichever is currently best on Fal's leaderboard for face-swap/identity tasks. Verify via `https://fal.ai/models` — filter for "face swap" or "identity preservation."

## Discovery — run these grep/check steps first

```bash
gh repo clone fendifrost-dot/ai-video-tool /tmp/avt
cd /tmp/avt

# 1. Find where Fal is called for the swap
grep -rn 'queue\.fal\.run\|fal\.run\|identity-faceswap\|FAL_KEY\|fal_api' supabase/functions/

# 2. Find which edge function holds the actual Fal call (might be faceswap-generate, not faceswap-callback)
grep -rn 'fal-ai/identity-faceswap' supabase/functions/

# 3. Confirm the request body shape currently sent to Fal
grep -A 30 'fal-ai/identity-faceswap' supabase/functions/

# 4. Check the AVT vs CC repo split
# Per memory: AVT's faceswap-proxy → CC's faceswap-generate. The actual Fal call may be in fendi-control-center repo, not ai-video-tool.
# If grep shows nothing in AVT repo's edge functions, you'll need to also clone fendifrost-dot/fendi-control-center to find the call site.
```

If the Fal call lives in the CC repo (likely, per project architecture), the handoff target IS the CC repo, not AVT. Adjust accordingly.

Also web-search to verify the current PuLID-Flux endpoint + request shape on Fal:
- Check `https://fal.ai/models/fal-ai/pulid-flux` (or whatever the current URL is) for API docs
- Note: model names on Fal change occasionally — verify the exact slug before coding

## The change — request shape for PuLID-Flux

Current call (rough — verify against actual code):
```ts
const response = await fetch("https://queue.fal.run/fal-ai/identity-faceswap", {
  method: "POST",
  headers: {
    "Authorization": `Key ${FAL_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    canvas_image_url: sourceImageUrl,
    identity_reference_url: identityReferenceUrl,
    // ... existing params
  }),
});
```

Target call (PuLID-Flux inpaint pattern — verify exact param names against Fal docs):
```ts
const response = await fetch("https://queue.fal.run/fal-ai/pulid-flux", {
  method: "POST",
  headers: {
    "Authorization": `Key ${FAL_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    // Identity conditioning
    reference_image_url: identityReferenceUrl, // Fendi's canonical_base_image_url
    
    // For inpaint with face mask:
    image_url: sourceImageUrl, // the Grok canvas
    mask_image_url: headMaskUrl, // SAM3-generated mask of head/neck region
    
    // Generation parameters
    prompt: "professional portrait, photorealistic, natural skin texture, sharp focus, 35mm camera",
    // Or build prompt dynamically from artist DNA / look context if available
    
    // PuLID-specific
    pulid_strength: 0.85, // identity conditioning weight — start at 0.85, may need 1.0 for stronger Fendi-likeness
    num_inference_steps: 28,
    guidance_scale: 5.0,
  }),
});
```

**The mask is the critical piece.** Without head/neck masking, PuLID will regenerate the WHOLE image and the outfit will change. With the mask, only the head region gets the PuLID identity-conditioned generation, preserving everything else.

Check the existing `identity_faceswap` pipeline to see how it generates the mask (it does — SAM3 was mentioned in the architecture discussion earlier today). Reuse that mask generation; feed it to PuLID-Flux.

## What stays unchanged

- The `faceswap-proxy` → `faceswap-generate` → `faceswap-callback` chain (only the Fal endpoint inside `faceswap-generate` swaps)
- The `applyFilmTreatment` post-process — keep all 8 stages, they still add the right finishing touch on top of any swap model
- HF preservation, warm cast gating, halation, etc. — all stay
- VLONE / `job_id` path (the other branch) — completely untouched
- Default strength "light" in film treatment — unchanged

## Fallback strategy if PuLID-Flux doesn't fit

If PuLID-Flux doesn't support inpaint masking cleanly OR produces worse results in testing:

1. **Try `fal-ai/face-swap`** (different model than `identity-faceswap`, newer)
2. **Try `fal-ai/inswapper`** (InsightFace-based industry standard)
3. **Try `fal-ai/instant-id`** with face mask

Don't ship without testing on Pair 2 first. The cost is $0.05 per test swap; worth a few iterations to find the right model.

## Test plan after pushing

1. Redeploy via Lovable chat (the edge function that contains the Fal call — likely `faceswap-generate`):
   ```
   redeploy edge function faceswap-generate
   ```

2. Run Apply-my-identity on **Pair 2** (`6880cd16-22bb-45ba-aada-14552ea56742`) once — that's the canonical test canvas the orchestrator has been using all session.

3. Compare the new result to v8 (`91e570a1-7814-41a9-974a-054721bb6f41`) at face-zoom:
   - **Identity:** should look UNMISTAKABLY like Fendi (better than v8's "OK" rating)
   - **Skin texture:** visible pores under zoom (not glassy)
   - **Eye catchlights:** small specular highlights in iris naturally present (PuLID's identity embedding usually includes these)
   - **Outfit:** denim trucker + tie + jeans + pose ALL UNCHANGED (mask working)
   - **Background:** clean studio backdrop, NOT regenerated (mask working)

4. If outfit changed at all → mask isn't being applied correctly. Stop, fix, retry.

5. If identity is still "OK" not "STRONG" → either PuLID strength needs bumping (0.85 → 1.0) OR the reference image quality matters more than the model upgrade. Cross-reference earlier today's reference-photo finding (the high-res selfie at 2316×3088 with Cazals visible).

6. If result looks worse than v8 → revert immediately. Don't ship a regression.

## Cost expectations

- Current `identity-faceswap`: ~$0.05 per swap
- PuLID-Flux: ~$0.03-0.05 per swap (similar order of magnitude — likely slightly cheaper since it's flux-based, but verify against Fal's current pricing page)
- Total swap time: probably +20-40s vs current (PuLID adds inference overhead)

## Hard rules

- **No Lovable chat for code edits.** Only the redeploy line.
- **No schema changes.**
- **Don't touch `applyFilmTreatment` or VLONE path.**
- **Use `gh` CLI for push** (PAT expired).
- **Match existing code style.**
- **Test on Pair 2 before merging away from v8.** If the result is worse, revert before any other identity work runs.

## Commit message suggestion

```
feat(avt): upgrade identity swap from identity-faceswap to PuLID-Flux

Closes the remaining "indistinguishable from reality" gap by replacing
Fal identity-faceswap with PuLID-Flux as the identity-conditioned inpaint
backend. PuLID's identity embedding produces natural pore-level skin
texture, eye catchlights, and specular highlights at the swap step —
removing the need for the v9 algorithmic post-process heuristics that
were reverted at commit 210fef2.

Architecture change is endpoint-only: faceswap-proxy → faceswap-generate
→ faceswap-callback chain is unchanged. SAM3 head/neck mask generation
is reused to feed PuLID-Flux's inpaint mode (preserves outfit /
composition while regenerating only the masked face region with identity
conditioning).

applyFilmTreatment ("light" default) continues to run on the result as
the finishing pass — grain, halation, Portra, warm cast, vignette.

If PuLID-Flux doesn't produce a meaningful step-up vs v8 in testing,
revert this commit and try fal-ai/inswapper or fal-ai/instant-id as
fallbacks.
```

## After this lands, orchestrator will:

1. Drive `redeploy edge function faceswap-generate` via Lovable chat
2. Re-run Apply-my-identity on Pair 2 with network capture
3. Build a 4-up comparison: Grok source / v8 / v11 (PuLID-Flux) / face-zoom
4. Measurement: identity tier (STRONG/OK/WEAK), outfit preservation, presence of natural catchlights + skin texture
5. If v11 lands at Fendi's bar → lock as production default
6. If not → roll back to `210fef2` and try one of the fallback models in a follow-up handoff

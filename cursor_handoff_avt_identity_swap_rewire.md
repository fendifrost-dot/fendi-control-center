# Cursor handoff: re-wire AVT "Apply my identity" to use Fal face-swap chain instead of `identity_inpaint`

## TL;DR

The `identity_inpaint` pipeline (SAM3 head/neck mask + FluxFill + FENDIFROST LoRA) can't hit Fendi's "indistinguishable from reality" bar. Even with the correct identity LoRA selected (fixed in commit `a40681a`), inpaint-based face replacement averages features back toward generic AI faces because FluxFill is designed to blend, not impose.

The fix: route the "Apply my identity" action to the **existing Fal face-swap chain** (`faceswap-proxy → faceswap-generate → Fal → callback`) that already produced clean photoreal results on the VLONE editorial swaps earlier this week. Fal's `face-swap` operator is a discriminative model trained specifically for facial-feature grafts — it preserves the source image's outfit/pose/composition by design and replaces only the face geometry from a reference photo. No LoRA dependency, no regeneration, no inpaint blending artifacts.

This handoff re-wires the UI button + edge function routing. **No schema changes, no new pipeline architecture.** Pure plumbing fix.

## Why inpaint doesn't work for identity grafts

Diagnosis confirmed today via reproduction ($0.09):

1. **`identity_inpaint` regenerates the head region** with prompt+LoRA guidance. Even with FENDIFROST at default strength, the model has only ~10% of the canvas to express identity and FluxFill's blending bias pulls features toward the average AI face that "fits" the surrounding image. Output reads as "AI guy who slightly resembles Fendi," never as Fendi.
2. **FENDIFROST LoRA itself is good.** Fendi's confirmed it produces near-perfect identity when used to generate a full image (~10 prior versions). The LoRA isn't the bottleneck — the inpaint primitive is.
3. **Fal face-swap is a graft, not a regen.** It transplants the reference face's geometry directly onto the source, preserves everything else (outfit, lighting, pose), and works the same on AI-generated and real-photo sources. This is the right primitive class for "place my facial features over this image."

## Repo + scope

- **Repo:** `fendifrost-dot/ai-video-tool` (push to `main` directly)
- **Edge functions involved:**
  - `compose-look-proxy` — currently handles `identity_inpaint` for Apply-my-identity
  - `faceswap-proxy` — existing entry point for Fal face-swap chain (already deployed and working — used by VLONE swap flow)
  - `faceswap-callback` — existing callback handler that writes the `project_assets` row
- **Frontend:** wherever the "Apply my identity" button is wired (likely in the Looks / artist canvas view)
- **No schema changes.** If you find yourself wanting a new column or table to make this clean, scope it out of this PR and surface as follow-up. Code-only.
- **No Lovable chat for code.** Code goes through GitHub `main`; chat is for `redeploy edge function X` only.

## Discovery — run these greps first to map the current state

```bash
cd ai-video-tool

# 1. Find the Apply-my-identity button
grep -rn "Apply my identity\|apply.my.identity\|applyIdentity\|apply_identity" src/

# 2. Find what pipelinePreference value it sends
grep -rn "identity_inpaint" src/

# 3. Find the existing Fal face-swap chain entry points  
grep -rn "faceswap-proxy\|faceswap-generate\|faceswap-callback" src/ supabase/functions/

# 4. Find the compose-look-proxy edge function (current routing)
ls supabase/functions/compose-look-proxy/

# 5. Find the pipeline preference enum/type
grep -rn "PipelineMode\|pipelinePreference\|identity_inpaint\|lora_segmented_inpaint" src/ supabase/functions/ | grep -i "type\|enum\|union"
```

Capture the file paths from each grep before making edits. This handoff describes the change in concept — Cursor should match the exact patterns it finds.

## The change — three layers

### Layer 1 — Frontend: route Apply-my-identity to face-swap chain

Wherever the "Apply my identity" button click handler currently calls into `compose-look-proxy` with `pipelinePreference: "identity_inpaint"`, **change it to call `faceswap-proxy` instead**. 

Pass:
- `source_image_url`: the current canvas image (Grok upload or any source)
- `identity_reference_url`: Fendi's canonical base photo (whichever field on the artist row holds it — `canonical_base_image_url`, `identity_reference_url`, or equivalent)
- `parent_look_id`: the source look's ID so the callback can correctly attach the new swap child

Match the exact request body shape that the existing VLONE swap flow uses — grep for `faceswap-proxy` callers in the frontend to find the pattern.

### Layer 2 — Edge function: confirm `faceswap-proxy` accepts the request shape

Open `supabase/functions/faceswap-proxy/index.ts`. Verify it accepts:
- `source_image_url` (the canvas)
- `identity_reference_url` (Fendi's face)
- `parent_look_id` (so callback can attach result)

If the current `faceswap-proxy` was built for a different entry point (e.g., the VLONE Style Refs flow) and doesn't accept `parent_look_id`, **add that parameter** and pass it through to the callback URL state. The callback (`faceswap-callback`) already writes a row — it just needs to know which look to nest the result under.

### Layer 3 — Callback: write the result as a look-child, not a project_asset

Open `supabase/functions/faceswap-callback/index.ts`. Currently it writes to `project_assets` (per VLONE flow). For the Apply-my-identity flow, it should write to `artist_looks` (or wherever the existing `identity_inpaint` results land) as a child of the parent look.

Detect the path via the presence of `parent_look_id` in the callback state:
- If `parent_look_id` present → write to `artist_looks` as a child of that look (matches existing `identity_inpaint` result behavior)
- If not present → fall back to the existing `project_assets` write (preserves VLONE flow)

Match the schema/shape of the existing `identity_inpaint` result rows. Grep `artist_looks` insert patterns in `compose-look-proxy/index.ts` for reference.

## What to NOT change

- **Do not remove `identity_inpaint`** from the pipeline catalog. Other flows (LoRA-segmented inpaint, IDM-VTON wardrobe try-on) may still use it correctly. Just stop ROUTING Apply-my-identity through it.
- **Do not modify FENDIFROST LoRA references** in `compose-look-proxy`. The commit `a40681a` LoRA fix stays — it makes `identity_inpaint` correct for whatever still uses it.
- **Do not refactor the pipeline catalog or pipeline preference enum.** Surgical wire change only.
- **No schema changes.** If a new column would make this cleaner, surface as follow-up.

## Test plan

Push to main, then:

1. **In Lovable chat for AVT project `bd21b544-c7b8-4780-bdde-391ac9d4bfa8`, send EXACTLY:**
   ```
   redeploy edge function faceswap-proxy
   ```
   Wait for confirmation. Then:
   ```
   redeploy edge function faceswap-callback
   ```
   Wait for confirmation. If you only changed frontend code (no edge function changes), instead:
   ```
   redeploy frontend from latest main and publish
   ```

2. **In the AVT app** (`https://aivideotool.lovable.app/` — NO DASH), navigate to one of the two failed Grok pairs:
   - **Pair 1** (Y-cap + tan jacket): `https://aivideotool.lovable.app/artists/8d4a4d22-41c0-43ab-ba99-92750f81e335/looks/adc6a5e6-048c-4596-ab97-29fcd303f289`
   - **Pair 2** (denim trucker + tie): `https://aivideotool.lovable.app/artists/8d4a4d22-41c0-43ab-ba99-92750f81e335/looks/6880cd16-22bb-45ba-aada-14552ea56742`

3. **Click "Apply my identity"** on each Grok source look. Wait for the Fal swap job (~30-60s).

4. **Verify outcomes:**
   - New swap child looks **unmistakably like Fendi Frost** (compare to canonical base photo)
   - Outfit, hair edge below the swap region, jewelry, accessories all **fully preserved**
   - Network log shows the request went to `faceswap-proxy`, NOT `compose-look-proxy/identity_inpaint`
   - The new look-child appears in the parent look's swap-children list

## Reference: how the VLONE swap chain worked (already-proven path)

Earlier this week, Fendi's identity was successfully grafted onto 4 VLONE editorial photos (IMG_5419-5422). The flow:

1. User in AVT triggered a face-swap action on the VLONE source
2. Frontend called `faceswap-proxy` with source_url + identity_reference_url
3. `faceswap-proxy` forwarded to CC `faceswap-generate` with Fal webhook URL
4. CC `faceswap-generate` invoked Fal `fal-ai/face-swap` operator
5. Fal completed (~30-60s), sent webhook to CC `faceswap-generate-callback`
6. CC callback invoked AVT `faceswap-callback`
7. AVT callback wrote a `project_assets` row with the result URL
8. Frontend gallery refreshed, showed the swapped result

The 4 VLONE results were clean photoreal grafts — outfit preserved, face replaced with Fendi. IMG_5420 was Fendi's standout. This is the bar to hit. The chain exists end-to-end; we just need Apply-my-identity to USE it.

## Hard rules (carry into Cursor session)

- **No Lovable chat** for code work. Lovable chat is only for `redeploy edge function X` / `redeploy frontend` / `publish` commands. Code edits go through GitHub `main`.
- **No schema changes.** Surgical code wire-up only.
- **Match existing code style.** No reformat passes on unrelated lines.
- **Single-dev repo, push to `main` directly.** No PR / branch workflow.
- **Keep `identity_inpaint` working for other flows** — only re-route Apply-my-identity, don't delete the inpaint pipeline.
- **Don't auto-generate captions / descriptions / TypeScript reformats** unless absolutely needed.

## Bigger picture / context

- Fendi's quality bar: "professional ultra real quality that is virtually indistinguishable from reality."
- He's spent ~7 hours today on the identity transfer that should have taken 30 minutes if Apply-my-identity had been wired to face-swap from the start.
- The LoRA-based inpaint approach is salvageable for other use cases (wardrobe transfer, scene generation with identity bias) but it's the wrong primitive for "graft my face onto this AI-generated character."
- After this lands, any future Grok-source identity work runs through the right pipeline by default.

## Commit message suggestion

```
fix(avt): route Apply-my-identity to Fal face-swap chain instead of identity_inpaint

inpaint-based identity transfer can't hit photoreal quality on AI-generated
sources — FluxFill blends features back toward generic faces regardless of LoRA
strength. Switch Apply-my-identity to use the existing Fal face-swap chain
(faceswap-proxy → faceswap-generate → Fal → callback) which does discriminative
identity grafts and produced clean results on VLONE swaps earlier this week.

- frontend: route Apply-my-identity button to faceswap-proxy
- faceswap-proxy: accept parent_look_id param
- faceswap-callback: when parent_look_id is set, write result to artist_looks
  as a swap child instead of project_assets

identity_inpaint pipeline preserved for other flows (LoRA-segmented inpaint,
IDM-VTON wardrobe try-on).
```

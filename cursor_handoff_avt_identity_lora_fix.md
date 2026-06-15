# Cursor handoff: fix identity LoRA selection in AVT `compose-look-proxy`

## The bug

When AVT's "Apply my identity" runs the `identity_inpaint` pipeline on a Grok-sourced canvas, the result doesn't look like Fendi — it looks essentially identical to the Grok-generated guy. Confirmed by reproducing the failure once today ($0.09): every failed run pulls the **wardrobe** LoRA (FENDIFITS) and applies it to the head/neck region. Wardrobe LoRA applied to a face doesn't change identity, so the swap renders as a near-no-op.

The pipeline architecture (SAM3 head/neck mask + FluxFill) is **correct** and outfit-preserving — denim trucker, tie, jeans, jacket, pose all stay locked. The ONLY problem is the LoRA selection upstream.

## Repo + scope

- **Repo:** `fendifrost-dot/ai-video-tool` (push to `main` directly, single-dev repo)
- **Edge function:** `compose-look-proxy` (likely `supabase/functions/compose-look-proxy/index.ts`). It picks the LoRA URL + trigger to pass to the downstream Fal pipeline based on the pipeline preference and the artist's "primary" LoRA.
- **No schema changes.** This is code-only — pure edge function edit.
- **No Lovable chat.** Code goes through GitHub `main`; redeploy via Lovable chat is the ONLY thing chat is used for.

## LoRA reference data

The two LoRAs live on Fal storage:

| LoRA | URL | Trigger | Use case |
|---|---|---|---|
| **FENDIFROST** | `https://v3b.fal.media/files/b/0a9aa6fe/JaNHDtLLu91_D7nnOxeY3_pytorch_lora_weights.safetensors` | `FENDIFROST` | **Identity** — this is what `identity_inpaint` SHOULD use |
| FENDIFITS | `https://v3b.fal.media/files/b/0a9b9468/FDyJ0BuO_NEbiVJHxEEoJ_pytorch_lora_weights.safetensors` | `FENDIFITS` | Wardrobe — what `identity_inpaint` is currently (wrongly) using |

FENDIFROST was verified working on a May 24 look — produces strong identity carryover. The infrastructure is fine; it's just not being selected.

## The fix — minimum viable

In `compose-look-proxy/index.ts` (or wherever the LoRA selection happens for the `identity_inpaint` branch), add a hardcoded identity-LoRA override:

```ts
// At the top, near other constants
const IDENTITY_LORA_URL = "https://v3b.fal.media/files/b/0a9aa6fe/JaNHDtLLu91_D7nnOxeY3_pytorch_lora_weights.safetensors";
const IDENTITY_LORA_TRIGGER = "FENDIFROST";

// Where the request body is built for the downstream pipeline call,
// when pipelinePreference === "identity_inpaint", REPLACE whatever currently
// pulls from `artist.primary_lora_*` with these constants:

if (pipelinePreference === "identity_inpaint") {
  body.lora_url = IDENTITY_LORA_URL;
  body.lora_trigger = IDENTITY_LORA_TRIGGER;
}
// Keep the existing behavior for all other pipelines (lora_segmented_inpaint,
// lora_seedream, lora_idm_vton, seedream_only) — only identity_inpaint changes.
```

Match the exact variable names + style of the surrounding code. The fix is logically one branch on `pipelinePreference`. Don't refactor adjacent code.

## How to find the right edit point

```bash
cd ai-video-tool
grep -rn "FENDIFITS\|FENDIFROST\|identity_inpaint\|lora_trigger\|lora_url" supabase/functions/
```

The function that builds the downstream Fal pipeline call (likely calls `fal-ai/flux-fill` or similar) is where the LoRA fields get attached to the request body. That's the spot.

## Test plan after pushing

1. Push to `main`
2. In Lovable chat (the AVT project at https://lovable.dev — project ID `bd21b544-c7b8-4780-bdde-391ac9d4bfa8`), send the message: `redeploy edge function compose-look-proxy`. Wait for confirmation.
3. Open `https://aivideotool.lovable.app/` → log in to Fendi Frost's account → navigate to one of the 2 failed Grok pairs:
   - **Pair 1 (Y-cap + tan jacket):** `https://aivideotool.lovable.app/artists/8d4a4d22-41c0-43ab-ba99-92750f81e335/looks/adc6a5e6-048c-4596-ab97-29fcd303f289`
   - **Pair 2 (denim trucker + tie):** `https://aivideotool.lovable.app/artists/8d4a4d22-41c0-43ab-ba99-92750f81e335/looks/6880cd16-22bb-45ba-aada-14552ea56742`
4. On the Grok source look, click **Apply my identity**. Wait ~30-60s for the FluxFill job.
5. The new swap child should look unmistakably like Fendi Frost (compare against canonical base photo). Outfit (denim trucker / tie / Y-cap / tan jacket / pose) MUST remain locked.

If the new run still pulls FENDIFITS, the edit didn't land — re-check the conditional branch.

Total cost to re-process both pairs after the fix: ~$0.18 (Fal pipeline cost per inpaint).

## Hard rules (carry into Cursor session)

- **No Lovable chat** for code work. Lovable chat is for `redeploy edge function X` ONLY. The code edit goes through GitHub `main` directly.
- **No schema changes** in this handoff. If you think a cleaner version needs an `identity_lora_url` column on the `artists` table, surface that as a follow-up — not in this PR.
- **Match existing code style.** No reformat passes on unrelated lines.
- **Single-dev repo, push to `main` directly.** No PR / branch workflow.

## Why this matters (for context)

- Fendi started this identity job at ~5am, hit failure pattern, ate ~7 hours of debugging.
- Quality bar: "professional ultra real quality that is virtually indistinguishable from reality." The failed swaps don't meet that bar because the wardrobe LoRA never touches identity.
- Once the LoRA selection flips, both existing failed pairs re-process cleanly, and any future Grok-source identity work runs correctly out of the box.

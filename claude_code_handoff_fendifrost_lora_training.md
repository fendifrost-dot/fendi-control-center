# Claude Code handoff: kick off FENDIFROST identity LoRA training on Fal

## TL;DR

The 39 photos Fendi shot for FENDIFROST identity LoRA are pre-processed and ZIPped, ready to ship to Fal. Training takes 30-45 min and ~$3-8. This handoff documents the exact API call to fire when Fendi greenlights in the morning.

## What's already done

- 39 HEIC photos copied to `~/fendi-control-center/AVT FACE IMAGES/` (from `/Users/gocrazyglobal/Projects/ai-video-tool/AVT FACE IMAGES/`)
- All 39 converted to JPG with EXIF orientation honored, quality 92, saved to `AVT FACE IMAGES/jpg_converted/`
- ZIP archive ready at `AVT FACE IMAGES/FENDIFROST_lora_training_set.zip` (~91 MB, 39 files)
- Photo set verified: mix of frontal close-ups (eyes open, no glasses), 3/4 views, and profiles with Cazals. Consistent current beard + bald state. Lighting is slightly homogeneous (same room/blinds in most) but angle variety compensates.

## What's still needed

1. **FAL_API_KEY** — not in local `.env` (verified). Lives in Supabase project secrets for both AVT (`qoyxgnkvjukovkrvdaiq`) and CC (`fendi-control-center`). Pull it from one of:
   - AVT Lovable Cloud → Backend → Edge Functions → Secrets → `FAL_API_KEY`
   - CC Lovable Cloud → Backend → Edge Functions → Secrets → `FAL_API_KEY`
   - Either project has it (the CC `train-style-lora` function already uses it)

2. **Public URL for the ZIP** — Fal needs `images_data_url` reachable from their workers. Two paths:
   - **Path A (preferred):** Upload to Supabase Storage in either project, get the public URL. ~1 min via the anon JWT + storage upload (same flow we used for the canonical reference photo earlier today).
   - **Path B:** Use Fal's own storage API (`https://rest.alpha.fal.ai/storage/upload`) with the FAL_API_KEY. ~30 sec.

3. **Greenlight from Fendi** for the $3-8 training cost.

## The Fal API call

Endpoint: `https://queue.fal.run/fal-ai/flux-lora-fast-training`

Headers:
```
Authorization: Key <FAL_API_KEY>
Content-Type: application/json
```

Body:
```json
{
  "images_data_url": "<public_url_to_zip>",
  "trigger_word": "FENDIFROST",
  "is_style": false,
  "create_masks": true,
  "steps": 1500
}
```

**Important parameter differences from the existing CC `train-style-lora` defaults:**

- `trigger_word: "FENDIFROST"` (not `FENDIFITS` — that's the wardrobe LoRA)
- `is_style: false` — this is an identity LoRA, not a style LoRA. Critical.
- `create_masks: true` — face-focused masking for identity training. The wardrobe trainer uses `false`.
- `steps: 1500` — the existing function defaults to 300 which is too few for high-quality identity. Identity LoRAs need 1000-2000 steps to capture bone structure.

Response (sync):
```json
{
  "request_id": "...",
  "status_url": "...",
  "response_url": "..."
}
```

Poll the `status_url` every ~30s until status === `"COMPLETED"`. Then GET `response_url` for the LoRA `.safetensors` URL.

## What to do with the LoRA URL when training completes

Write a second Claude Code handoff (or fold into this one) to:

1. Modify `fendifrost-dot/fendi-control-center` `supabase/functions/faceswap-generate/index.ts` to use the LoRA. Two paths:
   - **Endpoint swap:** `fal-ai/face-swap` → `fal-ai/flux-lora-inpaint` (or current Flux LoRA inpaint endpoint)
   - **Request body additions:** `lora_url` pointing to the FENDIFROST LoRA, `trigger_word: "FENDIFROST"`, `mask` from SAM3 (existing pipeline already generates this)
2. Test on Pair 2 (`6880cd16-22bb-45ba-aada-14552ea56742`) and compare to v8 baseline (`91e570a1-7814-41a9-974a-054721bb6f41`) plus the new reference v9.
3. If identity tier lifts from "OK / OK+" to "STRONG / indistinguishable from reality" — lock as production default.
4. If worse — revert that one endpoint swap. The LoRA stays trained and reusable for later attempts.

## Hard rules

- NO Lovable chat for code edits during integration.
- ALL Supabase secret access goes through Lovable Cloud panel (NEVER navigate `supabase.com/dashboard`).
- Push to `main` directly. Use `gh` CLI auth.
- Don't kick off training without Fendi's explicit cost greenlight.
- AVT URL is `aivideotool.lovable.app` NO DASH.

## Cost & time

- Training: $3-8 one-time
- Time: 30-45 min training, runs unattended on Fal
- Inference after: ~$0.05/swap (same as today's `face-swap`)
- Integration push: ~5-10 min for the small endpoint swap + redeploy

# compose-look

CC edge function that orchestrates the 3-stage identity-locked outfit
composition pipeline for AVT's Looks Composer.

## Pipeline modes

| mode               | flow                                                          | cost   |
| ------------------ | ------------------------------------------------------------- | ------ |
| `lora_seedream`    | `flux-lora` (base photo) → `seedream/v4/edit` (compose)        | ~$0.07 |
| `seedream_only`    | `seedream/v4/edit` directly with face as image[0]              | ~$0.04 |
| `kontext_multi`    | `flux-pro/kontext/multi` single-pass fallback                  | ~$0.05 |
| `auto`             | picks `lora_seedream` if the artist has a LoRA, else `seedream_only` | varies |

## Env vars

| name                            | description                                       |
| ------------------------------- | ------------------------------------------------- |
| `AVT_SUPABASE_URL`              | AVT project base URL                              |
| `AVT_SUPABASE_ANON_KEY`         | AVT anon key — used to verify the forwarded JWT   |
| `AVT_SUPABASE_SERVICE_ROLE_KEY` | AVT service role — DB writes + storage uploads    |
| `FAL_API_KEY`                   | Fal.run API key                                   |
| `COMPOSE_LOOK_PROXY_SECRET`     | Shared secret with AVT's `compose-look-proxy`     |

## Request

```json
POST /functions/v1/compose-look
Headers:
  X-Internal-Proxy-Secret: <COMPOSE_LOOK_PROXY_SECRET>
  X-User-JWT: <user's AVT supabase JWT>
Body:
{
  "artistId": "uuid",
  "faceFeatureId": "uuid?",
  "wardrobeFeatureIds": ["uuid", ...],
  "jewelryFeatureIds": ["uuid", ...],
  "locationId": "uuid?",
  "propIds": ["uuid"]?,
  "basePrompt": "...",
  "stylingNotes": "...",
  "pipelinePreference": "auto" | "lora_seedream" | "seedream_only" | "kontext_multi",
  "parentLookId": "uuid?",
  "name": "..."?
}
```

## Response

```json
{
  "look": { ...artist_looks row... },
  "signed_url": "https://...",
  "pipeline_used": "lora_seedream",
  "cost_cents": 7,
  "stages": [
    { "stage": "flux_lora",     "request_id": "...", "image_url": "..." },
    { "stage": "seedream_edit", "request_id": "...", "image_url": "..." }
  ]
}
```

## Deployment

Edge functions don't auto-deploy on git push for Lovable Cloud projects.
After merging, open the CC Lovable chat and say:

> Pull the latest from GitHub and redeploy the `compose-look` edge function.

Then verify by curling the function URL with a real proxy secret + user JWT.

## Direct curl smoke test

```bash
curl -X POST "https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/compose-look" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Proxy-Secret: ${COMPOSE_LOOK_PROXY_SECRET}" \
  -H "X-User-JWT: ${USER_JWT}" \
  -d '{
    "artistId": "8d4a4d22-41c0-43ab-ba99-92750f81e335",
    "wardrobeFeatureIds": ["<some wardrobe feature uuid>"],
    "basePrompt": "Fendi Frost in chrome luxe streetwear, midday studio light"
  }'
```

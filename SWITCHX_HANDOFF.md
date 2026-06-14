# SwitchX (Beeble) Path B integration — handoff

CC side is built. This doc covers what's left: AVT proxy + secrets + push.

## What landed in CC (this commit)

- **New edge function:** `supabase/functions/switchx-restyle/index.ts`
- **Pattern:** mirrors `compose-look` proxy-secret pattern exactly. Sync mode for curl smoke tests, async mode with `EdgeRuntime.waitUntil` + callback for UI integration.
- **Routes:** `POST /switchx-restyle` with `X-Proxy-Secret` header.
- **Body:**
  ```json
  {
    "sourceVideoUrl": "https://...signed-url.mp4",
    "prompt": "Subject performing on a luxury private jet cabin with golden window light, wearing a crimson silk shirt and black trousers",
    "mode": "custom",
    "referenceImageUrl": "https://...optional-scene-ref.jpg",
    "callback_url": "https://avt.supabase.co/functions/v1/switchx-restyle-callback"
  }
  ```
- **Response (sync):** `{ output_video_url, frames_processed, cost_cents, beeble_job_id, generation_metadata }`
- **Response (async, with callback_url):** `{ status: "queued" }` immediately. Result POSTed to callback when done.

## Required CC secrets (not yet set)

Add via CC Lovable chat at `https://lovable.dev/projects/7fce9fc6-fd96-4a31-8a89-649f00298c51`:

1. **`BEEBLE_API_KEY`** — from `https://developer.beeble.ai/` (Fendi is signing up).
2. **`SWITCHX_PROXY_SECRET`** — generate a strong random 32+ char string. Same value must go in AVT secrets.

Suggested message to CC Lovable chat:
> Add two new edge function secrets to the CC project: `BEEBLE_API_KEY` (I'll supply the value after signup) and `SWITCHX_PROXY_SECRET` (generate a strong random 32-character string).

## What's needed in AVT (next handoff)

The matching AVT proxy. Mirror `compose-look-proxy` shape. Repo: `fendifrost-dot/ai-video-tool`.

### New file: `supabase/functions/switchx-restyle-proxy/index.ts`

Responsibilities:

1. **Auth the caller** — accept a Supabase JWT (anon role is fine since AVT is single-user-locked).
2. **Resolve the source video** — accept a `clip_id` (or similar shot/clip identifier), pull the source video from `look-composites` or wherever performance clips live, generate a signed URL (1-hour expiry) for Beeble to fetch.
3. **Resolve the prompt** — pull the scene description and wardrobe direction from the shot row in the Shot List for the relevant clip. Concatenate with any user override into the final SwitchX prompt.
4. **Forward to CC** — POST to `https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/switchx-restyle` with `X-Proxy-Secret: <SWITCHX_PROXY_SECRET>` header and the body above. Pass a `callback_url` pointing to the new `switchx-restyle-callback` AVT function so SwitchX results write back to the database.
5. **Insert/update a `restyle_jobs` row** — track status (queued/processing/complete/failed), source clip ref, output URL, cost.

### New file: `supabase/functions/switchx-restyle-callback/index.ts`

CC POSTs results here when async jobs finish. Validates `X-Proxy-Secret`, updates the `restyle_jobs` row with status + output URL + cost, optionally writes the output video to Supabase Storage if you don't want to depend on Beeble's CDN long-term.

### Required AVT secrets

1. **`SWITCHX_PROXY_SECRET`** — same value as CC's. Shared secret for the X-Proxy-Secret header.

### Database — minimal viable schema

New table `restyle_jobs`:

```sql
create table public.restyle_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,                    -- auth.users(id) FK
  artist_id uuid not null,                  -- artists(id) FK
  project_id uuid,                          -- projects(id) FK
  shot_id uuid,                             -- shots(id) FK, optional
  source_video_url text not null,           -- input clip
  prompt text not null,                     -- final prompt sent to Beeble
  mode text not null default 'custom',      -- 'custom' | 'auto'
  reference_image_url text,                 -- optional scene ref
  status text not null default 'queued',    -- queued|processing|complete|failed
  beeble_job_id text,
  output_video_url text,                    -- result when complete
  frames_processed int default 0,
  cost_cents int default 0,
  error_message text,
  generation_metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on public.restyle_jobs(user_id, created_at desc);
create index on public.restyle_jobs(shot_id);
```

Use the Lovable SQL Editor to apply (NEVER `supabase.com/dashboard`; AVT is fully Lovable-Cloud managed per Fendi's standing rules).

## Curl smoke test (after secrets set + CC deployed)

Once `BEEBLE_API_KEY` and `SWITCHX_PROXY_SECRET` are in CC and `compose-look`... wait, this is `switchx-restyle` — once deployed, smoke test directly without the AVT proxy:

```bash
curl -X POST https://wkzwcfmvnwolgrdpnygc.supabase.co/functions/v1/switchx-restyle \
  -H "X-Proxy-Secret: <SWITCHX_PROXY_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceVideoUrl": "https://example.com/test-clip-5s.mp4",
    "prompt": "Subject performing on a neon-lit Tokyo alley at night, wearing a crimson silk shirt, dramatic side lighting from a streetlamp",
    "mode": "custom"
  }'
```

Expected: sync response with `output_video_url` (Beeble CDN signed URL), `cost_cents` (~50 for a 5s 720p clip = $0.50), and `beeble_job_id`. Total round-trip: 30-90s for 720p / 5s clips.

If 720p output looks identity-preserving and natural, we know SwitchX is the right engine. If not, fall back to the v2v smoke-test plan (Runway Aleph / Kling v2v / Wonder Studio).

## Hard rules (carry into any subsequent agent prompt)

- All Supabase ops via Lovable Cloud, NEVER `supabase.com/dashboard`.
- Lovable chat = redeploy/secret/deploy ops only, NEVER code edits.
- Code edits via `gh` CLI push to `main` (PAT in `.git/config` is EXPIRED).
- AVT URL is `aivideotool.lovable.app` (NO dash).
- AVT Lovable project ID: `bd21b544-c7b8-4780-bdde-391ac9d4bfa8`
- CC Lovable project ID: `7fce9fc6-fd96-4a31-8a89-649f00298c51`
- CC Supabase ref: `wkzwcfmvnwolgrdpnygc`
- AVT Supabase ref: `qoyxgnkvjukovkrvdaiq`

## Verification before declaring done

After the AVT proxy lands and secrets are set:

1. Curl `switchx-restyle` directly. Verify a real 720p output URL comes back.
2. Hit AVT proxy with a `clip_id`. Verify the job row reaches `complete` status.
3. Visually inspect a real output: does Fendi's face hold? Does the wardrobe swap actually swap? Does the background match the reference?

If yes on all three, ship the UI integration (Video Composer "Restyle this clip" button) as the next handoff.

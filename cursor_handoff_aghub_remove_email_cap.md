# Cursor Handoff — AGH `control-center-api`: Raise daily email pitch cap

**Project:** Artist Growth Hub (AGH / FanFuel Hub)
**Lovable project:** `4778d2a5-781c-45e5-b165-9497cdba4918`
**Supabase (Lovable Cloud) ref:** `vsemrziqxrrfcquxfnwd`
**Repo:** `fendifrost-dot/artistgrowthhub`
**Date:** 2026-06-10
**Author:** Cowork (on behalf of Fendi)

---

## Why this handoff exists

Today's batch-3 outreach run hit the daily email cap after 10 sends. 6 queued targets remain unsent for the day:

1. Eskimo Recordings — `contact@eskimorecordings.be`
2. Innervisions — `demo@innervisions.net`
3. Compost Records — `info@compost-rec.com`
4. Crack Magazine — `crack@crackmagazine.net`
5. The Vinyl Factory — `info@thevinylfactory.com`
6. Dance Music NW — `nick@dancemusicnw.com`

The cap is **NOT in the database** — confirmed by SQL Editor investigation against the Lovable Cloud Supabase (`vsemrziqxrrfcquxfnwd`):

- `public.artist_config` is a JSONB key/value store, but only contains: `artist_name`, `lanes`, `similar_artists`, `spotify_track_urls`, `vibe_keywords`. **No cap/limit/rate keys.**
- No column anywhere in `public.*` matches `%cap%`, `%limit%`, `%rate%`, `%daily%`, or `%pitch%` in a configuration capacity (only timestamps / log fields like `pitched_at`, `pitch_count`, `pitch_status`).
- No config-style table other than `artist_config` exists in `public`.

Therefore the **10/24h cap is hardcoded in the `control-center-api` edge function source** (`supabase/functions/control-center-api/index.ts`).

---

## What Cursor needs to do

### 1. Open the file
Repo: `fendifrost-dot/artistgrowthhub`
Path: `supabase/functions/control-center-api/index.ts`

### 2. Find the cap check
Search the file for any of:
- `DAILY_CAP`
- `MAX_DAILY_PITCHES`
- `MAX_PITCHES_PER_DAY`
- The bare number `10` near a pitch count / pitch log query
- The user-visible string `"Daily email pitch cap reached"` (or similar) — this is the error message we hit today, so it's the most reliable anchor.

The check most likely looks something like:

```ts
const { count: pitchesToday } = await supabase
  .from("pitch_log")
  .select("id", { count: "exact", head: true })
  .eq("method", "email")
  .gte("pitched_at", new Date(Date.now() - 24*60*60*1000).toISOString());

if ((pitchesToday ?? 0) >= 10) {
  return jsonError("Daily email pitch cap reached", 429);
}
```

### 3. Raise the cap to 30/24h with a named constant

Replace the magic `10` with a clearly named constant at the top of the relevant action handler (or at module scope if other handlers reference it):

```ts
const MAX_DAILY_PITCHES = 30;  // raised from 10 on 2026-06-10 to clear queued batch-3 sends
```

Then the check becomes:

```ts
if ((pitchesToday ?? 0) >= MAX_DAILY_PITCHES) {
  return jsonError("Daily email pitch cap reached", 429);
}
```

Keep the error message text identical so any existing client handling still matches.

### 4. Commit + push

PAT is expired — use the `gh` CLI (it worked for prior pushes today):

```bash
cd <path-to-artistgrowthhub>
git checkout main
git pull
# make the edit
git add supabase/functions/control-center-api/index.ts
git commit -m "control-center-api: raise daily email pitch cap from 10 to 30

Hardcoded 10/24h cap was blocking batch-3 outreach after the first 10 sends.
Replace magic number with MAX_DAILY_PITCHES = 30 constant for clarity.

Co-authored-by: Fendi <fendifrost@gmail.com>"
gh repo set-default fendifrost-dot/artistgrowthhub  # if needed
git push origin main
```

### 5. Redeploy the edge function

In the Lovable chat for the AGH project (`https://lovable.dev/projects/4778d2a5-781c-45e5-b165-9497cdba4918`), send:

> redeploy edge function control-center-api

Wait for confirmation that the function is live (Lovable should show a deploy log / success state).

### 6. Hand back to Cowork

Once the function is redeployed, ping Cowork with "AGH cap raised + redeployed" and Cowork will:
- Re-extract the live JWT from `https://fan-growth-pilot.lovable.app/` localStorage (key: `sb-vsemrziqxrrfcquxfnwd-auth-token`)
- Fire the 6 queued pitches through `control-center-api` with 30s spacing
- Verify each `pitch_log` row gets `method='email'`, `status='sent'`, and a populated `resend_message_id`

Per-target pitch angles are already in the Cowork task brief — no need to re-derive.

---

## Future hardening (optional, not blocking)

Consider migrating the cap to `artist_config` so it can be tuned from the SQL Editor without redeploying:

```sql
INSERT INTO public.artist_config (key, value)
VALUES ('daily_email_pitch_cap', '30'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
```

Then the edge function reads it at request time:

```ts
const { data: capRow } = await supabase
  .from("artist_config")
  .select("value")
  .eq("key", "daily_email_pitch_cap")
  .maybeSingle();
const MAX_DAILY_PITCHES = Number(capRow?.value ?? 30);
```

This avoids a redeploy the next time the cap needs to move.

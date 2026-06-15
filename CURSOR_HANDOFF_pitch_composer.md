# Cursor handoff — Catalogue + multi-tone Pitch Composer (Phase 1: Spotify)

You're picking up a build in the **fendifrost-dot/fan-growth-pilot** repo (Lovable project: "FanFuel Hub", project id `4778d2a5-781c-45e5-b165-9497cdba4918`). The pitch backend (Resend, edge functions, auth-gated control-center-api) is already shipped and working — 10/10 mail-tester score on cold pitches as of commit `0b5f100`. Your job is to add the song catalogue, category taxonomy, and pitch composer UI on top.

This doc is self-contained. Do not message me for clarification — the answers are below.

## Context you need

**Repo:** `https://github.com/fendifrost-dot/fan-growth-pilot` — branch `main`. Push directly; Lovable auto-deploys on push.

**Latest commit at handoff:** `0b5f100` (feat: test_mode flag). Build on top of this.

**Live Supabase functions base URL:** `https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api`

**Auth:** `control-center-api` accepts requests with no header in dev. Production-locked actions use the `FANFUEL_HUB_KEY` env. UI in Lovable already has the session — Lovable handles the bearer.

**Test-mode flag** (commit `0b5f100`): pass `test_mode: true` on `approve_draft` to send a real Resend email with zero state side-effects (no pitch_log row, no cooldown, no pitch_status flip, draft auto-deleted). Use this all through dev. Send to `fendifrost@gmail.com` for QA.

**Existing key files to extend (not replace):**

| File | Role |
|---|---|
| `supabase/functions/_shared/playlist-agent-run.ts` | Main dispatcher. `runDraftPitch`, `runApproveDraft`, action router (`PLAYLIST_AGENT_ACTIONS` set, lines ~1224). |
| `supabase/functions/_shared/playlist-lanes.ts` | Existing `lanes` (= genres) loader from `artist_config.lanes`. Keep for backward compat. |
| `supabase/functions/_shared/catalog-match.ts` | `loadCatalogTracks` reads from `artist_config.spotify_track_urls` today. Refactor to read from new `tracks` table first, fall through to JSON if empty. |
| `supabase/functions/_shared/resend-pitch.ts` | Email helpers: `pitchFromHeader`, `pitchReplyTo`, `htmlToPlainText`, `defaultPlaylistPitchSubject`. Reuse as-is. |
| `supabase/functions/_shared/outreach-templates.ts` | Existing `buildIgOutreachPackage` with engagement types `thank_you / cross_pitch / thank_and_pitch`. Used by IG flow. Mirror the same shape for email in the new `pitch-templates.ts`. |
| `supabase/functions/execute-pitch/index.ts` | Sender. Already test_mode-aware. Do not refactor unless you need to. |
| `supabase/functions/control-center-api/index.ts` | Top-level dispatcher; routes to `playlist-agent-run.ts`. Add new action names to the set. |

## Scope you're shipping (Phase 1 — Spotify only)

1. New schema: `categories`, `tracks`, `track_categories`, `playlist_categories`, `platform` column on `playlist_targets`.
2. Data migration from `artist_config.spotify_track_urls` and `playlist_targets.lane` into the new tables.
3. New API actions: `list_tracks`, `upsert_track`, `delete_track`, `list_categories`, `upsert_category`, `delete_category`, `set_track_categories`, `set_playlist_categories`, `recommend_targets_for_track`, `list_warm_curators`.
4. Modified `runDraftPitch`: accepts `track_id`, picks tone from track or override, detects warm relationship from `pitch_log`, picks platform link from playlist, validates category overlap with override.
5. New file `_shared/pitch-templates.ts` with 4 tones × 2 (cold/warm) = 8 templates. Platform-aware link line.
6. New frontend pages in Lovable FanFuel Hub project: `/catalogue`, `/categories`, `/pitch-composer`.

**Out of scope for Phase 1 (note these as TODOs but don't build):**
- Apple Music platform support (templates ready, but no curator data yet — separate research task)
- SoundCloud platform expansion (existing handful of rows is fine; major expansion is later)
- Reporting/analytics for placements
- Auto-categorization / ML

## Decisions already made (do not re-litigate)

1. **Four tones:** `warm_personal`, `casual_friendly`, `business_formal`, `hyped_energetic`. Each has both cold and warm-thanks variants. Tone is picked by the user; warm-vs-cold is auto-detected from `pitch_log`.
2. **"Send to all warm" bulk action requires explicit confirmation modal** before any drafts are written.
3. **Per-pitch category override allowed** with a "no category overlap — proceed?" warning.
4. **This lives in FanFuel Hub** (the fan-growth-pilot Lovable project), not the separate Fendi Control Center project.
5. **Categories are one bag** — single multi-select with up to 5 per track or per playlist. No separate genre vs vibe split in the UI.
6. **Multi-platform** — tracks store optional Spotify, Apple Music, SoundCloud URLs. Recommendations filter to platforms the track has URLs for. **Phase 1 only wires Spotify end-to-end**; Apple/SoundCloud schema fields ship but data is not seeded.

## Schema migration

Create `supabase/migrations/20260601000000_pitch_composer_catalogue.sql`:

```sql
-- Categories: shared tag bag for tracks and playlists
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  label text not null,
  family text not null default 'genre' check (family in ('genre','vibe','mood')),
  description text,
  created_at timestamptz not null default now()
);
create index categories_family_idx on public.categories(family);

-- Tracks: Fendi's song catalogue
create table public.tracks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  isrc text,
  spotify_url text,
  apple_music_url text,
  soundcloud_url text,
  status text not null default 'active' check (status in ('active','archived','unreleased')),
  release_date date,
  default_tone text not null default 'warm_personal'
    check (default_tone in ('warm_personal','casual_friendly','business_formal','hyped_energetic')),
  short_pitch text,
  pitch_angle text,
  reference_artists text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index tracks_name_lower_unique on public.tracks(lower(name));
create index tracks_isrc_idx on public.tracks(isrc) where isrc is not null;
create index tracks_status_idx on public.tracks(status);

-- track <-> category (max 5 enforced in app, not DB)
create table public.track_categories (
  track_id uuid not null references public.tracks(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  primary key (track_id, category_id)
);
create index track_categories_category_idx on public.track_categories(category_id);

-- playlist <-> category (max 5 enforced in app, not DB)
create table public.playlist_categories (
  playlist_id text not null references public.playlist_targets(playlist_id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  primary key (playlist_id, category_id)
);
create index playlist_categories_category_idx on public.playlist_categories(category_id);

-- Explicit platform on playlist_targets (backfilled from playlist_id prefix)
alter table public.playlist_targets
  add column if not exists platform text;

update public.playlist_targets set platform = case
  when playlist_id like 'spotify:%' then 'spotify'
  when playlist_id like 'apple_music:%' then 'apple_music'
  when playlist_id like 'soundcloud:%' then 'soundcloud'
  when playlist_id like 'youtube:%' then 'youtube'
  when playlist_id like 'blog:%' then 'blog'
  else 'spotify'
end where platform is null;

alter table public.playlist_targets
  alter column platform set default 'spotify',
  alter column platform set not null;
create index playlist_targets_platform_idx on public.playlist_targets(platform);

-- Track + tone + RLS: assume single-artist app, gate by ARTIST_USER_ID env on backend (existing pattern).
alter table public.tracks enable row level security;
alter table public.categories enable row level security;
alter table public.track_categories enable row level security;
alter table public.playlist_categories enable row level security;

-- Service role bypass is already in place via existing edge functions; add a read policy for authenticated users so the UI can read directly.
create policy "Authenticated read tracks" on public.tracks for select to authenticated using (true);
create policy "Authenticated read categories" on public.categories for select to authenticated using (true);
create policy "Authenticated read track_categories" on public.track_categories for select to authenticated using (true);
create policy "Authenticated read playlist_categories" on public.playlist_categories for select to authenticated using (true);

-- Write policies stay closed; all writes go through edge functions using service role.
```

Create a separate seed migration `supabase/migrations/20260601000100_pitch_composer_seed.sql`:

```sql
-- Starter category set. Add more via UI later.
insert into public.categories(slug, label, family) values
  ('melodic_rap', 'Melodic Rap', 'genre'),
  ('chill_rap', 'Chill Rap', 'genre'),
  ('conscious_rap', 'Conscious Rap', 'genre'),
  ('drill', 'Drill', 'genre'),
  ('chicago_drill', 'Chicago Drill', 'genre'),
  ('west_coast_rap', 'West Coast Rap', 'genre'),
  ('trap', 'Trap', 'genre'),
  ('trap_soul', 'Trap Soul', 'genre'),
  ('rnb', 'R&B', 'genre'),
  ('deep_house_groove', 'Deep House Groove', 'genre'),
  ('edm_festival', 'EDM Festival', 'genre'),
  ('big_room_house', 'Big Room House', 'genre'),
  ('lo_fi', 'Lo-Fi', 'genre'),
  ('late_night', 'Late Night', 'vibe'),
  ('luxury', 'Luxury', 'vibe'),
  ('workout', 'Workout', 'vibe'),
  ('driving', 'Driving / Cruising', 'vibe'),
  ('summer', 'Summer', 'vibe'),
  ('introspective', 'Introspective', 'vibe')
on conflict (slug) do nothing;

-- Migrate spotify_track_urls into tracks (one row per existing JSON entry).
do $$
declare
  cfg jsonb;
  k text;
  v text;
  tid uuid;
  cat_id uuid;
begin
  select value into cfg from public.artist_config where key = 'spotify_track_urls';
  if cfg is null then return; end if;
  for k, v in select * from jsonb_each_text(cfg) loop
    insert into public.tracks(name, spotify_url, status, default_tone, short_pitch)
    values (k, nullif(v,''), 'active', 'warm_personal', null)
    on conflict (lower(name)) do update set spotify_url = excluded.spotify_url
    returning id into tid;
    -- Seed best-guess category from existing lanes if it matches.
    select id into cat_id from public.categories where slug = 'deep_house_groove' limit 1;
    if tid is not null and cat_id is not null and lower(k) like '%designed for me%' then
      insert into public.track_categories(track_id, category_id) values (tid, cat_id) on conflict do nothing;
    end if;
  end loop;
end$$;

-- Migrate playlist_targets.lane -> playlist_categories where the lane slug matches a category slug.
insert into public.playlist_categories (playlist_id, category_id)
select pt.playlist_id, c.id
from public.playlist_targets pt
join public.categories c on c.slug = pt.lane
where pt.lane is not null and pt.lane <> ''
on conflict do nothing;
```

Keep `artist_config.spotify_track_urls` populated for now — the backend reads new tables first, falls back to old JSON. Remove in a later migration once you've verified.

## Backend changes

### `supabase/functions/_shared/pitch-templates.ts` — new file

Implements the 8 templates. Public API:

```typescript
export type Tone = 'warm_personal' | 'casual_friendly' | 'business_formal' | 'hyped_energetic';
export type Platform = 'spotify' | 'apple_music' | 'soundcloud' | 'youtube' | 'blog';

export interface PitchContext {
  curatorName: string;
  playlistName: string;
  trackName: string;
  shortPitch: string;
  platform: Platform;
  streamUrl: string;
  isWarm: boolean;
  priorTrack?: string;      // required when isWarm
  tone: Tone;
  artistName: string;       // default "Fendi Frost"
}

export interface RenderedPitch {
  subject: string;
  body: string;             // plain text with \n; HTML wrap happens in execute-pitch
}

export function renderPitchBody(ctx: PitchContext): RenderedPitch;
```

**Platform link phrasing** (used in the body, never the subject):

| Platform | Phrase |
|---|---|
| spotify | `Stream: {url}` |
| apple_music | `Listen on Apple Music: {url}` |
| soundcloud | `Listen on SoundCloud: {url}` |
| youtube | `Watch: {url}` |
| blog | `Listen: {url}` |

**The 8 templates** (exact text — these are Fendi's voice, do not "improve" them):

#### `warm_personal` — cold variant

Subject: `Submission for {playlistName}: {artistName} — {trackName}`

```
Hi {curatorName},

I'd love to submit **{trackName}** for *{playlistName}*.

{shortPitch}

{platformLink}
Happy to share extra context or a different mix if useful.
Thank you for your time.

— {artistName}
```

#### `warm_personal` — warm variant

Subject: `Thanks for the {priorTrack} add — new release for {playlistName}`

```
Hi {curatorName},

Thank you for adding **{priorTrack}** to *{playlistName}* — meant a lot.

I just released **{trackName}** — {shortPitch} Feels like it lives in the same lane as what landed last time.

{platformLink}

No pressure if it's not the right fit. Wanted to share it with you first either way.

— {artistName}
```

#### `casual_friendly` — cold variant

Subject: `{trackName} for {playlistName} — would love your ear`

```
Hey {curatorName},

Hope your week's been good. Wanted to share my new one — **{trackName}** — for *{playlistName}*.

{shortPitch}

{platformLink}

Appreciate you taking a listen.

— {artistName}
```

#### `casual_friendly` — warm variant

Subject: `Round 2 — new song for {playlistName}`

```
Hey {curatorName},

Quick note — thanks again for the **{priorTrack}** add on *{playlistName}*. Really appreciated.

Just dropped **{trackName}** — {shortPitch} Wanted to put it in front of you before anyone else.

{platformLink}

Hope you dig it.

— {artistName}
```

#### `business_formal` — cold variant

Subject: `Pitch: {artistName} — {trackName} for {playlistName}`

```
Hello {curatorName},

I'd like to submit **{trackName}** by {artistName} for consideration in *{playlistName}*.

{shortPitch}

{platformLink}

Thank you for your time and consideration.

Regards,
{artistName}
```

#### `business_formal` — warm variant

Subject: `Follow-up: new release from {artistName} for {playlistName}`

```
Hello {curatorName},

Following up on **{priorTrack}**, which you added to *{playlistName}* — thank you again for that placement.

I'd like to share my latest release, **{trackName}**, for your consideration. {shortPitch}

{platformLink}

Thank you for your continued support.

Regards,
{artistName}
```

#### `hyped_energetic` — cold variant

Subject: `New heat: {artistName} — {trackName}`

```
Yo {curatorName},

Got something I think is perfect for *{playlistName}*: **{trackName}**.

{shortPitch}

{platformLink}

Run it back, let me know what you think.

— {artistName}
```

#### `hyped_energetic` — warm variant

Subject: `Back with another one for {playlistName}`

```
Yo {curatorName},

Massive thanks for the **{priorTrack}** add — that played a real part in the wave.

Got the next one: **{trackName}**. {shortPitch} Honestly think it might hit even harder for *{playlistName}*.

{platformLink}

Lemme know.

— {artistName}
```

After rendering, run the body through `htmlToPlainText`'s inverse — actually, just pass plain-text directly to `outreach_drafts.body`; the existing `execute-pitch` HTML-wraps via `<p>` tags around line breaks. Keep that contract.

### `supabase/functions/_shared/playlist-agent-run.ts` — modifications

**Add to action set (around line 1225):**

```typescript
const PLAYLIST_AGENT_ACTIONS = new Set([
  // ... existing ...
  "list_tracks", "upsert_track", "delete_track",
  "list_categories", "upsert_category", "delete_category",
  "set_track_categories", "set_playlist_categories",
  "recommend_targets_for_track", "list_warm_curators",
]);
```

**New action handlers** (add to the if-chain around the existing `patch_target` handler):

```typescript
if (action === "list_tracks") {
  const { data: tracks } = await sb.from("tracks")
    .select("*, track_categories(category_id, categories(id, slug, label, family))")
    .order("updated_at", { ascending: false });
  return { status: 200, data: { ok: true, rows: tracks ?? [] } };
}

if (action === "list_categories") {
  const { data } = await sb.from("categories").select("*").order("family").order("label");
  return { status: 200, data: { ok: true, rows: data ?? [] } };
}

if (action === "upsert_category") {
  const slug = String(body.slug ?? "").trim();
  const label = String(body.label ?? "").trim();
  if (!slug || !label) return { status: 400, data: { error: "slug and label required" } };
  const family = (["genre","vibe","mood"].includes(String(body.family)) ? String(body.family) : "genre");
  const { data, error } = await sb.from("categories").upsert({ slug, label, family, description: body.description ?? null }, { onConflict: "slug" }).select().single();
  if (error) return { status: 500, data: { error: error.message } };
  return { status: 200, data: { ok: true, category: data } };
}

if (action === "upsert_track") {
  const id = body.id ? String(body.id) : null;
  const fields: Record<string, unknown> = {
    name: String(body.name ?? "").trim(),
    isrc: body.isrc ? String(body.isrc).trim() : null,
    spotify_url: body.spotify_url ? String(body.spotify_url).trim() : null,
    apple_music_url: body.apple_music_url ? String(body.apple_music_url).trim() : null,
    soundcloud_url: body.soundcloud_url ? String(body.soundcloud_url).trim() : null,
    status: ["active","archived","unreleased"].includes(String(body.status)) ? String(body.status) : "active",
    release_date: body.release_date ?? null,
    default_tone: ["warm_personal","casual_friendly","business_formal","hyped_energetic"].includes(String(body.default_tone)) ? String(body.default_tone) : "warm_personal",
    short_pitch: body.short_pitch ?? null,
    pitch_angle: body.pitch_angle ?? null,
    reference_artists: Array.isArray(body.reference_artists) ? body.reference_artists.map(String) : [],
    notes: body.notes ?? null,
    updated_at: new Date().toISOString(),
  };
  if (!fields.name) return { status: 400, data: { error: "name required" } };
  let track;
  if (id) {
    const { data, error } = await sb.from("tracks").update(fields).eq("id", id).select().single();
    if (error) return { status: 500, data: { error: error.message } };
    track = data;
  } else {
    const { data, error } = await sb.from("tracks").insert(fields).select().single();
    if (error) return { status: 500, data: { error: error.message } };
    track = data;
  }
  if (Array.isArray(body.category_ids)) {
    const ids = body.category_ids.slice(0, 5).map(String);
    await sb.from("track_categories").delete().eq("track_id", track.id);
    if (ids.length) {
      await sb.from("track_categories").insert(ids.map(cid => ({ track_id: track.id, category_id: cid })));
    }
  }
  return { status: 200, data: { ok: true, track } };
}

if (action === "set_track_categories") {
  const trackId = String(body.track_id ?? "").trim();
  if (!trackId) return { status: 400, data: { error: "track_id required" } };
  const ids = Array.isArray(body.category_ids) ? body.category_ids.slice(0, 5).map(String) : [];
  await sb.from("track_categories").delete().eq("track_id", trackId);
  if (ids.length) {
    const { error } = await sb.from("track_categories").insert(ids.map(cid => ({ track_id: trackId, category_id: cid })));
    if (error) return { status: 500, data: { error: error.message } };
  }
  return { status: 200, data: { ok: true } };
}

if (action === "set_playlist_categories") {
  const pid = String(body.playlist_id ?? "").trim();
  if (!pid) return { status: 400, data: { error: "playlist_id required" } };
  const ids = Array.isArray(body.category_ids) ? body.category_ids.slice(0, 5).map(String) : [];
  await sb.from("playlist_categories").delete().eq("playlist_id", pid);
  if (ids.length) {
    const { error } = await sb.from("playlist_categories").insert(ids.map(cid => ({ playlist_id: pid, category_id: cid })));
    if (error) return { status: 500, data: { error: error.message } };
  }
  return { status: 200, data: { ok: true } };
}

if (action === "recommend_targets_for_track") {
  const trackId = String(body.track_id ?? "").trim();
  if (!trackId) return { status: 400, data: { error: "track_id required" } };
  const mode = String(body.mode ?? "warm_aligned");  // 'warm_aligned' | 'new_cold' | 'all_warm'
  const limit = Math.min(200, Math.max(1, Number(body.limit) || 50));

  const { data: track } = await sb.from("tracks").select("*, track_categories(category_id)").eq("id", trackId).single();
  if (!track) return { status: 404, data: { error: "Track not found" } };
  const trackCatIds = (track.track_categories ?? []).map((tc: { category_id: string }) => tc.category_id);

  // Platforms the track can be pitched on
  const availablePlatforms: string[] = [];
  if (track.spotify_url) availablePlatforms.push("spotify");
  if (track.apple_music_url) availablePlatforms.push("apple_music");
  if (track.soundcloud_url) availablePlatforms.push("soundcloud");
  if (availablePlatforms.length === 0) return { status: 400, data: { error: "Track has no streaming URL on any platform" } };

  // Warm placements for this track-set
  const { data: placedLog } = await sb.from("pitch_log")
    .select("playlist_id, track_name")
    .or("placed.eq.true,placement_status.eq.placed");
  const warmPids = new Set((placedLog ?? []).map((r: { playlist_id: string }) => r.playlist_id));

  // Pull candidate playlists
  let q = sb.from("playlist_targets")
    .select("*, playlist_categories(category_id)")
    .eq("is_active", true)
    .in("platform", availablePlatforms);
  const { data: targets } = await q.limit(500);
  const rows = targets ?? [];

  type Scored = { row: Record<string, unknown>; overlap: number; warm: boolean; tier: number; followers: number };
  const scored: Scored[] = rows.map((r: Record<string, unknown>) => {
    const pcs = (r.playlist_categories ?? []) as { category_id: string }[];
    const overlap = pcs.filter(pc => trackCatIds.includes(pc.category_id)).length;
    return {
      row: r,
      overlap,
      warm: warmPids.has(r.playlist_id as string),
      tier: Number(r.tier ?? 99),
      followers: Number(r.follower_count ?? 0),
    };
  });

  let filtered: Scored[];
  if (mode === "warm_aligned") {
    filtered = scored.filter(s => s.warm && s.overlap > 0);
  } else if (mode === "new_cold") {
    filtered = scored.filter(s => !s.warm && s.overlap > 0);
  } else if (mode === "all_warm") {
    filtered = scored.filter(s => s.warm); // ignores overlap; UI must show confirmation
  } else {
    return { status: 400, data: { error: "mode must be warm_aligned | new_cold | all_warm" } };
  }

  filtered.sort((a, b) => (b.overlap - a.overlap) || (a.tier - b.tier) || (b.followers - a.followers));
  return {
    status: 200,
    data: {
      ok: true,
      mode,
      track_id: trackId,
      available_platforms: availablePlatforms,
      rows: filtered.slice(0, limit).map(s => ({ ...s.row, _overlap: s.overlap, _warm: s.warm })),
    },
  };
}

if (action === "list_warm_curators") {
  const { data: log } = await sb.from("pitch_log")
    .select("playlist_id, track_name, pitched_at")
    .or("placed.eq.true,placement_status.eq.placed")
    .order("pitched_at", { ascending: false });
  const byPid = new Map<string, { last_placed_track: string; last_placed_at: string }>();
  for (const r of log ?? []) {
    if (!byPid.has(r.playlist_id)) {
      byPid.set(r.playlist_id, { last_placed_track: r.track_name, last_placed_at: r.pitched_at });
    }
  }
  const pids = Array.from(byPid.keys());
  if (pids.length === 0) return { status: 200, data: { ok: true, rows: [] } };
  const { data: targets } = await sb.from("playlist_targets")
    .select("*, playlist_categories(category_id)")
    .in("playlist_id", pids);
  const rows = (targets ?? []).map((r: Record<string, unknown>) => ({
    ...r,
    ...byPid.get(r.playlist_id as string),
  }));
  return { status: 200, data: { ok: true, rows } };
}
```

### `runDraftPitch` — modifications

In `playlist-agent-run.ts`, the existing `runDraftPitch` function. Changes:

1. Accept `track_id` in body. If provided, resolve to track record + categories. If only `track_name` given, fallback to legacy path (look up by name in tracks table, or use the old JSON).
2. Resolve tone: `body.tone` (explicit override) > `track.default_tone` > `'warm_personal'`.
3. Detect warm: query `pitch_log` for `(playlist_id = X) AND (placed=true OR placement_status='placed')`. If found, use the most recent matching row's `track_name` as `priorTrack`.
4. Category overlap check: if `track.categories ∩ playlist.categories = ∅`, return `{ status: 422, data: { error: "Category mismatch", track_categories: [...], playlist_categories: [...] } }` unless `body.override_category_check === true`.
5. Pick platform from `playlist.platform`. If track lacks URL for that platform, return error.
6. Call `renderPitchBody({ ...ctx, tone, isWarm, priorTrack })` from new `pitch-templates.ts`.
7. Insert into `outreach_drafts` with rendered subject + body. Set `metadata.tone`, `metadata.platform`, `metadata.is_warm`, `metadata.prior_track`, `metadata.track_id`.

Keep the existing `isPlacement` IG branch — don't break it. New behavior gates on `body.track_id` being present.

## Frontend — Lovable FanFuel Hub project

The fan-growth-pilot Lovable project's frontend code is in `src/`. You're adding three pages and wiring them into the nav.

### Page 1: `/catalogue`

CRUD for tracks. Table view with columns: name, status, categories (chips), platforms (icons for Spotify/Apple/SoundCloud based on which URLs are filled), default_tone, release_date, last_updated.

Click row → drawer/modal with `<TrackForm>`:

- `name` (text, required)
- `isrc` (text)
- `spotify_url` (url)
- `apple_music_url` (url)
- `soundcloud_url` (url)
- `status` (select: active / archived / unreleased)
- `release_date` (date)
- `default_tone` (select: 4 tones with friendly labels)
- `short_pitch` (textarea, 1-2 sentences)
- `pitch_angle` (textarea, longer)
- `reference_artists` (chips, free input)
- `categories` (multi-select, max 5, autocomplete from `list_categories`)
- `notes` (textarea)

Save calls `upsert_track`. "Add Track" button at top-right.

### Page 2: `/categories`

Simple list with add/edit/delete. Calls `list_categories`, `upsert_category`, `delete_category`. Fields: slug, label, family (genre/vibe/mood), description.

### Page 3: `/pitch-composer`

The main pitch flow.

**Step 1 — Select song**: dropdown of active tracks. On select, fetch track details and show category chips and available platforms (Spotify/Apple/SoundCloud icons).

**Step 2 — Confirm tone**: dropdown of 4 tones, pre-selected to `track.default_tone`. Editable per-pitch (does not persist back to track).

**Step 3 — Three-bucket picker**: three columns side by side, each fetched from `recommend_targets_for_track` with respective mode:

| Column | Mode | What it shows |
|---|---|---|
| Warm + aligned | `warm_aligned` | Curators who've placed you before AND have category overlap |
| New cold | `new_cold` | Never-pitched curators in matching categories |
| All warm | `all_warm` | Every curator who's ever placed you, regardless of category |

Each column has checkboxes for multi-select. Show: playlist name, curator name, platform badge, tier badge, follower count, overlap count (#/5).

For "All warm" column, when user clicks "Send to selected", show a confirmation modal:
> **About to pitch [trackName] to N curators across categories that may not match.**
> [list of categories per playlist]
> Are you sure? [Cancel] [Yes, send]

For category-mismatch override in "New cold": if user manually checks a playlist with overlap=0, show inline warning and require checkbox: "I know this is a category mismatch — pitch anyway."

**Step 4 — Preview drafts**: for each selected playlist, call `draft_pitch` with `{ track_id, playlist_id, tone, override_category_check }`. Show each draft's rendered subject + body in a scrollable preview list. Each draft has individual approve/skip/edit (edit opens override_subject/override_body).

**Step 5 — Send all**: bulk-call `approve_draft` with `send_immediately: true` for each approved draft. Show per-row status (sent / failed / cooldown / tier_gate). Test_mode toggle at top of step 5: when on, sends to `fendifrost@gmail.com` instead and uses `test_mode: true`.

### Nav update

Add three nav items under a "Pitching" group: Catalogue, Categories, Pitch Composer. Use whatever icon set is already in the project (likely lucide-react).

## Data migration verification

After running migrations, run these checks via curl from a dev machine:

```bash
BASE=https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api

# 1) Categories seeded
curl -sS -X POST "$BASE" -H "content-type: application/json" \
  -d '{"action":"list_categories"}' | jq '.rows | length'   # expect >= 19

# 2) Tracks migrated from spotify_track_urls
curl -sS -X POST "$BASE" -H "content-type: application/json" \
  -d '{"action":"list_tracks"}' | jq '.rows | length'       # expect >= 1

# 3) playlist_targets.platform backfilled
# (run via SQL editor) — expect 0 rows:
# select count(*) from playlist_targets where platform is null;

# 4) playlist_categories populated from lane migration
# (run via SQL editor) — expect >0:
# select count(*) from playlist_categories;
```

## End-to-end test (use test_mode throughout)

```bash
BASE=https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api

# 1) Pick a track id
TID=$(curl -sS -X POST "$BASE" -H "content-type: application/json" \
  -d '{"action":"list_tracks"}' | jq -r '.rows[0].id')

# 2) Recommend warm-aligned targets
curl -sS -X POST "$BASE" -H "content-type: application/json" \
  -d "{\"action\":\"recommend_targets_for_track\",\"track_id\":\"$TID\",\"mode\":\"warm_aligned\",\"limit\":5}" | jq

# 3) Recommend new-cold targets  
curl -sS -X POST "$BASE" -H "content-type: application/json" \
  -d "{\"action\":\"recommend_targets_for_track\",\"track_id\":\"$TID\",\"mode\":\"new_cold\",\"limit\":5}" | jq

# 4) Draft + send in test_mode to Fendi (patch target curator_email first via existing patch_target action)
PID="spotify:2kjP2cZEeabXDbRGQJpDjf"
curl -sS -X POST "$BASE" -H "content-type: application/json" \
  -d "{\"action\":\"patch_target\",\"playlist_id\":\"$PID\",\"curator_email\":\"fendifrost@gmail.com\"}"

DRAFT=$(curl -sS -X POST "$BASE" -H "content-type: application/json" \
  -d "{\"action\":\"draft_pitch\",\"playlist_id\":\"$PID\",\"track_id\":\"$TID\",\"tone\":\"casual_friendly\"}")
DID=$(echo "$DRAFT" | jq -r .draft_id)
echo "$DRAFT" | jq '{subject,body}'

curl -sS -X POST "$BASE" -H "content-type: application/json" \
  -d "{\"action\":\"approve_draft\",\"draft_id\":\"$DID\",\"send_immediately\":true,\"test_mode\":true}" | jq

# Revert
curl -sS -X POST "$BASE" -H "content-type: application/json" \
  -d "{\"action\":\"patch_target\",\"playlist_id\":\"$PID\",\"curator_email\":null}"
```

Repeat with each tone (`warm_personal`, `casual_friendly`, `business_formal`, `hyped_energetic`) to verify all 4 cold templates render correctly.

To test warm templates: first ensure there's a `pitch_log` row with `placed=true` on the playlist (manually insert one in SQL editor for a test row), then draft against it — should produce warm template with `priorTrack` filled.

Final mail-tester re-run: get fresh address from mail-tester.com, patch a target with it, draft+approve (NOT test_mode), verify still 10/10.

## Acceptance criteria

- [ ] Migrations apply cleanly, no errors.
- [ ] Seeded categories visible via `list_categories`.
- [ ] Existing tracks from `spotify_track_urls` appear in `list_tracks`.
- [ ] `platform` column on `playlist_targets` is fully populated, no nulls.
- [ ] `playlist_categories` has rows for every previously-lane-tagged playlist.
- [ ] Catalogue page lets Fendi add a track with name + Spotify URL + 5 categories + tone and persists it.
- [ ] Categories page lets Fendi add/edit/delete categories.
- [ ] Pitch composer flow works end-to-end with test_mode sends to fendifrost@gmail.com.
- [ ] Each of the 4 tones × 2 (cold/warm) = 8 templates renders with correct phrasing and platform link.
- [ ] Warm detection: pitching a playlist that previously placed Fendi automatically uses the warm template and references the prior track.
- [ ] Category mismatch returns 422 unless `override_category_check: true`.
- [ ] "All warm" mode requires confirmation modal in UI before drafts are written.
- [ ] Platform routing: Spotify URL appears in pitches to Spotify curators. (Apple/SoundCloud templates exist but no curators to test against yet — verify via unit-style call with mocked playlist row.)
- [ ] Final mail-tester run scores 10/10 (no regression).
- [ ] Lovable redeploys execute-pitch, draft-pitch, approve-draft, control-center-api after schema migration. Verify via curl that all four edge functions return 200 on a no-op probe.

## Phase 2 & 3 — deferred but documented

**Phase 2 (Apple Music):**
- Templates already shipped in Phase 1.
- Need: research + seed initial Apple Music curators into `playlist_targets` with `platform='apple_music'`. Suggested starter set: Topsify, Filtr, MORS, plus mood-specific independent Apple curators per genre. Probably 20-30 entries per category to start.
- Submission methods for Apple curators are mostly email or AMFA flow (instructions_only). Add `apple_music_for_artists` as a `submission_method` enum value if useful.

**Phase 3 (SoundCloud expansion):**
- Templates already shipped.
- Need: expand existing handful of `soundcloud:` rows. Same research+seed pattern. SoundCloud has more public curators than Apple but smaller per-curator reach.

## Constraints + gotchas

1. **Do not break the test_mode flag** (commit `0b5f100`). Cursor must preserve test_mode plumbing through `draft_pitch` → `approve_draft` → `execute-pitch` in any refactor of `runDraftPitch`.
2. **Do not break Reply-To behavior** (commit `bb7396d`). The fallback `replies@fendifrost.com` in `_shared/resend-pitch.ts:15` must remain.
3. **Backward compat**: legacy callers that pass `track_name` (not `track_id`) must still work. Fall through to old behavior or look up track by name in new table.
4. **RLS**: write paths all flow through edge functions (service role). Don't add Lovable-side direct table writes for tracks/categories — keep the security boundary at the edge function layer.
5. **Daily email cap** (10/24h): leave the existing cap in place. test_mode bypasses it (that's intentional from commit `0b5f100`).
6. **Cooldown is per (playlist_id, track_name)**. Real sends still set cooldown. Tracks_id is stored in draft metadata, not pitch_log — pitch_log keys off `track_name` for now. Don't change `pitch_log` schema in this phase.
7. **Lovable deploy gotcha**: after pushing schema migration, ask Lovable in chat to redeploy `execute-pitch, draft-pitch, approve-draft, control-center-api`. Lovable auto-detects code pushes but sometimes lags on migrations.
8. **The `lanes` system** is still used by `pickCatalogTrackForPlacement` and IG flow. Don't remove it. New category system runs alongside until Phase 4.

## Commit shape

Suggested commits (in order):

1. `feat(catalogue): schema migration — tracks, categories, joins, platform column` (just the SQL migrations)
2. `feat(catalogue): pitch-templates module — 4 tones × cold/warm × multi-platform` (just `_shared/pitch-templates.ts`)
3. `feat(api): track + category CRUD actions; recommend_targets_for_track; list_warm_curators` (the backend actions)
4. `feat(api): track_id-aware draft_pitch with tone + warm detection + category overlap check` (modify `runDraftPitch`)
5. `feat(ui): catalogue + categories pages` (frontend)
6. `feat(ui): pitch composer with 3-bucket recommendations + bulk send` (frontend)
7. `chore: end-to-end test verification + mail-tester re-run`

Push each to `main`. Lovable redeploys automatically. If functions don't pick up, ask Lovable in chat: *"Please redeploy edge functions execute-pitch, draft-pitch, approve-draft, and control-center-api from latest main. Do not modify any code, schema, migration, or other file."*

## Questions to ask Fendi before he goes silent on this thread

None. All decisions are in this doc. If you hit an ambiguity that genuinely blocks you (e.g., "Cursor's environment can't reach Supabase"), surface it. Otherwise build it.

Good luck.

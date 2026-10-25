# AGH vs Control Hub — music pitch and playlist truth

Read-only audit. No live database was queried, no migration was applied, no edge function was redeployed, and no decision-register row was written.

| | |
|---|---|
| Decision needed by | 2026-10-17 |
| Control Hub repo | `fendi-control-center` at `b2b92fdf7e29cf7ba1903437848fd0b3a6081ef4` |
| Control Hub Lovable project | `7fce9fc6-fd96-4a31-8a89-649f00298c51` |
| AGH repo | `fan-growth-pilot` at `dba74af9b5b1194cb37af0792b72a56f58663261` (this SHA is also the Lovable project's `latest_commit_sha`) |
| AGH Lovable project | `4778d2a5-781c-45e5-b165-9497cdba4918` (FanFuel Hub) |
| AGH database ref named in AGH docs | `vsemrziqxrrfcquxfnwd` |
| Control Hub database ref | `wkzwcfmvnwolgrdpnygc` |

**Recommendation:** AGH owns this data. The catalog key is `playlist_targets.playlist_id`. Drafts live in `outreach_drafts`. Sends and replies live in `pitch_log`. Control Hub's `pitch_drafts` and `playlist_research` are a second, thinner store with two incompatible `CREATE TABLE` definitions and no copier from AGH. After Fendi confirms, Part B copies Control Hub-only content into AGH and replaces the Control Hub tables with a one-row pointer.

This audit did not measure row counts. Section 6 is the measurement. A prior AGH handoff claimed `pitch_log` = 390 and `agh_handoff_records` = 1191 on 2026-09-30. Those numbers were not re-checked here.

---

## 1. Canonical identifier

AGH stores the Spotify playlist id as bare base62 text in `playlist_targets.playlist_id`. That column is `UNIQUE NOT NULL`. `platform` is a required attribute and is not part of the key.

`parseSpotifyPlaylistId` / `normalizeSpotifyPlaylistIdentity` in `supabase/functions/_shared/discovery-utils.ts` accept three spellings and store the bare id:

- `https://open.spotify.com/playlist/{id}` (query string and `intl-` / `embed` segments stripped)
- `spotify:{id}` and `spotify:playlist:{id}`
- the bare id

`playlistTargetKeyAliases` looks up all three spellings. Editorial ids that start with `37i9dQZF` are rejected by the parser.

`agh_playlist_identity_map` is a one-time lookup built by `20260930190000_pipeline_repair.sql`. `normalized_id` is `playlist_id` with the prefix `spotify:` or `spotify:playlist:` removed. `canonical_key` references `playlist_targets.playlist_id`. The migration inserts the map once. No trigger and no edge function insert new keys after that. `agh_resolve_playlist_alias` reads it. Discovery also resolves aliases by querying `playlist_targets` directly, so a missing map row does not block a new target.

Control Hub's only playlist identifier is `pitch_drafts.playlist_id text`, nullable, with no unique constraint and no `platform` column. `playlist_research` has no playlist id and no playlist URL.

Route-only AGH targets (no Spotify id) use a server-built identity stored in the same `playlist_id` column. Those values will not overlap a Control Hub row unless the raw strings match.

---

## 2. Control Hub tables

Two tables hold pitch, playlist, curator, or research rows. `muse-workboard` does not write either of them. Its actions are `create_mission`, `create_improvement`, `create_task`, `append_update`, `record_measurement`, `update_task_state`, `update_task_verification`, `update_improvement_state` (`supabase/functions/muse-workboard/contract.ts`). The 2026-09-25 executive migration only **reads** the two tables to seed 30-day counts.

`bot_settings` holds chat scratch for the Telegram pitch shortcuts (`last_playlist_research:{chat}`, `pending_pitch_bulk:{chat}`, `pending_pitch_tier3:{chat}`). That is a session cache of playlist ids, not the catalog.

No Control Hub React page writes these tables. `src/` references them only in generated `types.ts`.

### 2.1 Two CREATE statements disagree

Both use `CREATE TABLE IF NOT EXISTS`, so the later file does not repair the earlier one.

**Schema A** — `supabase/migrations/20260331000000_ai_integration_blueprint.sql` (earlier timestamp):

`playlist_research`: `id uuid PK`, `track_name text NOT NULL`, `genre text`, `results_json jsonb NOT NULL`, `created_at timestamptz NOT NULL`.

`pitch_drafts`: `id uuid PK`, `research_id uuid NULL` FK to `playlist_research`, `playlist_id text NOT NULL`, `email_subject text NOT NULL`, `email_body text NOT NULL`, `status text NOT NULL default 'draft'`, `created_at timestamptz NOT NULL`.

`20260405220012_122aa24a-7978-4beb-b75a-5e1110bdacc0.sql` then adds `channel text NOT NULL default 'email'`, `instagram_handle text`, `dm_content text`.

**Schema B** — `supabase/migrations/20260331222641_a50c133e-fa4d-49ce-b9ca-998d3c3ab3a7.sql`, which is what `src/integrations/supabase/types.ts` and `scripts/muse/fixtures/control_hub_subset.sql` match, plus the Instagram columns:

`playlist_research`: `id uuid`, `artist_name text NOT NULL`, `track_name text NOT NULL`, `genre text`, `model text`, `research jsonb NOT NULL`, `created_at timestamptz`, `updated_at timestamptz`.

`pitch_drafts`: `id uuid`, `channel text NOT NULL default 'email'`, `curator_email text`, `curator_name text`, `dm_content text`, `instagram_handle text`, `model text`, `pitch_content text`, `playlist_id text` (nullable in this definition), `status text default 'draft'` with a check of `draft | approved | sent | responded`, `created_at timestamptz`, `updated_at timestamptz`.

If the files ran in timestamp order on an empty database, Schema A won and Schema B was a no-op. If the Lovable editor created Schema B first and the backdated blueprint file never created the tables, Schema B is live. The column probe in section 6 distinguishes them. Do not edit either migration to force a match.

RLS: `20260331222701` enables RLS and grants authenticated users full access. Service role used by the edge functions bypasses RLS.

### 2.2 Writers, and whether the code can succeed

| Path | Writes | Live or stuck |
|---|---|---|
| `supabase/functions/playlist-research/index.ts` | `playlist_research` insert of `track_name`, `genre`, `results_json` | Called by the Telegram tool `research_playlists`. No cron in the repo. The insert matches Schema A. Against Schema B the insert names a column the generated types do not have (`results_json`) and omits `artist_name` and `research`, both `NOT NULL` on Schema B. |
| `supabase/functions/generate-pitch-email/index.ts` action `generate` | `pitch_drafts` insert of `playlist_id`, `curator_name`, `channel`, `status='draft'`, plus `dm_content` and `instagram_handle` or `pitch_content` | Called by Telegram tool `generate_pitch`. Matches Schema B column names. Against Schema A it omits `email_subject` and `email_body` (`NOT NULL`) and writes `curator_name` / `pitch_content`, which Schema A never adds. |
| Same function, action `send` | `pitch_drafts` update `status='approved_to_send'` | Called by Telegram tool `send_pitch`. It does not send mail. Schema B's check allows `draft`, `approved`, `sent`, `responded` and does not allow `approved_to_send`. |
| Telegram shortcuts in `telegram-webhook/index.ts` (`find playlist opportunities`, `pitch N`, `pitch all tier 1`, `playlist … responded`) | `bot_settings` only, on the Control Hub side | These call AGH functions (`playlist-research`, `playlist-batch`, `execute-pitch`, `pitch-status`, `update-pitch-status`). They do not insert `pitch_drafts` or `playlist_research`. |
| `muse-workboard` | none of these tables | No write path. |
| Control Hub UI | none | No caller in `src/`. |

`playlist-research` also POSTs `{ action: "research_playlists" }` to AGH `control-center-api` and, if that returns JSON, nests it as `fanfuel_matches` inside the local blob. `generate-pitch-email` POSTs `{ action: "get_pitch_context", playlist_id, track_id }`. AGH's action set does not include `research_playlists` or `get_pitch_context` (`PLAYLIST_AGENT_ACTIONS` in `playlist-agent-run.ts`). A non-OK response becomes `null` and the local insert still runs. That is a context fetch, not a row copy.

There is no cron, no sync job, and no `source_id` column that would mark a Control Hub row as copied from AGH.

---

## 3. AGH tables

Column lists are the generated client contract in `fan-growth-pilot/src/integrations/supabase/types.ts` at `dba74af`, except `agh_playlist_identity_map`, which exists only in SQL (service role may `SELECT`; anon and authenticated are revoked).

### 3.1 `playlist_targets` — catalog

Canonical key: `playlist_id text UNIQUE NOT NULL`. Also `platform text NOT NULL`.

Columns (79): `authenticity_notes text`, `authenticity_score numeric`, `bounce_count int`, `contact_confidence numeric`, `contact_method text`, `created_at timestamptz`, `curator_email text`, `curator_handle text`, `curator_instagram text`, `curator_linktree text`, `curator_name text`, `curator_submission_dm text`, `curator_submission_note text`, `curator_submission_url text`, `curator_tiktok text`, `curator_twitter text`, `curator_url text`, `curator_website text`, `discovered_by text`, `discovered_by_label text`, `discovery_profile_id uuid`, `follower_count int`, `form_cost text`, `form_deadline text`, `form_login_required bool`, `form_manual_submit_result text`, `form_manual_submitted_at timestamptz`, `form_manual_submitted_by text`, `form_required_fields text[]`, `form_requirements text`, `form_source_evidence text`, `form_url text`, `form_verified_at timestamptz`, `fraud_score int`, `fraud_verdict text`, `id uuid`, `ig_curator_account text`, `ig_dm_draft text`, `ig_manual_response_status text`, `ig_manual_submitted_at timestamptz`, `ig_manual_submitted_by text`, `ig_source_evidence text`, `ig_verified_at timestamptz`, `is_active bool`, `is_paid bool`, `lane text`, `last_bounced_at timestamptz`, `last_enriched_at timestamptz`, `last_pitched_at timestamptz`, `last_verified_at timestamptz`, `legitimacy_score numeric`, `notes text`, `overlap_score int`, `path_verification_notes text`, `path_verified bool`, `pitch_count int`, `pitch_status text`, `pitched_at timestamptz`, `platform text`, `playlist_id text`, `playlist_name text`, `recommended_pitch_angle text`, `research_context jsonb`, `similar_artists jsonb`, `song_dna_version_id uuid`, `submission_cost text`, `submission_method text`, `submission_url text`, `tier int`, `track_count int`, `track_name text`, `updated_at timestamptz`, `verification_notes text`, `verification_status text`, `verified_by text`, `verified_by_label text`, `vibe_tags jsonb`, `whitelist_status bool`, `why_it_fits text`.

Live writers:

- Claude discovery MCP `submit_playlist_candidates` inserts, and deletes the new row again when the DNA lane check fails (`playlist-discovery-mcp.ts`). `reverifyManuallyVerifiedTarget` updates.
- `agh_mcp_persist_playlist_inventory` does not insert targets. Draft inventory requires the target to already exist.
- PLC / admin via `playlist-agent-run.ts`: `patch_target`, `activate_target`, `deactivate_target`, `verify_targets`, `review_target`, `log_pitch_sent`, `log_platform_pitch`, and send-side status updates.
- `playlist-research` edge function (AGH's own, not Control Hub's): upsert and update. `run_playlist_research` and `run_playlist_sweep` proxy to it.
- `spotify-placements.ts` and `spotify-for-artists-csv.ts`: upsert on `playlist_id`.
- `resend-webhook`: update on bounce.
- `handoff-queues.ts` and `multichannel-path.ts`: update route and verification fields.
- UI pages do not `.from("playlist_targets")`. They go through `control-center-api`.

### 3.2 `pitch_log` — sends and replies

Key: `id uuid`. Playlist link: `playlist_id text` FK to `playlist_targets.playlist_id`. No `updated_at` in the generated types. Freshness columns are `created_at`, `pitched_at`, `sent_at`.

Columns (32): `approval_required bool`, `approved_at timestamptz`, `approved_by text`, `campaign_id uuid`, `cooldown_until timestamptz`, `created_at timestamptz`, `curator_email text`, `dispatched_via text`, `draft_id uuid`, `email_body text`, `follow_up_at timestamptz`, `id uuid`, `method text`, `pitch_copy_hash text`, `pitch_copy_source text`, `pitched_at timestamptz`, `placed bool`, `placement_status text`, `platform_cost_usd numeric`, `platform_name text`, `platform_pitch_id text`, `platform_pitch_url text`, `playlist_id text`, `reply_received bool`, `resend_message_id text`, `response_notes text`, `sent_at timestamptz`, `song_dna_version_id uuid`, `status text`, `subject text`, `track_id uuid`, `track_name text`.

Live writers:

- `execute-pitch` and `send-pitch-email` insert the send row. Control Hub's Telegram shortcuts call `execute-pitch` on AGH, so those sends land here.
- `playlist-agent-run.ts` inserts (`log_pitch_sent`, `log_platform_pitch`) and updates follow-up and response fields.
- `mark_pitch_response` (PLC capability `classify_replies`) writes through `agh_update_pitch_response`.
- `update-pitch-status` (the function Control Hub calls for "playlist … responded/rejected") updates `status` and notes through the same RPC, with a direct-write fallback only if that migration is absent.
- Claude discovery does not insert `pitch_log`. It has no send capability.

### 3.3 `outreach_drafts` — the draft the PLC approves

Key: `id uuid`. Playlist link: `playlist_id text NOT NULL` FK to `playlist_targets`. Required on insert: `body`, `channel`, `track_name`, `playlist_id`.

Columns (29): `approved_at timestamptz`, `approved_by text`, `approved_content_hash text`, `body text`, `campaign_id uuid`, `channel text`, `created_at timestamptz`, `env text`, `generated_at timestamptz`, `generated_by text`, `id uuid`, `is_test bool`, `metadata jsonb`, `ops_idempotency_key text`, `pitch_copy_hash text`, `pitch_copy_source text`, `pitch_log_id uuid`, `platform text`, `playlist_id text`, `recipient text`, `sent_at timestamptz`, `song_dna_version_id uuid`, `status text`, `streaming_link text`, `subject text`, `template_id uuid`, `track_id uuid`, `track_name text`, `updated_at timestamptz`.

Live writers:

- Claude `create_playlist_draft_inventory` composes email with `persist: false`, then `agh_mcp_persist_playlist_inventory` (latest body: `20260916120000_email_handoff_packet_materialize.sql`) inserts `outreach_drafts` for the email channel and inserts `agh_handoff_batches` / `agh_handoff_records` for email and for form/IG packets. Form and IG do not get an `outreach_drafts` row from that RPC.
- PLC / admin `draft_pitch`, `approve_draft`, `update_draft`, `delete_draft`, `schedule_follow_up` in `playlist-agent-run.ts`.
- `execute-pitch` and `send-pitch-email` update the draft when a send is recorded.

### 3.4 `agh_playlist_identity_map`

Columns: `normalized_id text PRIMARY KEY`, `canonical_key text NOT NULL` references `playlist_targets(playlist_id)`.

Writer: the single `INSERT … SELECT` in `20260930190000_pipeline_repair.sql`. After that the table is read-only in application code. It is not kept current by discovery.

### 3.5 `relationship_playlists`

Columns: `id uuid`, `relationship_id uuid` FK, `playlist_id text UNIQUE` FK to `playlist_targets`, `playlist_name text`, `follower_count int`, `genre text`, `first_discovered timestamptz`, `last_seen timestamptz`, `is_active bool`, `created_at timestamptz`.

Writer: the backfill `INSERT … SELECT` in `20260705180850` and the duplicate statement in `20260705_relationship_intelligence_engine.sql`. No edge function or UI writes this table afterward. It is a snapshot bridge, not the live catalog.

### 3.6 `playlist_categories`

Columns: `category_id uuid`, `playlist_id text`. No timestamps.

Writers: `set_playlist_categories` in `playlist-agent-run.ts` (delete + insert), plus historical seed inserts in the pitch-composer migrations. Claude discovery does not write this table.

### 3.7 `agh_playlist_candidate_evaluations`

Columns: `id uuid`, `business_date_ct date`, `track_id uuid`, `identity_key text`, `playlist_target_id text`, `outcome text`, `reason_code text`, `created_target bool`, `attempts int`, `discovered_by text`, `first_seen_at timestamptz`, `last_seen_at timestamptz`.

Unique on `(business_date_ct, track_id, identity_key)`. Outcomes include `verified_eligible_new`, `verified_eligible_existing`, `accepted_unverified`, `duplicate`, `rejected`, `deferred`.

Writer: Claude discovery calls `agh_log_candidate_evaluation` from `createEvaluationLogger` inside `submit_playlist_candidates`. That is the live evaluation log.

### 3.8 `pitch_campaigns`

Columns: `id uuid`, `track_id uuid`, `smart_link_id uuid`, `status text`, `daily_target int`, `notes text`, `pitch_copy text`, `pitch_subject_template text`, `song_dna_version_id uuid`, `taxonomy_version text`, `configuration_snapshot jsonb`, `activated_at timestamptz`, `approved_by text`, `created_by text`, `started_at timestamptz`, `paused_at timestamptz`, `ended_at timestamptz`, `created_at timestamptz`, `updated_at timestamptz`.

Writer: `supabase/functions/_shared/pitch-campaigns.ts` (insert and update), reached from `control-center-api` when `isPitchCampaignAction` matches. Claude discovery reads active campaigns and does not insert them.

### 3.9 `licensing_pitch_log`

Separate from playlist pitching (sync / licensing supervisors).

Columns: `id uuid`, `approved_at timestamptz`, `approved_by text`, `approved_by_label text`, `company text`, `contact_email text`, `contact_name text`, `created_at timestamptz`, `dispatched_via text`, `draft_id uuid`, `email_body text`, `from_address text`, `pitched_at timestamptz`, `placed bool`, `reply_received bool`, `resend_message_id text`, `response_notes text`, `response_status text`, `sent_at timestamptz`, `sent_by text`, `sent_by_label text`, `song_dna_version_id uuid`, `status text`, `subject text`, `supervisor_id uuid`, `track_id uuid`, `track_name text`, `updated_at timestamptz`.

Writer: `insertHubLicensingPitchLog` in `sync-registers.ts`, called from the sync-control lane (`submit_sync_outreach` and the manual-submission record). Not written by playlist discovery or by Control Hub.

### 3.10 What the three live workflows write today

**Claude discovery** (`mcp-playlist-discovery`, actor `claude_playlist_discovery`):

| Tool | Tables written |
|---|---|
| `submit_playlist_candidates` | `playlist_targets` (insert, update on reverify, delete on lane rollback); `agh_playlist_candidate_evaluations` via `agh_log_candidate_evaluation` |
| `create_playlist_draft_inventory` | `outreach_drafts` (email only) and `agh_handoff_batches` / `agh_handoff_records` via `agh_mcp_persist_playlist_inventory` |
| `start_claude_playlist_station` / `complete_claude_playlist_station` | daily-ops station tables, not the pitch catalog |
| `advance_playlist_batches` | handoff batch state only |
| `get_*` tools | read-only |

**Draft** is that second tool plus PLC `draft_pitch` / `approve_draft` / `update_draft` on `outreach_drafts`. Email body is composed from approved Song DNA. The caller is not allowed to supply pitch copy (`rejectCallerPlaylistCopy`).

**PLC** is actor `grok_playlist_control` on AGH `control-center-api`. Capabilities include research, verify, review, approve, reject, send, classify replies, and handoff review (`GROK_CAPS` in `ops-actors.ts`). The writes that follow from those capabilities go through `playlist-agent-run.ts`, `execute-pitch`, `send-pitch-email`, `handoff-queues.ts`, and `agh_update_pitch_response`: `playlist_targets`, `outreach_drafts`, `pitch_log`, `playlist_categories` (when `set_playlist_categories` is called), and the handoff tables. PLC does not write Control Hub.

### 3.11 Nearby AGH tables that are not the ownership question

These hold music operations data and must stay in AGH. They are not a second copy of Control Hub's two tables:

`tracks`, `categories`, `track_categories`, `pitch_templates`, `discovery_profiles`, `discovery_saturation_log`, `playlist_ops_ledger`, `agh_handoff_batches`, `agh_handoff_records`, `relationships`, `radio_targets`, `radio_pitch_log`, `sync_research_targets`, `sync_research_opportunities`, `sync_research_pitch_drafts`, `youtube_share_campaigns`, `youtube_share_targets`, `youtube_share_moments`, `youtube_share_outreach`, `youtube_share_events`.

YouTube channel stats land in AGH `fan_data` (`fan_identifier` `youtube_channel_stats` / `youtube_chartmetric_stats`) via `youtube-stats` and `scrape-chartmetric`. Share seeding is the `youtube_share_*` group, written only by AGH `control-center-api` actions in `youtube-shares.ts`.

---

## 4. Sync and the YouTube connector

Direction that exists in code: **Control Hub calls AGH**. AGH does not call Control Hub.

| Control Hub caller | AGH endpoint | Effect on AGH | Effect on Control Hub |
|---|---|---|---|
| `playlist-research` | `control-center-api` action `research_playlists` | Action is not implemented. Call fails closed to `null`. | Local `playlist_research` insert still attempted. |
| `generate-pitch-email` | `control-center-api` action `get_pitch_context` | Action is not implemented. | Local `pitch_drafts` insert still attempted from the model output. |
| Telegram `callFanFuelHub` | `playlist-research`, `playlist-batch`, `execute-pitch`, `pitch-status`, `update-pitch-status` | Research and sends write AGH `playlist_targets`, `outreach_drafts`, `pitch_log`. Status updates write AGH `pitch_log`. | Playlist ids for the chat are stored in `bot_settings`. Pitch rows are not inserted locally. |

Nothing in either repo inserts an AGH `pitch_log` or `outreach_drafts` row into Control Hub `pitch_drafts`, or the reverse. There is no shared primary key. Control Hub pitch rows are generated locally when the tool path runs. They are not a copy of AGH rows.

YouTube: AGH's YouTube OAuth, analytics, and share-seeding tables never leave AGH. Control Hub has no YouTube table and no YouTube writer. The Lovable workspace custom-connector list for AGH's workspace was empty on this audit. A connector that exists only in the Lovable UI and not in git was not visible here. Source does not show that connector, if it is configured, copying pitch rows.

AGH's edge function is named `control-center-api`. That name is the inbound API Control Hub calls. It is not a client that pushes rows into Control Hub.

---

## 5. Field diff

Compared as named columns. A JSON blob that happens to contain a fact is not the same as a column.

### 5.1 Control Hub `pitch_drafts` (Schema B, the generated contract) vs AGH `outreach_drafts`

Same column names: `id`, `channel`, `created_at`, `playlist_id`, `status`, `updated_at`.

On Control Hub, absent as columns on `outreach_drafts`:

- `curator_email` — AGH keeps this on `pitch_log.curator_email`, `outreach_drafts.recipient`, and `playlist_targets.curator_email`
- `curator_name` — AGH column is `playlist_targets.curator_name`
- `dm_content` — AGH uses `outreach_drafts.body` or `playlist_targets.ig_dm_draft`
- `instagram_handle` — AGH uses `playlist_targets.curator_instagram`, `curator_handle`, `ig_curator_account`
- `model`
- `pitch_content` — AGH uses `outreach_drafts.body` and `pitch_log.email_body`

Schema A extras that Schema B and AGH `outreach_drafts` do not both have as those names: `research_id`, `email_subject`, `email_body`. AGH's equivalents are `subject` and `body` on the draft, and `subject` / `email_body` on `pitch_log`.

On AGH `outreach_drafts`, absent from Control Hub `pitch_drafts`: `approved_at`, `approved_by`, `approved_content_hash`, `body`, `campaign_id`, `env`, `generated_at`, `generated_by`, `is_test`, `metadata`, `ops_idempotency_key`, `pitch_copy_hash`, `pitch_copy_source`, `pitch_log_id`, `platform`, `recipient`, `sent_at`, `song_dna_version_id`, `streaming_link`, `subject`, `template_id`, `track_id`, `track_name`.

### 5.2 Control Hub `playlist_research` vs AGH

AGH has no `playlist_research` table. The closest column is `playlist_targets.research_context jsonb`.

Schema B columns with no same-named AGH column on `playlist_targets`: `artist_name`, `model`, `research`. `track_name` and `genre` exist on AGH (`genre` also on `relationship_playlists`; playlist fit is usually `lane`). `created_at` and `updated_at` exist on `playlist_targets`.

Schema A column with no same-named AGH column: `results_json`.

### 5.3 AGH catalog columns Control Hub does not have

Every `playlist_targets` column in section 3.1 except `id`, `playlist_id`, `curator_name`, `curator_email`, `track_name`, `created_at`, `updated_at` is absent from both Control Hub tables. The operational ones that a merge has to keep on the AGH side are `platform`, `playlist_name`, `path_verified`, `verification_status`, `submission_method`, `contact_method`, `form_url`, `lane`, `tier`, `song_dna_version_id`, `discovery_profile_id`, `research_context`, `is_active`, `is_paid`, and the curator URL / handle columns.

`pitch_log`, `pitch_campaigns`, `licensing_pitch_log`, `agh_playlist_candidate_evaluations`, and `agh_playlist_identity_map` have no Control Hub counterpart at all.

---

## 6. Read-only SQL

Run in the Lovable SQL editor for each project. Paste back only the result grids from these statements. They return counts, timestamps, and column names.

If a statement errors because a column is missing, stop. That error is the schema finding. Do not alter the migration or add the column to make the statement pass.

### 6.1 Control Hub — which shape is live

```sql
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('pitch_drafts', 'playlist_research')
ORDER BY table_name, ordinal_position;
```

Schema A is live when `playlist_research.results_json` and `pitch_drafts.email_subject` are present and `playlist_research.artist_name` is absent.

Schema B is live when `playlist_research.research` and `playlist_research.artist_name` are present and `results_json` is absent.

### 6.2 Control Hub — counts

`created_at` exists in both schemas.

```sql
SELECT 'pitch_drafts' AS table_name,
       count(*)::bigint AS row_count,
       max(created_at) AS max_created_at
FROM public.pitch_drafts
UNION ALL
SELECT 'playlist_research',
       count(*)::bigint,
       max(created_at)
FROM public.playlist_research;
```

Run this only after 6.1 shows `updated_at` on both tables:

```sql
SELECT 'pitch_drafts' AS table_name, max(updated_at) AS max_updated_at
FROM public.pitch_drafts
UNION ALL
SELECT 'playlist_research', max(updated_at)
FROM public.playlist_research;
```

Session cache, counts only:

```sql
SELECT
  count(*) FILTER (WHERE setting_key LIKE 'last\_playlist\_research:%')::bigint AS last_research_keys,
  count(*) FILTER (WHERE setting_key LIKE 'pending\_pitch\_bulk:%')::bigint AS pending_bulk_keys,
  count(*) FILTER (WHERE setting_key LIKE 'pending\_pitch\_tier3:%')::bigint AS pending_tier3_keys
FROM public.bot_settings;
```

### 6.3 AGH — counts and freshness

```sql
SELECT 'playlist_targets' AS table_name,
       count(*)::bigint AS row_count,
       max(updated_at) AS freshness_at,
       'updated_at'::text AS freshness_column
FROM public.playlist_targets
UNION ALL
SELECT 'pitch_log', count(*)::bigint, max(created_at), 'created_at'
FROM public.pitch_log
UNION ALL
SELECT 'outreach_drafts', count(*)::bigint, max(updated_at), 'updated_at'
FROM public.outreach_drafts
UNION ALL
SELECT 'agh_playlist_identity_map', count(*)::bigint, NULL, 'none'
FROM public.agh_playlist_identity_map
UNION ALL
SELECT 'relationship_playlists', count(*)::bigint, max(created_at), 'created_at'
FROM public.relationship_playlists
UNION ALL
SELECT 'playlist_categories', count(*)::bigint, NULL, 'none'
FROM public.playlist_categories
UNION ALL
SELECT 'agh_playlist_candidate_evaluations', count(*)::bigint, max(last_seen_at), 'last_seen_at'
FROM public.agh_playlist_candidate_evaluations
UNION ALL
SELECT 'pitch_campaigns', count(*)::bigint, max(updated_at), 'updated_at'
FROM public.pitch_campaigns
UNION ALL
SELECT 'licensing_pitch_log', count(*)::bigint, max(updated_at), 'updated_at'
FROM public.licensing_pitch_log;
```

### 6.4 Overlap and Control Hub-only rows

Playlist ids are not emails. Still do not paste the id file into chat. The statements below that return rows return counts only.

On AGH, write a local CSV of normalized ids and nothing else. Keep the file private.

```sql
COPY (
  SELECT DISTINCT norm
  FROM (
    SELECT regexp_replace(btrim(playlist_id), '^spotify:(playlist:)?', '') AS norm
    FROM public.playlist_targets
    WHERE playlist_id IS NOT NULL AND btrim(playlist_id) <> ''
    UNION
    SELECT btrim(normalized_id) AS norm
    FROM public.agh_playlist_identity_map
    WHERE normalized_id IS NOT NULL AND btrim(normalized_id) <> ''
  ) s
) TO STDOUT WITH (FORMAT csv, HEADER true);
```

On Control Hub, in one SQL-editor session, load that file into a temp table named `agh_playlist_norm` with a single `norm text` primary key. Temp tables die with the session. Then run:

```sql
WITH cc AS (
  SELECT
    id,
    CASE
      WHEN playlist_id IS NULL OR btrim(playlist_id) = '' THEN NULL
      ELSE regexp_replace(
        split_part(
          regexp_replace(
            split_part(btrim(playlist_id), '?', 1),
            '^https?://[^/]+/(?:intl-[^/]+/)?(?:embed/)?playlist/',
            ''
          ),
          '/',
          1
        ),
        '^spotify:(?:playlist:)?',
        ''
      )
    END AS norm
  FROM public.pitch_drafts
)
SELECT
  (SELECT count(*)::bigint FROM cc) AS cc_pitch_draft_rows,
  (SELECT count(*)::bigint FROM cc WHERE norm IS NULL) AS cc_rows_missing_playlist_id,
  (SELECT count(*)::bigint FROM (
     SELECT DISTINCT c.norm
     FROM cc c
     JOIN agh_playlist_norm a ON a.norm = c.norm
   ) d) AS distinct_playlist_ids_in_both,
  (SELECT count(*)::bigint FROM cc c
    JOIN agh_playlist_norm a ON a.norm = c.norm) AS cc_rows_whose_playlist_id_is_in_agh,
  (SELECT count(*)::bigint FROM cc c
    WHERE c.norm IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM agh_playlist_norm a WHERE a.norm = c.norm)
  ) AS cc_rows_playlist_id_absent_from_agh,
  (SELECT count(*)::bigint FROM cc c
    WHERE c.norm IS NULL
       OR NOT EXISTS (SELECT 1 FROM agh_playlist_norm a WHERE a.norm = c.norm)
  ) AS cc_rows_only_in_control_hub;
```

`playlist_research` has no playlist id. Its `row_count` from 6.2 is the count of research rows that exist only in Control Hub. There is no overlap key for that table.

`licensing_pitch_log` is not part of this overlap. It has no Control Hub twin.

---

## 7. Part B — after canonical confirmation only

Do not run this section until Fendi confirms AGH as the home, on or before 2026-10-17. Do not run it from the Supabase CLI. The Lovable SQL editor on each project is the apply path. Do not edit a migration to force it to succeed. A statement that errors against the live columns means section 6.1 is the source of truth for which Control Hub columns exist.

Part B preserves every Control Hub pitch draft and every research blob. It adds a `playlist_targets` row only when the normalized playlist id is absent from AGH. Those new rows are inactive and unverified. It does not insert `outreach_drafts`. The live trigger `agh_guard_draft_policy` (`20260930190000_pipeline_repair.sql`) calls `agh_contact_policy` on every insert, and that function returns `identity_required` when `track_id` is null. A real track id would still be rejected for cooldown, paid, blocked, or inactive targets. Disabling that trigger to force the insert is out of bounds: it would create `pending` drafts the PLC can approve. Draft text stays in `control_hub_pitch_import_20261017.payload`, which keeps every Control Hub column. `pitch_log` is not written.

### 7.1 Backup

On each database, before any insert into the live pitch tables:

```sql
CREATE TABLE public.pitch_drafts_backup_20261017 AS TABLE public.pitch_drafts;
CREATE TABLE public.playlist_research_backup_20261017 AS TABLE public.playlist_research;
```

```sql
CREATE TABLE public.playlist_targets_backup_20261017 AS TABLE public.playlist_targets;
CREATE TABLE public.outreach_drafts_backup_20261017 AS TABLE public.outreach_drafts;
CREATE TABLE public.pitch_log_backup_20261017 AS TABLE public.pitch_log;
```

Proof, counts only. The backup count must equal the live count from section 6. If it does not, stop.

```sql
SELECT 'pitch_drafts' AS table_name,
       (SELECT count(*) FROM public.pitch_drafts) AS live_n,
       (SELECT count(*) FROM public.pitch_drafts_backup_20261017) AS backup_n
UNION ALL
SELECT 'playlist_research',
       (SELECT count(*) FROM public.playlist_research),
       (SELECT count(*) FROM public.playlist_research_backup_20261017);
```

```sql
SELECT 'playlist_targets' AS table_name,
       (SELECT count(*) FROM public.playlist_targets) AS live_n,
       (SELECT count(*) FROM public.playlist_targets_backup_20261017) AS backup_n
UNION ALL
SELECT 'outreach_drafts',
       (SELECT count(*) FROM public.outreach_drafts),
       (SELECT count(*) FROM public.outreach_drafts_backup_20261017)
UNION ALL
SELECT 'pitch_log',
       (SELECT count(*) FROM public.pitch_log),
       (SELECT count(*) FROM public.pitch_log_backup_20261017);
```

### 7.2 Land Control Hub rows in AGH without printing them

On AGH, create import tables. `payload` holds the whole Control Hub row, so Schema A and Schema B columns both survive. Do not select `payload` back out.

```sql
CREATE TABLE public.control_hub_pitch_import_20261017 (
  source_id uuid PRIMARY KEY,
  norm text,
  payload jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.control_hub_research_import_20261017 (
  source_id uuid PRIMARY KEY,
  payload jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
```

Export from Control Hub to local files. Do not paste the files into chat. They can contain curator names and message text.

```sql
COPY (
  SELECT id AS source_id,
         CASE
           WHEN playlist_id IS NULL OR btrim(playlist_id) = '' THEN NULL
           ELSE regexp_replace(
             split_part(
               regexp_replace(
                 split_part(btrim(playlist_id), '?', 1),
                 '^https?://[^/]+/(?:intl-[^/]+/)?(?:embed/)?playlist/',
                 ''
               ),
               '/', 1
             ),
             '^spotify:(?:playlist:)?',
             ''
           )
         END AS norm,
         to_jsonb(pitch_drafts) AS payload
  FROM public.pitch_drafts
) TO STDOUT WITH (FORMAT csv, HEADER true);
```

```sql
COPY (
  SELECT id AS source_id, to_jsonb(playlist_research) AS payload
  FROM public.playlist_research
) TO STDOUT WITH (FORMAT csv, HEADER true);
```

Load those files into the two AGH import tables (`source_id`, `norm`, `payload` for pitches; `source_id`, `payload` for research). `payload` is the whole Control Hub row, so Schema A and Schema B columns both survive, including `curator_email`, `curator_name`, `dm_content`, `instagram_handle`, `model`, `pitch_content`, `email_subject`, `email_body`, `research_id`, `results_json`, `research`, and `artist_name`.

Then insert missing catalog keys only. `is_active` defaults to true in `20260322024717`, so the insert sets it false. `is_paid` is a generated column (`20260621_playlist_targets_is_paid.sql`); do not write it. `contact_method`, `submission_cost`, and `verification_status` use the allowed value `unknown` / `unverified`. Do not update `research_context` on a playlist AGH already has.

```sql
INSERT INTO public.playlist_targets (
  playlist_id, platform, playlist_name, track_name, contact_method,
  submission_cost, path_verified, verification_status, pitch_count,
  is_active, research_context
)
SELECT
  i.norm,
  CASE WHEN i.norm ~ '^[A-Za-z0-9]{22}$' THEN 'spotify' ELSE 'unknown' END,
  'control-hub-import',
  'control-hub-import',
  'unknown',
  'unknown',
  false,
  'unverified',
  0,
  false,
  jsonb_build_object(
    'control_hub_import', true,
    'control_hub_pitch_source_ids', i.source_ids
  )
FROM (
  SELECT norm, jsonb_agg(source_id) AS source_ids
  FROM public.control_hub_pitch_import_20261017
  WHERE norm IS NOT NULL AND btrim(norm) <> ''
  GROUP BY norm
) i
WHERE NOT EXISTS (
  SELECT 1 FROM public.playlist_targets t
  WHERE t.playlist_id = i.norm
     OR regexp_replace(btrim(t.playlist_id), '^spotify:(playlist:)?', '') = i.norm
)
AND NOT EXISTS (
  SELECT 1 FROM public.agh_playlist_identity_map m
  WHERE m.normalized_id = i.norm OR m.canonical_key = i.norm
);
```

Rows whose playlist id is null stay in `control_hub_pitch_import_20261017` only. They have no catalog key to attach to.

Research blobs stay in `control_hub_research_import_20261017`. They have no playlist id, so they are not written onto `playlist_targets`.

Map each newly inserted bare id so later alias lookup sees it:

```sql
INSERT INTO public.agh_playlist_identity_map (normalized_id, canonical_key)
SELECT t.playlist_id, t.playlist_id
FROM public.playlist_targets t
WHERE t.playlist_name = 'control-hub-import'
  AND t.is_active = false
  AND NOT EXISTS (
    SELECT 1 FROM public.agh_playlist_identity_map m
    WHERE m.normalized_id = t.playlist_id
  );
```

### 7.3 Zero-data-loss proof

All four numbers in each result must match. Stop if any pair differs. Do not delete the Control Hub tables until they match.

```sql
SELECT
  (SELECT count(*) FROM public.pitch_drafts_backup_20261017) AS cc_pitch_backup_n,
  (SELECT count(*) FROM public.control_hub_pitch_import_20261017) AS agh_pitch_import_n,
  (SELECT count(*) FROM public.playlist_research_backup_20261017) AS cc_research_backup_n,
  (SELECT count(*) FROM public.control_hub_research_import_20261017) AS agh_research_import_n;
```

`cc_pitch_backup_n` must equal `agh_pitch_import_n`. `cc_research_backup_n` must equal `agh_research_import_n`.

Draft and send tables were not used as the import destination:

```sql
SELECT
  (SELECT count(*) FROM public.outreach_drafts_backup_20261017) AS drafts_before,
  (SELECT count(*) FROM public.outreach_drafts) AS drafts_after,
  (SELECT count(*) FROM public.pitch_log_backup_20261017) AS pitch_log_before,
  (SELECT count(*) FROM public.pitch_log) AS pitch_log_after,
  (SELECT count(*) FROM public.playlist_targets_backup_20261017) AS targets_before,
  (SELECT count(*) FROM public.playlist_targets) AS targets_after,
  (SELECT count(*) FROM public.playlist_targets
    WHERE playlist_name = 'control-hub-import' AND is_active = false) AS inactive_import_targets;
```

`drafts_after` must equal `drafts_before`. `pitch_log_after` must equal `pitch_log_before`. `targets_after` must equal `targets_before` plus `inactive_import_targets`.

No import source id twice:

```sql
SELECT count(*)::bigint AS duplicate_pitch_source_ids
FROM (
  SELECT source_id FROM public.control_hub_pitch_import_20261017
  GROUP BY source_id HAVING count(*) > 1
) d;
```

Expected value: `0`. The primary key on `source_id` makes a value other than `0` a failed load.

### 7.4 Reduce Control Hub to a one-row pointer

Run only after 7.3 matches. This drops the live data tables on Control Hub. The backups from 7.1 remain until a later, separate decision deletes them.

```sql
DROP TABLE public.pitch_drafts;
DROP TABLE public.playlist_research;

CREATE TABLE public.music_pitch_home (
  id integer PRIMARY KEY CHECK (id = 1),
  home text NOT NULL,
  home_repo text NOT NULL,
  home_lovable_project text NOT NULL,
  catalog_table text NOT NULL,
  draft_table text NOT NULL,
  send_table text NOT NULL,
  import_note text NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.music_pitch_home (
  id, home, home_repo, home_lovable_project,
  catalog_table, draft_table, send_table, import_note
) VALUES (
  1,
  'agh',
  'fendifrost-dot/fan-growth-pilot',
  '4778d2a5-781c-45e5-b165-9497cdba4918',
  'public.playlist_targets',
  'public.outreach_drafts',
  'public.pitch_log',
  'Control Hub pitch_drafts and playlist_research payloads sit in AGH control_hub_pitch_import_20261017 and control_hub_research_import_20261017. Missing playlist ids were added to playlist_targets as inactive unverified control-hub-import rows. outreach_drafts was not inserted, because agh_guard_draft_policy rejects trackless drafts.'
);
```

Pointer proof:

```sql
SELECT count(*)::bigint AS pointer_rows FROM public.music_pitch_home;
```

Expected value: `1`.

```sql
SELECT to_regclass('public.pitch_drafts') AS pitch_drafts_still_present,
       to_regclass('public.playlist_research') AS playlist_research_still_present,
       to_regclass('public.pitch_drafts_backup_20261017') AS pitch_backup_present,
       to_regclass('public.playlist_research_backup_20261017') AS research_backup_present;
```

Expected: the two live names are null, the two backup names are not null.

Leave `generate-pitch-email`, `playlist-research`, and the Telegram tools that call them undeployed until a follow-up change points those tools at AGH only. Dropping the tables will make those functions fail if they are still invoked. That failure is the signal they are no longer a second writer. Redeploy is a separate Lovable step and is out of scope for this audit.

---

## 8. Evidence for the recommendation

| Signal | AGH | Control Hub |
|---|---|---|
| Live writer | Claude MCP writes `playlist_targets` and, through `agh_mcp_persist_playlist_inventory`, `outreach_drafts` and handoff rows. PLC writes `outreach_drafts`, `pitch_log`, and `playlist_targets`. `execute-pitch` is what Control Hub's own Telegram shortcuts call. | Local inserts exist, and they target a schema the other `CREATE TABLE` does not have. The Telegram path that operators use for pitches writes AGH, not these tables. `muse-workboard` does not write them. No UI writes them. No cron writes them. |
| Schema | One catalog key, drafts, send ledger, campaigns, evaluation log, identity aliases. Generated types match the MCP insert allow-list (`PLAYLIST_TARGETS_SCHEMA_INSERT_KEYS`). | Two `CREATE TABLE IF NOT EXISTS` shapes. The edge functions each match a different shape. `send` writes a status value Schema B's check rejects. |
| Freshness in code | Migrations through `20260930210000` (response attribution, route recert). Identity map and candidate log are September 2026. | Pitch columns last altered `20260405220012` (Instagram fields). The 2026-09-25 executive seed already asks whether these rows should remain a second copy, and it names AGH as the music source of truth. |
| Copy relationship | Source of the rows the Telegram shortcuts mutate. | No code copies AGH rows in. Failed `research_playlists` / `get_pitch_context` calls do not replicate a table. |

The executive seed question, already in `20260925120000_muse_executive_layer.sql`, is: "Should Control Hub pitch and playlist tables remain a second copy of music truth?" This audit does not answer that row in `muse_decisions`. Fendi's confirmation does.

Part B is written so the loser is Control Hub. If the confirmation goes the other way, do not run Part B. Control Hub's schema cannot hold AGH's catalog without a different design, and this audit does not recommend that direction.

Ready for canonical confirmation.

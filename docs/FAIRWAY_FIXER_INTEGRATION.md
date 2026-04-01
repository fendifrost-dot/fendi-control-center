# Fairway Fixer (Credit Guardian) ↔ Control Hub

Internal integration between [fendi-control-center](https://github.com/fendifrost-dot/fendi-control-center) and the Fairway Fixer Supabase project.

## What was wrong

- The hub called `/functions/v1/**control-center-api**`, while Fairway Fixer only deployed **`cross-project-api`** (same auth, different path) — requests could 404.
- `ingest-drive-clients` sent **`import_timeline_events`**, which did not exist on Fairway — imports never persisted to the evidence ledger.
- `query_credit_guardian` used fictional actions (`get_assessments`, etc.) that did not match the real API.

## What we fixed

1. **Fairway Fixer** — Shared handler in `supabase/functions/_shared/creditGuardianApi.ts`:
   - **`cross-project-api`** and **`control-center-api`** are identical entrypoints (deploy both or either).
   - **`import_timeline_events`** — resolves client by Drive folder name → `clients.legal_name`, inserts `timeline_events` with forensic `raw_line`.
   - **`get_recent_activity`** — optional `params.client_id` to scope rows (still optional for global recent).

2. **Control Hub** — `supabase/functions/_shared/creditGuardian.ts`:
   - **`CREDIT_GUARDIAN_FUNCTION`** defaults to **`cross-project-api`** (override if you deploy only the alias).
   - **`fetchCreditGuardian`** uses **`x-api-key` only** (no `Authorization: Bearer` for this function).

3. **Telegram** — `query_credit_guardian` maps legacy action names to real Fairway actions; **`session_id`** is treated as **`client_id`**.

4. **Connected project stats** — `fetchProjectStats` now calls **`get_clients`** instead of nonexistent **`get_stats`**.

## Environment variables (Control Hub / Supabase secrets)

| Secret | Purpose |
|--------|---------|
| `CREDIT_GUARDIAN_URL` | Fairway Supabase URL, e.g. `https://<ref>.supabase.co` |
| `CREDIT_GUARDIAN_KEY` | Same shared secret as Fairway `CREDIT_GUARDIAN_KEY` for edge functions |
| `CREDIT_GUARDIAN_FUNCTION` | Optional. Default `cross-project-api`. Set `control-center-api` if you only deploy the alias. |

## Environment variables (Fairway Fixer)

| Secret | Purpose |
|--------|---------|
| `CREDIT_GUARDIAN_KEY` | Must match the hub; used by `cross-project-api` / `control-center-api` |
| `CREDIT_GUARDIAN_DEFAULT_OWNER_ID` | Optional. Your `auth.users` UUID — allows **auto-creating** a Fairway client when Drive folder name has no match |

## Deploy

**Fairway Fixer repo:**

```bash
supabase functions deploy cross-project-api
supabase functions deploy control-center-api   # optional alias
```

**Control Hub:** redeploy `telegram-webhook` and `ingest-drive-clients` after pulling changes.

## `connected_projects` table

`supabase_url` should be the Fairway project URL; `secret_key_name` should point to a secret whose **value equals** `CREDIT_GUARDIAN_KEY` on the Fairway side.

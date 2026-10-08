# Muse Workboard Write Path — Deployment Handoff

## Purpose

Remove Fendi as the manual dispatcher between Muse and execution agents while preserving the read-only boundary of `muse-executive`.

Architecture after deployment:

`Muse -> muse-workboard (scoped POST) -> Mission/Improvement/Task/Work Feed -> Grok/Claude read through muse-executive -> execution -> status/evidence back through muse-workboard -> Muse verifies -> Fendi only when owner attention is required.`

`muse-executive` remains GET-only and unchanged.

## Files

- `supabase/migrations/20260930030000_muse_workboard_write_audit.sql`
- `supabase/functions/muse-workboard/index.ts`
- `supabase/functions/muse-workboard/contract.ts`
- `supabase/functions/muse-workboard/contract.test.ts`

## Security model

The writer accepts only POST/OPTIONS and only bearer tokens already registered in `public.muse_api_tokens` with the explicit scope:

`workboard:write`

A Supabase service-role key is explicitly rejected as a caller credential.

There is no caller-selected table, SQL, RPC, column list, or arbitrary mutation path.

Allowed actions only:

- `create_mission`
- `create_improvement`
- `create_task`
- `append_update`
- `record_measurement`
- `update_task_state`
- `update_task_verification`
- `update_improvement_state`

All write requests require an `Idempotency-Key` header (8–120 chars, safe character set). Replays return the stored response and cannot create duplicate assignments.

## Deploy order

1. Apply migration `20260930030000_muse_workboard_write_audit.sql`.
2. Deploy edge function `muse-workboard`.
3. Identify the dedicated Muse API-token row currently used by the active Muse agent. Do not broaden all tokens.
4. Add `workboard:write` to that token's `scopes` array while preserving its existing `read` scope. If the active Muse credential is only the environment bootstrap token and has no row in `muse_api_tokens`, mint/register a dedicated hashed token instead; do not make the bootstrap token implicitly writable.
5. Give that same dedicated token to Muse's Control Center integration so its GET calls continue to use `muse-executive` and its delegated work uses `muse-workboard`.

## Verification

Verify the following live:

1. GET to `muse-workboard` -> 405.
2. POST with no token -> 401.
3. POST using a token with only `read` scope -> 401 / lacks `workboard:write`.
4. POST using the service-role key -> 401.
5. POST using the scoped Muse token and an unknown action -> 400.
6. `create_improvement` produces exactly one row.
7. Repeating the same request with the same `Idempotency-Key` produces no duplicate and returns `idempotent_replay: true`.
8. `create_task` creates a task visible from `/executive/agent-queue?executor=<executor>`.
9. `append_update` creates a row visible from `/executive/work-feed`.
10. `update_task_state` changes only the specified workboard task.
11. Existing `muse-executive` POST/PUT/PATCH/DELETE remain 405.

Use disposable verification records and either close/cancel them clearly or label them as deployment verification; do not fabricate business outcomes.

## Agent operating contract

Muse may autonomously write workboard state for routine, reversible, low-risk delegation.

Muse must set `owner_attention` on improvements appropriately:

- `NONE` — delegate without Fendi.
- `INFORM` — execute within authority, then brief Fendi.
- `APPROVAL` — prepare work; do not cross the approval boundary.
- `DECISION` — surface the decision to Fendi; no pretending it is delegated.
- `DIRECT_INVOLVEMENT` — Fendi is genuinely required.

Muse must not use the workboard writer to change external business systems. This function coordinates work; execution continues through the appropriate agent/tool capability.

## Grok / Claude pickup

Grok and Claude do not need database write credentials.

They can read scoped work through the existing executive API, for example:

- `/executive/agent-queue?executor=Grok%20Bot`
- `/executive/agent-queue?executor=Claude`

After execution, the agent that has a scoped writer credential (or the coordinator acting on its verified result) records state/evidence through `muse-workboard`.

Longer-term, each autonomous agent should have its own separately revocable token/label so audit attribution identifies the actual actor. Do not share service-role credentials.

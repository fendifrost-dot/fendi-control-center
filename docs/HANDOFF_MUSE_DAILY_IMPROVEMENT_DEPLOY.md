# Handoff — Muse Daily Improvement Engine

## Status

Implementation is on branch `chatgpt/muse-daily-improvement-engine`.

This change is additive. It does not replace the existing Muse executive layer.

## Deploy order

1. Apply `supabase/migrations/20260929160000_muse_daily_improvement_engine.sql`.
2. Apply `supabase/migrations/20260929161000_muse_daily_improvement_view_fixes.sql`.
3. Apply `supabase/migrations/20260929161500_muse_work_updates_append_only.sql`.
4. Run `scripts/muse/verify-daily-improvement-engine.sql`.
5. Redeploy `muse-executive` so the six additional read resources become available.
6. Publish the frontend.

## Expected UI routes

- `/muse/missions`
- `/muse/daily`
- `/muse/agents`
- `/muse/impact`

Existing Muse routes must remain working.

## Expected executive resources

- `/executive/missions`
- `/executive/daily-improvements`
- `/executive/agent-queue`
- `/executive/verification-queue`
- `/executive/improvement-results`
- `/executive/work-feed`

## Security invariants

- `muse-executive` remains GET-only.
- Existing Muse read token does not gain write scope.
- `muse_work_updates` is append-only for authenticated operators.
- Domain systems remain authoritative for operational truth.
- No agent completion claim bypasses verification.

## Known deliberate limitation

External Muse/Grok/Claude write access is NOT introduced in this tranche. Agent mutation must go through an approved, scoped Control Center execution path rather than widening the public executive API.

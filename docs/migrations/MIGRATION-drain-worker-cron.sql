-- ============================================================================
-- MIGRATION: drain-guardian-queue pg_cron schedule
-- Purpose:   Wires the drain-guardian-queue edge function to a 1-minute
--            pg_cron tick. Operator-confirmed defaults (May 2026):
--              * cadence: 1 minute (low intake volume; tighten to 30s only
--                if operator requests faster confirmation feedback)
--              * DLQ:     none for now — retry_exhausted rows live as
--                         status='failed' with error_message populated;
--                         operator queries SQL when needed (Phase 4 may add
--                         a Telegram/Slack page surface)
--              * lease:   5 min in claim_pending_guardian_events (sized for
--                         typical Guardian response <5s plus headroom;
--                         revisit if a bureau path needs >5 min)
-- Apply via: Lovable chat. Per the standing constraint, the operator does NOT
--            run this directly: "Any supabase changes will need to be executed
--            ONLY through lovable chat function by request from lovable as we
--            don't have access to any of the supabase code."
--
-- Hard dependency: MIGRATION-drain-worker-status.sql must already be applied
-- (this schedule invokes the edge function, which calls the
-- claim_pending_guardian_events RPC defined there).
--
-- Notes
-- -----
--   * Requires `pg_cron` and `pg_net` extensions enabled on the Hub project.
--     Lovable confirms both are already enabled (used by other Hub crons).
--   * The job authenticates with the Hub's service-role key via a GUC the
--     Lovable runtime sets (`app.settings.service_role_key`). If your project
--     uses a different mechanism, swap the headers expression — the rest is
--     unchanged.
--   * Replace `<HUB_PROJECT_REF>` with the Hub Supabase project ref before
--     applying (Lovable's chat handler does this substitution automatically;
--     manual apply requires editing).
-- ============================================================================

-- Replace any prior schedule with the same name (idempotent re-apply).
do $$
declare
  existing_jobid bigint;
begin
  select jobid into existing_jobid from cron.job where jobname = 'drain-guardian-queue';
  if existing_jobid is not null then
    perform cron.unschedule(existing_jobid);
  end if;
end$$;

select cron.schedule(
  'drain-guardian-queue',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://<HUB_PROJECT_REF>.supabase.co/functions/v1/drain-guardian-queue',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
      ),
      body := '{}'::jsonb
    );
  $$
);

-- ============================================================================
-- ROLLBACK (only if disabling the drain temporarily)
-- ============================================================================
--   select cron.unschedule(jobid) from cron.job where jobname = 'drain-guardian-queue';

-- Keep the response heap from growing back to hundreds of megabytes.
-- pg_net 0.19.5 still will not vacuum it. One day's fire-and-forget
-- cron responses are kilobytes; 15:00 UTC is outside the 00:40-05:15 UTC
-- stall. The two http_post jobs are not slowed down.
--
-- Run this only after 20261117170000 has committed. If scheduling is
-- denied, leave the grant alone and report the error. The truncate
-- function from the previous file still works when called directly.

DO $$
DECLARE
  existing_jobid bigint;
BEGIN
  SELECT jobid INTO existing_jobid
  FROM cron.job
  WHERE jobname = 'truncate-pg-net-responses';
  IF existing_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(existing_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'truncate-pg-net-responses',
  '0 15 * * *',
  $$SELECT public.truncate_pg_net_responses();$$
);

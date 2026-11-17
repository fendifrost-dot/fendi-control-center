-- Stop authenticated Muse calls from waiting on muse_api_tokens, and stop
-- cron.job_run_details from growing without a bound.
--
-- What the live database showed on 2026-11-17 (read-only):
--   * pg_net 0.19.5, worker user postgres, ttl 6 hours.
--     net._http_response is a 421 MB heap for about 100 live rows. Its last
--     autovacuum is 2026-08-05 and n_dead_tup stays 0, because the worker
--     writes through SPI and does not flush stats (pg_net#254). The worker's
--     expiry DELETE (same statement text as the extension) has run 206,076
--     times as postgres: minimum 0.01 ms, mean 10.1 s, max 73.5 minutes.
--   * cron.job_run_details is a 642 MB heap, primary key on runid only,
--     never autovacuumed, no retention. Inserts have peaked at 160 s.
--   * cron.use_background_workers is off, so each job opens a new connection.
--     From 2026-11-13 01:45 UTC through 2026-11-17 05:00 UTC, both existing
--     jobs failed with "job startup timeout" only inside roughly 00:40-05:00
--     UTC, and the 05:00 tick was the last failure every night. That is the
--     Chicago evening window. The job SQL never started; the server could
--     not accept the connection within 10 seconds.
--   * Authenticated muse-alerts / muse-workboard calls then await
--     UPDATE muse_api_tokens SET last_used_at. That statement has peaked at
--     40.7 s. statement_timeout on the database is 120 s and lock_timeout is
--     0. A request with no token returns 401 before any query.
--
-- This file does not VACUUM and does not DELETE inside the migration
-- transaction. postgres is not the owner of the extension tables and is not
-- a superuser, so VACUUM and CREATE INDEX on them fail here. Do not grant
-- superuser or change ownership to get around that.
--
-- prune_cron_job_run_details deletes by runid, which already has a unique
-- index. A DELETE ... WHERE start_time < now() would seq-scan the 642 MB heap.
-- Scheduling it is a separate statement: see the comment at the bottom.

-- ---------------------------------------------------------------------------
-- Token lookup. The stamp is best-effort and cannot block the request.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.muse_resolve_api_token(p_token_sha256 text)
RETURNS TABLE (
  id uuid,
  label text,
  scopes text[],
  expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rec public.muse_api_tokens%ROWTYPE;
BEGIN
  PERFORM set_config('statement_timeout', '3000', true);
  PERFORM set_config('lock_timeout', '250', true);

  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  SELECT * INTO rec
  FROM public.muse_api_tokens AS t
  WHERE t.token_sha256 = p_token_sha256;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Same row is shared by every caller of this token. Skip the write when the
  -- stamp is fresh so requests do not queue on the row lock. If another
  -- session already holds it, keep the token and move on.
  BEGIN
    UPDATE public.muse_api_tokens AS t
    SET last_used_at = now()
    WHERE t.id = rec.id
      AND (t.last_used_at IS NULL OR t.last_used_at < now() - interval '5 minutes');
  EXCEPTION
    WHEN lock_not_available THEN
      NULL;
  END;

  RETURN QUERY
  SELECT rec.id, rec.label, rec.scopes, rec.expires_at, rec.revoked_at;
END;
$$;

REVOKE ALL ON FUNCTION public.muse_resolve_api_token(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.muse_resolve_api_token(text) TO service_role;

COMMENT ON FUNCTION public.muse_resolve_api_token(text) IS
  'Resolve a SHA-256 Muse bearer hash. Stamps last_used_at at most once every 5 minutes and abandons that stamp after a 250 ms lock wait. statement_timeout is 3 s.';

-- ---------------------------------------------------------------------------
-- Bound cron.job_run_details. Keep the newest 10,000 run ids (~2 weeks at
-- the live */5 cadence, less if a job is still on a 1-minute schedule).
-- 2,000 rows per run, off the minute the other jobs use.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prune_cron_job_run_details(
  keep_rows integer DEFAULT 10000,
  batch_size integer DEFAULT 2000
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = cron, public, pg_temp
AS $$
DECLARE
  newest bigint;
  removed integer;
BEGIN
  PERFORM set_config('statement_timeout', '8000', true);
  PERFORM set_config('lock_timeout', '1000', true);

  IF keep_rows < 1000 OR keep_rows > 100000 THEN
    RAISE EXCEPTION 'keep_rows must be between 1000 and 100000';
  END IF;
  IF batch_size < 1 OR batch_size > 2000 THEN
    RAISE EXCEPTION 'batch_size must be between 1 and 2000';
  END IF;

  SELECT max(runid) INTO newest FROM cron.job_run_details;
  IF newest IS NULL OR newest <= keep_rows THEN
    RETURN 0;
  END IF;

  DELETE FROM cron.job_run_details
  WHERE runid IN (
    SELECT d.runid
    FROM cron.job_run_details AS d
    WHERE d.runid <= newest - keep_rows
    ORDER BY d.runid
    LIMIT batch_size
  );

  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_cron_job_run_details(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_cron_job_run_details(integer, integer) TO postgres, service_role;

COMMENT ON FUNCTION public.prune_cron_job_run_details(integer, integer) IS
  'Delete the oldest cron.job_run_details rows by primary key, at most batch_size per call, keeping the newest keep_rows run ids. Does not scan start_time.';

-- Not scheduled here. cron.schedule is SECURITY INVOKER, and postgres has
-- SELECT-only on cron.job (extensions.grant_pg_cron_access revokes the rest).
-- A schedule statement in this file would abort the token function with it.
-- The handoff tries the schedule separately and treats permission denied as
-- the result, not as a reason to grant INSERT on cron.job.

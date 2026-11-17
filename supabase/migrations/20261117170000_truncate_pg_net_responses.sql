-- Reclaim the bloated pg_net response heap.
--
-- Measured 2026-11-17: net._http_response is an unlogged 421 MB heap
-- (430 MB with its created index) holding about 100 live rows. Last
-- autovacuum is 2026-08-05. pg_net 0.19.5's worker deletes expired
-- responses without flushing stats, so autovacuum never sees the dead
-- tuples (fixed upstream in pg_net 0.20.3). This server's
-- pg_available_extension_versions stops at 0.19.5, which is already
-- installed. ALTER EXTENSION cannot move it.
--
-- postgres is not the table owner and cannot VACUUM. postgres does have
-- TRUNCATE. A TRUNCATE rolled back in the same session returned
-- heap=0 bytes, and the live heap was still 421 MB afterward.
--
-- Nothing in this database reads the response rows. The only writers
-- are cron jobs dispatch-chunk-jobs and drain-guardian-queue. Both call
-- net.http_post and do not collect the response. The request queue is
-- net.http_request_queue and is not touched here.
--
-- lock_timeout is 5 seconds. If the pg_net worker holds the table, this
-- statement fails and changes nothing. Run it again. Do not raise the
-- timeout, and do not VACUUM or change table ownership.

CREATE OR REPLACE FUNCTION public.truncate_pg_net_responses()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = net, public, pg_temp
AS $$
DECLARE
  bytes bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  TRUNCATE TABLE net._http_response;
  SELECT pg_relation_size('net._http_response') INTO bytes;
  RETURN bytes;
END;
$$;

REVOKE ALL ON FUNCTION public.truncate_pg_net_responses() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.truncate_pg_net_responses() TO postgres;

COMMENT ON FUNCTION public.truncate_pg_net_responses() IS
  'TRUNCATE net._http_response and return the new heap size in bytes. Gives up after a 5 second lock wait. Does not touch net.http_request_queue.';

SELECT public.truncate_pg_net_responses();

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const truncateSql = await Deno.readTextFile(
  new URL("../../migrations/20261117170000_truncate_pg_net_responses.sql", import.meta.url),
);
const scheduleSql = await Deno.readTextFile(
  new URL("../../migrations/20261117170100_schedule_pg_net_response_truncate.sql", import.meta.url),
);

function statements(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

Deno.test("the truncate migration only clears the response heap", () => {
  const body = statements(truncateSql);
  assert(body.includes("TRUNCATE TABLE net._http_response"));
  assert(body.includes("lock_timeout', '5s'"));
  assert(body.includes("SELECT public.truncate_pg_net_responses()"));
  assertEquals(body.includes("TRUNCATE TABLE net.http_request_queue"), false);
  assertEquals(/\bVACUUM\b/i.test(body), false);
  assertEquals(/ALTER EXTENSION/i.test(body), false);
  assertEquals(/supabase_admin/i.test(body), false);
  assertEquals(/GRANT INSERT/i.test(body), false);
});

Deno.test("the daily truncate is outside the evening stall and does not call the network", () => {
  const body = statements(scheduleSql);
  assert(body.includes("'truncate-pg-net-responses'"));
  assert(body.includes("'0 15 * * *'"));
  assert(body.includes("SELECT public.truncate_pg_net_responses()"));
  assertEquals(/net\.http_/i.test(body), false);
  assertEquals(/\bGRANT\b/i.test(body), false);
});

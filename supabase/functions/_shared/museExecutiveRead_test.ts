import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readExecutiveResource } from "./museExecutiveRead.ts";

function reader(rows: Record<string, unknown>[] | { error: { code: string; message: string } }) {
  const queried: string[] = [];
  const db = {
    from(table: string) {
      queried.push(table);
      const api = {
        select() { return api; },
        limit() { return api; },
        order() { return api; },
        eq() { return api; },
        gte() { return api; },
        then(resolve: (value: unknown) => unknown) {
          const payload = Array.isArray(rows) ? { data: rows, error: null } : { data: null, error: rows.error };
          return Promise.resolve(payload).then(resolve);
        },
      };
      return api;
    },
  };
  return { db, queried };
}

Deno.test("unknown executive resources are rejected before a query", async () => {
  const { db, queried } = reader([]);
  const result = await readExecutiveResource(db as never, "drop_table", new URLSearchParams());
  assertEquals(result.status, 404);
  assertEquals(queried, []);
});

Deno.test("a truncated mission id is a 400 and is not sent to Postgres", async () => {
  const { db, queried } = reader([]);
  const result = await readExecutiveResource(
    db as never,
    "workboard",
    new URLSearchParams({ mission_id: "6f14b53d" }),
  );
  assertEquals(result.status, 400);
  assertEquals(result.body.error, "invalid_filter");
  assertEquals(queried, []);
});

Deno.test("workboard reads use the curated view and redact secret-like fields", async () => {
  const { db, queried } = reader([{ message: "posted", service_role: "hidden-value" }]);
  const result = await readExecutiveResource(db as never, "workboard", new URLSearchParams({ limit: "10" }));
  assertEquals(result.status, 200);
  assertEquals(queried, ["muse_work_feed"]);
  assertEquals(result.body.resource, "workboard");
  const rows = result.body.data as Record<string, unknown>[];
  assertEquals(rows[0].message, "posted");
  assertEquals(rows[0].service_role, "[redacted]");
});

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runControlCenterTool } from "./ccMcpTools.ts";
import type { BearerActor } from "./ccMcpOauth.ts";

const ACTOR: BearerActor = {
  actorKind: "control_center_mcp",
  actorLabel: "chatgpt",
  scope: "control_center",
  clientId: "cc-mcp-test",
};

const MISSION = "6f14b53d-4c16-49ec-a475-a1bf94229499";

function mockDb() {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const db = {
    from(table: string) {
      let inserted: Record<string, unknown> | null = null;
      const api = {
        insert(row: Record<string, unknown>) {
          inserted = row;
          inserts.push({ table, row });
          return api;
        },
        select() { return api; },
        update() { return api; },
        eq() { return api; },
        gte() { return api; },
        order() { return api; },
        limit() { return api; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        single() { return Promise.resolve({ data: { id: MISSION, ...(inserted ?? {}) }, error: null }); },
        then(resolve: (value: unknown) => unknown) {
          if (table === "muse_access_audit") {
            return Promise.resolve({ count: 0, error: null, data: null }).then(resolve);
          }
          if (table === "muse_mission_board") {
            return Promise.resolve({
              data: [{ title: "Launch", api_key: "should-not-leak" }],
              error: null,
            }).then(resolve);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return api;
    },
  };
  return { db, inserts };
}

Deno.test("post_comment goes through the workboard writer as a NOTE", async () => {
  const { db, inserts } = mockDb();
  const result = await runControlCenterTool("post_comment", {
    idempotency_key: "comment-key-1",
    message: "Ship the connector",
    mission_id: MISSION,
  }, db as never, ACTOR);
  assertEquals(result.status, 200);
  const post = inserts.find((row) => row.table === "muse_work_updates");
  assert(post);
  assertEquals(post?.row.update_type, "NOTE");
  assertEquals(post?.row.actor, "chatgpt");
  assertEquals(post?.row.message, "Ship the connector");
  assertEquals(post?.row.mission_id, MISSION);
  const body = result.body as { ok: boolean };
  assertEquals(body.ok, true);
});

Deno.test("post_status without a parent is rejected and writes nothing", async () => {
  const { db, inserts } = mockDb();
  const result = await runControlCenterTool("post_status", {
    idempotency_key: "status-key-1",
    message: "blocked",
  }, db as never, ACTOR);
  assertEquals(result.status, 400);
  assertEquals(inserts.some((row) => row.table === "muse_work_updates"), false);
});

Deno.test("read_missions uses the mission board and redacts secret fields", async () => {
  const { db } = mockDb();
  const result = await runControlCenterTool("read_missions", { limit: 5 }, db as never, ACTOR);
  assertEquals(result.status, 200);
  const body = result.body as { resource: string; data: Record<string, unknown>[] };
  assertEquals(body.resource, "missions");
  assertEquals(body.data[0].api_key, "[redacted]");
  assertEquals(body.data[0].title, "Launch");
});

Deno.test("ack_alerts uses the subscriber lookup and reports a missing subscriber", async () => {
  const { db, inserts } = mockDb();
  const result = await runControlCenterTool("ack_alerts", {
    items: [{ source_table: "muse_work_updates", source_id: MISSION }],
  }, db as never, ACTOR);
  assertEquals(result.status, 404);
  const body = result.body as { error: string };
  assertEquals(body.error, "subscriber_not_found");
  assertEquals(inserts.some((row) => row.table === "muse_alert_acks"), false);
});

Deno.test("unknown tools are rejected", async () => {
  const { db } = mockDb();
  const result = await runControlCenterTool("drop_table", {}, db as never, ACTOR);
  assertEquals(result.status, 404);
});

Deno.test("tool results scrub configured secret values", async () => {
  const { db } = mockDb();
  const secret = "muse-token-value-should-not-leak";
  const previous = Deno.env.get("MUSE_API_TOKEN");
  Deno.env.set("MUSE_API_TOKEN", secret);
  try {
    const result = await runControlCenterTool("post_comment", {
      idempotency_key: "comment-key-2",
      message: `leaked ${secret}`,
      mission_id: MISSION,
    }, db as never, ACTOR);
    assert(JSON.stringify(result.body).includes("[redacted]"));
    assert(!JSON.stringify(result.body).includes(secret));
  } finally {
    if (previous === undefined) Deno.env.delete("MUSE_API_TOKEN");
    else Deno.env.set("MUSE_API_TOKEN", previous);
  }
});

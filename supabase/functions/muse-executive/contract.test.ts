/**
 * Contract tests for the Muse executive read surface.
 * Run with: deno test supabase/functions/muse-executive/contract.test.ts
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  RESOURCES,
  redact,
  newestTimestamp,
  freshnessMinutes,
  rollUpStatus,
  parseSince,
  isUuidFilter,
  filterValueRejection,
  appliedFilterValue,
  classifyExecutiveReadError,
  UUID_COLUMNS,
  IG_SEND_QUEUE_RESOURCE,
  hubSendQueueRequest,
  igSendQueueEnvelope,
} from "./contract.ts";

Deno.test("resource map is a closed allowlist of muse_ views", () => {
  const specs = Object.values(RESOURCES);
  assert(specs.length >= 10, "expected the full executive surface");
  for (const spec of specs) {
    assert(spec.view.startsWith("muse_"), `${spec.resource} must read a curated muse_ view`);
    assert(spec.maxLimit >= spec.defaultLimit, `${spec.resource} limits are inverted`);
    assert(spec.authoritative_source.length > 0, `${spec.resource} must name its source`);
  }
});

Deno.test("resource keys and spec names agree", () => {
  for (const [key, spec] of Object.entries(RESOURCES)) {
    assertEquals(key, spec.resource);
  }
});

Deno.test("work feed filters by the parent ids updates are written against", () => {
  const filters = RESOURCES["work-feed"].filters ?? {};
  assertEquals(filters.domain, "domain_key");
  assertEquals(filters.actor, "actor");
  assertEquals(filters.type, "update_type");
  assertEquals(filters.task_id, "task_id");
  assertEquals(filters.improvement_id, "improvement_id");
  assertEquals(filters.mission_id, "mission_id");
  assertEquals(RESOURCES["work-feed"].sinceColumn, "created_at");
});

Deno.test("workboard and assignments are first-class reads of the live board", () => {
  const board = RESOURCES.workboard;
  assertEquals(board.view, "muse_work_feed");
  assertEquals(board.sinceColumn, "created_at");
  assertEquals(board.orderBy, { column: "created_at", ascending: false });
  assertEquals(board.filters?.mission_id, "mission_id");
  assertEquals(board.filters?.type, "update_type");

  const assignments = RESOURCES.assignments;
  assertEquals(assignments.view, "muse_workboard_assignments");
  assertEquals(assignments.sinceColumn, "created_at");
  assertEquals(assignments.filters?.mission_id, "mission_id");
  assert(assignments.defaultLimit <= assignments.maxLimit);
});

const MISSION = "6f14b53d-4c16-49ec-a475-a1bf94229499";

Deno.test("every id-shaped executive filter is a uuid column", () => {
  const found = new Set<string>();
  for (const spec of Object.values(RESOURCES)) {
    for (const [param, column] of Object.entries(spec.filters ?? {})) {
      const looksLikeId = param.endsWith("_id") || column.endsWith("_id");
      if (!looksLikeId) {
        assert(!isUuidFilter(param, column), `${spec.resource} ${param} is not an id filter`);
        continue;
      }
      assert(UUID_COLUMNS.has(column), `${spec.resource} column ${column} must be classified as uuid`);
      assert(isUuidFilter(param, column), `${spec.resource} ${param} must be validated as a uuid`);
      found.add(`${param}->${column}`);
    }
  }
  assertEquals([...found].sort(), [
    "improvement_id->improvement_id",
    "mission_id->mission_id",
    "task_id->task_id",
  ]);
});

Deno.test("a truncated mission id is a 400 invalid_filter before any query", () => {
  for (const param of ["mission_id", "task_id", "improvement_id"]) {
    const rejection = filterValueRejection(param, param, "6f14b53d");
    assertEquals(rejection, {
      error: "invalid_filter",
      field: param,
      message: `${param} must be a full 36-character UUID; omit it to list all`,
    });
  }
  assertEquals(filterValueRejection("mission_id", "mission_id", ""), {
    error: "invalid_filter",
    field: "mission_id",
    message: "mission_id must be a full 36-character UUID; omit it to list all",
  });
  assertEquals(
    filterValueRejection("mission_id", "mission_id", "6f14b53d4c1649eca475a1bf94229499"),
    {
      error: "invalid_filter",
      field: "mission_id",
      message: "mission_id must be a full 36-character UUID; omit it to list all",
    },
  );
  assertEquals(filterValueRejection("mission_id", "mission_id", `{${MISSION}}`), {
    error: "invalid_filter",
    field: "mission_id",
    message: "mission_id must be a full 36-character UUID; omit it to list all",
  });
});

Deno.test("a full 36-character uuid filter is accepted and a text filter is unchanged", () => {
  assertEquals(filterValueRejection("mission_id", "mission_id", `  ${MISSION}  `), null);
  assertEquals(filterValueRejection("mission_id", "mission_id", MISSION.toUpperCase()), null);
  assertEquals(appliedFilterValue("mission_id", "mission_id", `  ${MISSION}  `), MISSION);
  assertEquals(filterValueRejection("domain", "domain_key", "credit"), null);
  assertEquals(filterValueRejection("domain", "domain_key", "foo;drop"), {
    error: "invalid_filter",
    message: 'Filter "domain" contains unsupported characters.',
  });
  assertEquals(appliedFilterValue("actor", "actor", "  grok-bot  "), "grok-bot");
});

Deno.test("postgres 22P02 is a 400 invalid_filter and other read errors stay 503 with a short code", () => {
  const truncated = classifyExecutiveReadError(
    { code: "22P02", message: 'invalid input syntax for type uuid: "6f14b53d"' },
    { mission_id: "6f14b53d", type: "STATUS" },
    "workboard",
  );
  assertEquals(truncated.status, 400);
  assertEquals(truncated.body, {
    error: "invalid_filter",
    field: "mission_id",
    message: "mission_id must be a full 36-character UUID; omit it to list all",
  });
  assert(!JSON.stringify(truncated.body).includes("22P02"));
  assert(!JSON.stringify(truncated.body).includes("invalid input syntax"));

  const named = classifyExecutiveReadError(
    { code: "22p02", message: 'invalid input syntax for type uuid: "abc"' },
    { task_id: MISSION, improvement_id: "abc" },
    "work-feed",
  );
  assertEquals(named.status, 400);
  assertEquals(named.body.field, "improvement_id");

  const down = classifyExecutiveReadError(
    { code: "42P01", message: "relation secret.muse_work_feed does not exist" },
    {},
    "workboard",
  );
  assertEquals(down.status, 503);
  assertEquals(down.body, {
    error: "read_failed",
    code: "42P01",
    message: "The executive view could not be read.",
    resource: "workboard",
    hint: "If this persists, the Muse migration may not be applied to the live database yet.",
  });
  assert(!JSON.stringify(down.body).includes("secret.muse_work_feed"));

  const unnamed = classifyExecutiveReadError(
    { message: "connection refused to db.internal.example" },
    {},
    "brief",
  );
  assertEquals(unnamed.status, 503);
  assertEquals(unnamed.body.code, "unavailable");
  assert(!JSON.stringify(unnamed.body).includes("db.internal.example"));

  const postgrest = classifyExecutiveReadError({ code: "PGRST205", message: "schema cache leak" }, {}, "kpis");
  assertEquals(postgrest.status, 503);
  assertEquals(postgrest.body.code, "PGRST205");
  assert(!JSON.stringify(postgrest.body).includes("schema cache"));
});

Deno.test("since accepts a UTC day or timestamp and rejects operators", () => {
  assertEquals(parseSince(null), null);
  assertEquals(parseSince("2026-10-12"), "2026-10-12T00:00:00.000Z");
  assertEquals(parseSince("2026-10-12T01:22:30Z"), "2026-10-12T01:22:30.000Z");
  assertEquals(parseSince("  2026-10-12T01:22:30.480371Z  "), "2026-10-12T01:22:30.480Z");
  assertThrows(() => parseSince(""));
  assertThrows(() => parseSince("2026-02-31"));
  assertThrows(() => parseSince("2026-10-12T01:22:30+00:00"));
  assertThrows(() => parseSince("2026-10-12 or created_at.gt.1"));
});

Deno.test("daily reports are a first-class read resource", () => {
  const spec = RESOURCES["daily-reports"];
  assertEquals(spec.resource, "daily-reports");
  assertEquals(spec.view, "muse_daily_report_board");
  assertEquals(spec.filters?.actor, "actor");
  assertEquals(spec.filters?.cadence, "cadence");
  assertEquals(spec.filters?.report_date, "report_date");
});

Deno.test("redact strips credential-shaped fields, including nested", () => {
  const [out] = redact([{
    id: "1",
    title: "fine",
    token_sha256: "abc",
    service_role_key: "xyz",
    nested: { api_key: "leak", safe: "ok" },
  }]) as Record<string, any>[];

  assertEquals(out.title, "fine");
  assertEquals(out.token_sha256, "[redacted]");
  assertEquals(out.service_role_key, "[redacted]");
  assertEquals(out.nested.api_key, "[redacted]");
  assertEquals(out.nested.safe, "ok");
});

Deno.test("redact leaves non-object rows untouched", () => {
  assertEquals(redact(["plain"]), ["plain"]);
});

Deno.test("newestTimestamp picks the newest parseable value", () => {
  const rows = [
    { as_of: "2026-09-01T00:00:00.000Z" },
    { as_of: "2026-09-20T00:00:00.000Z" },
    { as_of: "not a date" },
    { as_of: null },
  ];
  assertEquals(newestTimestamp(rows, "as_of"), "2026-09-20T00:00:00.000Z");
  assertEquals(newestTimestamp(rows, null), null);
  assertEquals(newestTimestamp([{ other: "x" }], "as_of"), null);
});

Deno.test("freshness is reported in whole minutes and never negative", () => {
  const now = Date.parse("2026-09-25T12:00:00.000Z");
  assertEquals(freshnessMinutes("2026-09-25T11:30:00.000Z", now), 30);
  assertEquals(freshnessMinutes("2026-09-25T12:05:00.000Z", now), 0, "clock skew must not go negative");
  assertEquals(freshnessMinutes(null, now), null);
});

Deno.test("status roll-up takes the weakest row", () => {
  const strong = rollUpStatus([{ data_status: "KNOWN" }, { data_status: "KNOWN" }]);
  assertEquals(strong.status, "KNOWN");
  assertEquals(strong.confidence, "HIGH");
  assertEquals(strong.human_verification_required, false);

  const mixed = rollUpStatus([
    { data_status: "KNOWN" },
    { data_status: "SOURCE_EXISTS_ACCESS_NEEDED" },
  ]);
  assertEquals(mixed.status, "SOURCE_EXISTS_ACCESS_NEEDED");
  assertEquals(mixed.confidence, "LOW");
  assertEquals(mixed.human_verification_required, true);

  const needsCheck = rollUpStatus([{ data_status: "KNOWN" }, { data_status: "NEEDS_VERIFICATION" }]);
  assertEquals(needsCheck.status, "NEEDS_VERIFICATION");
  assertEquals(needsCheck.confidence, "MEDIUM");
});

Deno.test("an empty resource is NOT_MEASURED, never a healthy KNOWN", () => {
  const empty = rollUpStatus([]);
  assertEquals(empty.status, "NOT_MEASURED");
  assertEquals(empty.confidence, "LOW");
});

Deno.test("a row demanding human verification propagates even when KNOWN", () => {
  const r = rollUpStatus([{ data_status: "KNOWN", human_verification_required: true }]);
  assertEquals(r.status, "KNOWN");
  assertEquals(r.human_verification_required, true);
});

Deno.test("ig-send-queue: hub request carries the Muse secret in the header only and asks for the queue action", () => {
  const r = hubSendQueueRequest({ hubUrl: "https://vsemrziqxrrfcquxfnwd.supabase.co/", secret: "s3cret", limit: 9999 });
  assertEquals(r.url, "https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/control-center-api");
  assertEquals(r.init.headers["x-muse-ig-receipt-secret"], "s3cret");
  assertEquals(JSON.parse(r.init.body), { action: "list_ig_dm_send_queue", limit: 250 });
  assert(!r.init.body.includes("s3cret"));
  assertThrows(() => hubSendQueueRequest({ hubUrl: "http://plain.example", secret: "x" }));
  assertThrows(() => hubSendQueueRequest({ hubUrl: "https://ok.example", secret: " " }));
});

Deno.test("ig-send-queue: a hub 200 becomes a KNOWN envelope with the rows and the sender named", () => {
  const out = igSendQueueEnvelope(200, {
    ok: true, send_owner: "muse", receipt_action: "mark_manual_ig_dm_submitted", path: ["a", "b"],
    total_count: 2, sendable_count: 1,
    rows: [{ handoff_record_id: "r1", sendable: true, dm_body: "hi" }, { handoff_record_id: "r2", sendable: false, blockers: ["draft_pending"] }],
  }, "s3cret");
  assertEquals(out.status, 200);
  assertEquals(out.body.resource, IG_SEND_QUEUE_RESOURCE);
  assertEquals(out.body.status, "KNOWN");
  assertEquals(out.body.row_count, 2);
  assertEquals(out.body.sendable_count, 1);
  assertEquals(out.body.send_owner, "muse");
  assertEquals(out.body.human_verification_required, false);
});

Deno.test("ig-send-queue: a hub refusal is a 503 here, never an empty queue, and the secret is scrubbed", () => {
  const out = igSendQueueEnvelope(403, { error: "muse_ig_receipt may only call mark_manual_ig_dm_submitted (s3cret)" }, "s3cret");
  assertEquals(out.status, 503);
  assertEquals(out.body.error, "hub_unavailable");
  assertEquals(out.body.hub_status, 403);
  assert(!JSON.stringify(out.body).includes("s3cret"));
  const empty = igSendQueueEnvelope(200, { ok: true, rows: [] }, "");
  assertEquals(empty.status, 200);
  assertEquals(empty.body.row_count, 0);
  assert(String((empty.body.notes as string[])[0]).startsWith("No approved, unsent Instagram DMs"));
});

import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ACTIONS,
  isAction,
  boundedString,
  uuid,
  oneOf,
  reportDate,
  reportSections,
  REPORT_SECTION_KEYS,
  IG_DM_RECEIPT_BOARD_MISSION_ID,
  IG_DM_RECEIPT_REFUSED_PREFIX,
  receiptInputFrom,
  parseIgDmReceipt,
  hubReceiptBody,
  hubReceiptRequest,
  receiptOutcome,
  redactReceiptSecret,
  type IgDmReceipt,
} from "./contract.ts";

Deno.test("workboard action allowlist is closed", () => {
  assert(ACTIONS.includes("create_task"));
  assert(isAction("append_update"));
  assertEquals(isAction("arbitrary_sql"), false);
  assertEquals(isAction("register_subscriber"), false);
  assertEquals(isAction("dispatch"), false);
});

Deno.test("boundedString enforces required and maximum length", () => {
  assertEquals(boundedString("  hello  ", "x", 20, true), "hello");
  assertThrows(() => boundedString("", "x", 20, true));
  assertThrows(() => boundedString("12345", "x", 4));
});

Deno.test("uuid accepts valid ids and rejects arbitrary text", () => {
  const value = "123e4567-e89b-42d3-a456-426614174000";
  assertEquals(uuid(value, "id"), value);
  assertThrows(() => uuid("drop table muse", "id"));
});

Deno.test("oneOf rejects values outside the enum", () => {
  assertEquals(oneOf("P1", "priority", ["P0","P1","P2"]), "P1");
  assertThrows(() => oneOf("P9", "priority", ["P0","P1","P2"]));
});

Deno.test("record_daily_report is on the closed action list", () => {
  assert(isAction("record_daily_report"));
  assert(ACTIONS.includes("record_daily_report"));
});

Deno.test("report_date accepts a calendar date and rejects timestamps", () => {
  assertEquals(reportDate("2026-10-08"), "2026-10-08");
  assertThrows(() => reportDate("2026-10-08T13:38:00Z"));
  assertThrows(() => reportDate("2026-02-31"));
});

Deno.test("report sections accept only the seven end-of-day items", () => {
  assertEquals(REPORT_SECTION_KEYS, [
    "execution",
    "business_activity",
    "daily_improvement",
    "system_health",
    "blockers_decisions",
    "spend_commitments",
    "next_day",
  ]);
  assertEquals(reportSections(undefined), {});
  assertEquals(reportSections({ execution: "  shipped  ", next_day: "measure" }), {
    execution: "shipped",
    next_day: "measure",
  });
  assertThrows(() => reportSections({ mission_id: "6f14b53d-4c16-49ec-a475-a1bf94229499" }));
  assertThrows(() => reportSections(["execution"]));
});

const RECEIPT_FIELDS = {
  handoff_record_id: "6f14b53d-4c16-49ec-a475-a1bf94229499",
  reference: "ig-dm-thread-8841",
  notes: "Sent the approved DM from the operator account.",
  submitted_at: "2026-10-13T15:04:00.000Z",
};

const PITCH = "MUSE_IG_SEND_BRIEF part 5/5 (exact paste):\nHey, I made a record you might want.\nhttps://example.test/pitch";

function receipt(now = Date.parse("2026-10-13T16:00:00.000Z")): IgDmReceipt {
  return parseIgDmReceipt(RECEIPT_FIELDS, now);
}

Deno.test("record_ig_dm_receipt is on the closed action list", () => {
  assert(isAction("record_ig_dm_receipt"));
  assert(ACTIONS.includes("record_ig_dm_receipt"));
  assertEquals(isAction("mark_manual_ig_dm_submitted"), false);
  assertEquals(isAction("send_playlist_pitches"), false);
});

Deno.test("receipt fields come from payload and drop pitch copy", () => {
  const fromPayload = receiptInputFrom({
    action: "record_ig_dm_receipt",
    payload: { ...RECEIPT_FIELDS, pitch: PITCH, dm_body: PITCH },
  });
  const parsed = parseIgDmReceipt(fromPayload, Date.parse("2026-10-13T16:00:00.000Z"));
  assertEquals(hubReceiptBody(parsed), {
    action: "mark_manual_ig_dm_submitted",
    handoff_record_id: RECEIPT_FIELDS.handoff_record_id,
    evidence: {
      result: "submitted",
      reference: RECEIPT_FIELDS.reference,
      notes: RECEIPT_FIELDS.notes,
      submitted_at: "2026-10-13T15:04:00.000Z",
    },
  });
  assert(!JSON.stringify(hubReceiptBody(parsed)).includes("MUSE_IG_SEND_BRIEF"));
  assert(!JSON.stringify(hubReceiptBody(parsed)).includes("https://example.test/pitch"));

  const flat = receiptInputFrom({ action: "record_ig_dm_receipt", ...RECEIPT_FIELDS });
  assertEquals(parseIgDmReceipt(flat, Date.parse("2026-10-13T16:00:00.000Z")).reference, RECEIPT_FIELDS.reference);
});

Deno.test("notes refuse a pasted pitch and still accept an operator line", () => {
  const now = Date.parse("2026-10-13T16:00:00.000Z");
  assertEquals(receipt(now).notes, RECEIPT_FIELDS.notes);
  for (const notes of [
    PITCH,
    "exact paste of the DM",
    "ig_dm_draft follows",
    "Sent it. https://fanfuel.example/listen",
    "paragraph one\n\nparagraph two\n\nparagraph three",
    "pitch: the whole song writeup",
  ]) {
    assertThrows(
      () => parseIgDmReceipt({ ...RECEIPT_FIELDS, notes }, now),
      Error,
      "without pasting the pitch",
    );
  }
  assertThrows(() => parseIgDmReceipt({ ...RECEIPT_FIELDS, submitted_at: "2099-01-01T00:00:00.000Z" }, now));
  assertThrows(() => parseIgDmReceipt({ ...RECEIPT_FIELDS, submitted_at: "2026-10-13T15:04:00+00:00" }, now));
  assertThrows(() => parseIgDmReceipt({ ...RECEIPT_FIELDS, handoff_record_id: "drop table" }, now));
  assertThrows(
    () => parseIgDmReceipt({ ...RECEIPT_FIELDS, reference: "https://example.test/the-pitch" }, now),
    Error,
    "without pasting the pitch",
  );
});

Deno.test("hub request sends the receipt secret as a header and not in the body", () => {
  const secret = "muse-receipt-secret-value";
  const built = hubReceiptRequest({
    hubUrl: "https://hub.example.test/",
    secret,
    receipt: receipt(),
  });
  assertEquals(built.url, "https://hub.example.test/functions/v1/control-center-api");
  assertEquals(built.init.method, "POST");
  assertEquals(built.init.redirect, "error");
  assertEquals(built.init.headers["x-muse-ig-receipt-secret"], secret);
  assertEquals(built.init.headers["x-api-key"], undefined);
  assertEquals(built.init.headers["authorization"], undefined);
  assert(!built.init.body.includes(secret));
  assertEquals(JSON.parse(built.init.body).action, "mark_manual_ig_dm_submitted");
  assertThrows(() => hubReceiptRequest({ hubUrl: "http://hub.example.test", secret, receipt: receipt() }));
  assertThrows(() => hubReceiptRequest({
    hubUrl: "https://hub.example.test",
    secret,
    receipt: { ...receipt(), reference: `thread ${secret}` },
  }));
});

Deno.test("403 and 409 pass through and become board notices without the pitch", () => {
  const row = receipt();
  const secret = "muse-receipt-secret-value";
  const forbidden = receiptOutcome(403, {
    error: `muse_ig_receipt may only call mark_manual_ig_dm_submitted ${secret}`,
    code: "muse_ig_receipt_scope",
    x_muse_ig_receipt_secret: secret,
  }, row, secret);
  assertEquals(forbidden.status, 403);
  assertEquals(forbidden.body.error, "muse_ig_receipt may only call mark_manual_ig_dm_submitted [redacted]");
  assertEquals(forbidden.body.x_muse_ig_receipt_secret, "[redacted]");
  assertEquals(forbidden.board?.update_type, "BLOCKER");
  assertEquals(forbidden.board?.mission_id, IG_DM_RECEIPT_BOARD_MISSION_ID);
  assert(forbidden.board?.message.startsWith(IG_DM_RECEIPT_REFUSED_PREFIX));
  assert(forbidden.board?.message.includes("hub_status: 403"));
  assert(forbidden.board?.message.includes(`handoff_record_id: ${row.handoff_record_id}`));
  assert(!forbidden.board?.message.includes(row.notes));
  assert(!forbidden.board?.message.includes(secret));
  assert(!JSON.stringify(forbidden.body).includes(secret));

  const conflict = receiptOutcome(409, {
    error: "record state changed before submit stamp",
    code: "conflict",
  }, row, secret);
  assertEquals(conflict.status, 409);
  assertEquals(conflict.board?.update_type, "STATUS");
  assert(conflict.board?.message.includes("hub_status: 409"));
  assert(conflict.board?.message.includes("code: conflict"));
  assert(!conflict.board?.message.includes(row.notes));

  for (const status of [200, 401, 422, 500]) {
    const other = receiptOutcome(status, { ok: status === 200, error: row.notes }, row, secret);
    assertEquals(other.status, status);
    assertEquals(other.board, null);
  }

  const pitched = receiptOutcome(403, {
    error: PITCH,
    code: "muse_ig_receipt_scope",
  }, row, secret);
  assert(pitched.board?.message.includes("error: [omitted]"));
  assert(!pitched.board?.message.includes("Hey, I made a record"));
});

Deno.test("redactReceiptSecret strips the secret from nested hub text", () => {
  const secret = "muse-receipt-secret-value";
  assertEquals(redactReceiptSecret({ nested: { note: `keep ${secret} out` } }, secret), {
    nested: { note: "keep [redacted] out" },
  });
});

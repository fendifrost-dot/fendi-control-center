import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ACTIONS, isAction, boundedString, uuid, oneOf, reportDate, reportSections, REPORT_SECTION_KEYS } from "./contract.ts";

Deno.test("workboard action allowlist is closed", () => {
  assert(ACTIONS.includes("create_task"));
  assert(isAction("append_update"));
  assertEquals(isAction("arbitrary_sql"), false);
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

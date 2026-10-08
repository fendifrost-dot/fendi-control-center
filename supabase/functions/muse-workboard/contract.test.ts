import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ACTIONS, isAction, boundedString, uuid, oneOf } from "./contract.ts";

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

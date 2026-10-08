/**
 * Contract tests for the Muse executive read surface.
 * Run with: deno test supabase/functions/muse-executive/contract.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  RESOURCES,
  redact,
  newestTimestamp,
  freshnessMinutes,
  rollUpStatus,
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

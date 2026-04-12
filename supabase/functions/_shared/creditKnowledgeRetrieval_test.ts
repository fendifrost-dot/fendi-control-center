/**
 * K/L/M validation for credit knowledge retrieval composition and anchor TTL.
 *
 * Run: npm run test:deno
 * Or: deno test supabase/functions/_shared/creditKnowledgeRetrieval_test.ts --allow-env
 */

import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  getCachedAnchor,
  getKbAnchorEntryTsForTest,
  KB_ANCHOR_TTL_MS,
  reorderWithMinViolations,
  resetKbAnchorCachesForTest,
  seedKbAnchorCacheForTest,
  shouldForceTier1,
} from "./creditKnowledgeRetrieval.ts";

Deno.test("K: anchor TTL touch-on-read refreshes ts; stale entries expire when idle", () => {
  resetKbAnchorCachesForTest();
  const primary = "late_payment";
  seedKbAnchorCacheForTest(primary, "cached kb line", KB_ANCHOR_TTL_MS - 60_000);
  const beforeTs = getKbAnchorEntryTsForTest(primary)!;
  assertEquals(getCachedAnchor(primary), "cached kb line");
  const afterTs = getKbAnchorEntryTsForTest(primary)!;
  assert(afterTs > beforeTs, "touch-on-read should refresh ts");

  resetKbAnchorCachesForTest();
  seedKbAnchorCacheForTest(primary, "expired", KB_ANCHOR_TTL_MS + 1_000);
  assertEquals(getCachedAnchor(primary), null);
});

Deno.test("L: empty violation slice still takes strongest violation when pool non-empty", () => {
  const weak = "Past due notation may be inaccurate.";
  const patterns = Array.from({ length: 6 }, (_, i) => `pattern filler ${i}`);
  const out = reorderWithMinViolations(
    {
      violationLogic: [weak],
      analysisPatterns: patterns,
      disputeExamples: [],
    },
    0,
    {},
  );
  assertEquals(out.violationLogic.length >= 1, true);
  assertEquals(out.violationLogic[0], weak);
});

Deno.test("M: analysis-only tier-1 bias uses confidence < 0.6; dispute path keeps 0.7 threshold", () => {
  assertEquals(shouldForceTier1(undefined, null, true), true);
  assertEquals(shouldForceTier1(undefined, 0.5, true), true);
  assertEquals(shouldForceTier1(undefined, 0.65, true), false);
  assertEquals(shouldForceTier1(undefined, 0.65, false), true);
  assertEquals(shouldForceTier1(undefined, 0.75, false), false);
});

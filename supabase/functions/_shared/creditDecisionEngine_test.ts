/**
 * Explicit Credit Guardian ingest routing — deterministic intent + extraction.
 * Run: deno test supabase/functions/_shared/creditDecisionEngine_test.ts --allow-env
 */
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  extractCreditGuardianClientNameForIngest,
  inferCreditWorkflowKey,
  isExplicitCreditGuardianIngestIntent,
  shouldAutoExecuteCreditIntent,
} from "./creditDecisionEngine.ts";

const L = (s: string) => s.toLowerCase();

Deno.test("explicit CG: operator phrases are explicit ingest intent", () => {
  for (const msg of [
    "Add Jabril to Credit Guardian",
    "Put Jabril in Credit Guardian",
    "Sync Jabril to Credit Guardian",
    "Onboard Jabril into CG",
    "Ingest Jabril into Credit Guardian",
    "Register Jabril in credit guardian",
    "Load Jabril into Credit Guardian",
    "Bring Jabril into Credit Guardian",
    "Import Jabril into Credit Guardian",
  ]) {
    assertEquals(isExplicitCreditGuardianIngestIntent(L(msg)), true, msg);
    const d = inferCreditWorkflowKey(L(msg));
    assertEquals(d.workflowKey, "drive_ingest");
    assertEquals(d.confidence, 1);
    assertEquals(shouldAutoExecuteCreditIntent(L(msg)), true);
  }
});

Deno.test("explicit CG: negation is not explicit intent", () => {
  const msg = "don't add Jabril to Credit Guardian";
  assertEquals(isExplicitCreditGuardianIngestIntent(L(msg)), false);
});

Deno.test("explicit CG: hijack — existing/new client wording still resolves to drive_ingest", () => {
  const msg =
    "existing client new equifax report add Jabril to Credit Guardian for sync";
  assertEquals(isExplicitCreditGuardianIngestIntent(L(msg)), true);
  const d = inferCreditWorkflowKey(L(msg));
  assertEquals(d.workflowKey, "drive_ingest");
  assertEquals(d.confidence, 1);
});

Deno.test("explicit CG: low generic credit confidence text still auto-executes when explicit", () => {
  const msg = "add totallyunknownclient to credit guardian";
  assertEquals(shouldAutoExecuteCreditIntent(L(msg)), true);
});

Deno.test("extractCreditGuardianClientNameForIngest: Jabril variants", () => {
  assertEquals(extractCreditGuardianClientNameForIngest("Add Jabril to Credit Guardian"), "Jabril");
  assertEquals(extractCreditGuardianClientNameForIngest("Put Jabril in Credit Guardian"), "Jabril");
  assertEquals(extractCreditGuardianClientNameForIngest("Onboard Jabril into CG"), "Jabril");
});

Deno.test("extractCreditGuardianClientNameForIngest: noisy phrasing, punctuation, titles, quotes", () => {
  assertEquals(
    extractCreditGuardianClientNameForIngest(`Please, add "Mary Jane Watson" to Credit Guardian!`),
    "Mary Jane Watson",
  );
  assertEquals(
    extractCreditGuardianClientNameForIngest(`Add Dr. Jabril to Credit Guardian`),
    "Jabril",
  );
  assertEquals(
    extractCreditGuardianClientNameForIngest(`Add 'ACME/LLC' to credit guardian`),
    "ACME/LLC",
  );
  assertEquals(
    extractCreditGuardianClientNameForIngest(`Sync Smith-Jones to CG`),
    "Smith-Jones",
  );
});

Deno.test("extractCreditGuardianClientNameForIngest: ambiguous multi-word", () => {
  assertEquals(
    extractCreditGuardianClientNameForIngest(`Add North Star Client LLC to Credit Guardian`),
    "North Star Client LLC",
  );
});

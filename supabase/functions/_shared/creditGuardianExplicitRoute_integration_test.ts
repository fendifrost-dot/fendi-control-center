/**
 * Integration-style routing: explicit Credit Guardian phrase → Lane 1 drive_ingest,
 * not NL / not Lane 2 / deterministic explicit flag; zero-match structured outcome.
 */
import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { extractCreditGuardianClientNameForIngest } from "./creditDecisionEngine.ts";
import { resolveDriveIngestFilterKey } from "./driveClientAlias.ts";
import { resolveExplicitIngestStructuredOutcome } from "./explicitCgIngestOutcome.ts";
import { getExplicitCreditGuardianTelegramRouting } from "./creditGuardianTelegramRouting.ts";

Deno.test("integration: Add Jabril to Credit Guardian → drive_ingest, skip NL/autonomous/Lane2, extraction + zero-match outcome", () => {
  const text = "Add Jabril to Credit Guardian";
  const r = getExplicitCreditGuardianTelegramRouting(text, true);

  assertEquals(r.explicitCreditGuardianIngestIntent, true);
  assertEquals(r.autoPromoteDriveIngest, true);
  assertEquals(r.selectedWorkflow, "drive_ingest");
  assertEquals(r.useExplicitCreditGuardianIngestFlag, true);
  assertEquals(r.skipsNlClassification, true);
  assertEquals(r.skipsAutonomousForExplicit, true);
  assertEquals(r.exitsBeforeLane2Assistant, true);
  assertEquals(r.precheckFinalOutcome, null);

  assertEquals(extractCreditGuardianClientNameForIngest(text), "Jabril");

  const zeroRaw = JSON.stringify({
    total_clients: 0,
    hint: "test",
    ingest_diagnostics: { folder_names_sample: ["Zeus", "Jabril Holdings"] },
  });
  const out = resolveExplicitIngestStructuredOutcome(zeroRaw, "jabril");
  assertEquals(out.final_outcome, "executed_zero_match");
  assertEquals(out.ingest_result_count, 0);
});

Deno.test("integration: explicit CG + drive_ingest not implemented → blocked_unimplemented", () => {
  const r = getExplicitCreditGuardianTelegramRouting("Add Jabril to Credit Guardian", false);
  assertEquals(r.precheckFinalOutcome, "blocked_unimplemented");
  assertEquals(r.autoPromoteDriveIngest, false);
});

Deno.test("integration: alias jabril→Zeus resolves; ingest success is not zero-match", () => {
  const envKey = "DRIVE_CLIENT_FOLDER_ALIASES_JSON";
  const prev = Deno.env.get(envKey);
  Deno.env.set(envKey, JSON.stringify({ jabril: "Zeus" }));
  try {
    const alias = resolveDriveIngestFilterKey("Jabril");
    assertEquals(alias.usedAlias, true);
    assertEquals(alias.key, "zeus");

    const successRaw = JSON.stringify({
      total_clients: 1,
      total_errors: 0,
      total_files_processed: 2,
      total_events_extracted: 1,
      total_events_pushed: 1,
      clients: [{
        client: "Zeus",
        files_processed: 2,
        events_extracted: 1,
        events_pushed: 1,
        errors: [],
      }],
      ingest_diagnostics: {
        filter_client_name: "zeus",
        dedicated_credit_root: true,
        subfolders_total: 4,
        drive_folder_id_suffix: "…testid",
      },
    });
    const out = resolveExplicitIngestStructuredOutcome(successRaw, "zeus", {
      operatorRequestedName: "Jabril",
      resolvedFolderKey: "zeus",
      usedAlias: true,
    });
    assertEquals(out.final_outcome, "executed_success");
    assert(out.operatorMessage.includes("Alias mapping applied:* yes"));
    assertEquals(out.ingest_result_count, 1);
  } finally {
    if (prev === undefined) Deno.env.delete(envKey);
    else Deno.env.set(envKey, prev);
  }
});

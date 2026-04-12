/**
 * Regression guards for deterministic Telegram markdown (explicit CG ingest).
 */
import { assert } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { resolveExplicitIngestStructuredOutcome } from "./explicitCgIngestOutcome.ts";

Deno.test("structured Telegram output: failure modes keep stable headings", () => {
  const toolErr = resolveExplicitIngestStructuredOutcome(
    "❌ Error executing ingest_drive_clients: timeout",
    "x",
  );
  assert(toolErr.operatorMessage.includes("*Credit Guardian ingest — tool execution failed*"));

  const malformed = resolveExplicitIngestStructuredOutcome("{{{", "x");
  assert(malformed.operatorMessage.includes("*Credit Guardian ingest — malformed response*"));

  const zero = resolveExplicitIngestStructuredOutcome(
    JSON.stringify({
      total_clients: 0,
      hint: "h",
      ingest_diagnostics: { folder_names_sample: ["A"] },
    }),
    "nomatch",
  );
  assert(zero.operatorMessage.includes("*Credit Guardian — Drive ingest (zero matching work)*"));
  assert(zero.operatorMessage.includes("*Client folders processed:* 0"));
});

Deno.test("structured Telegram output: success keeps stable headings and metrics lines", () => {
  const raw = JSON.stringify({
    total_clients: 1,
    total_errors: 0,
    total_files_processed: 4,
    total_events_extracted: 2,
    total_events_pushed: 2,
    clients: [{ client: "Zeus", files_processed: 4, events_extracted: 2, events_pushed: 2, errors: [] }],
    ingest_diagnostics: {
      dedicated_credit_root: true,
      subfolders_total: 3,
      drive_folder_id_suffix: "…suffix",
      filter_client_name: "zeus",
    },
  });
  const s = resolveExplicitIngestStructuredOutcome(raw, "zeus", {
    operatorRequestedName: "Jabril",
    resolvedFolderKey: "zeus",
    usedAlias: true,
  });
  assert(s.operatorMessage.includes("*Credit Guardian ingest — success*"));
  assert(s.operatorMessage.includes("*Operator request (name):* Jabril"));
  assert(s.operatorMessage.includes("*Alias mapping applied:* yes"));
  assert(s.operatorMessage.includes("*Client folders imported:* 1"));
  assert(s.operatorMessage.includes("*Files processed (total):* 4"));
  assert(s.operatorMessage.includes("*Matched Drive folders:*"));
  assert(s.operatorMessage.includes("*Zeus*"));
});

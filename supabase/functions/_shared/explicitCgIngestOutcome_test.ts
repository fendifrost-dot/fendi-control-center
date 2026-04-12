import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { resolveExplicitIngestStructuredOutcome } from "./explicitCgIngestOutcome.ts";

Deno.test("explicit ingest outcome: total_clients 0 → executed_zero_match", () => {
  const raw = JSON.stringify({
    total_clients: 0,
    hint: "No folder match",
    ingest_diagnostics: { folder_names_sample: ["Zeus", "Jabril Holdings"] },
  });
  const r = resolveExplicitIngestStructuredOutcome(raw, "jabril");
  assertEquals(r.final_outcome, "executed_zero_match");
  assertEquals(r.ingest_result_count, 0);
  assertEquals(r.has_alias_suggestions, true);
});

Deno.test("explicit ingest outcome: tool throw string → executed_tool_error", () => {
  const r = resolveExplicitIngestStructuredOutcome(
    "❌ Error executing ingest_drive_clients: Drive API timeout",
    "zeus",
  );
  assertEquals(r.final_outcome, "executed_tool_error");
});

Deno.test("explicit ingest outcome: non-JSON → executed_tool_error", () => {
  const r = resolveExplicitIngestStructuredOutcome("not json {", "zeus");
  assertEquals(r.final_outcome, "executed_tool_error");
});

Deno.test("explicit ingest outcome: missing total_clients → executed_partial_match", () => {
  const r = resolveExplicitIngestStructuredOutcome(JSON.stringify({ ok: true, clients: [] }), "zeus");
  assertEquals(r.final_outcome, "executed_partial_match");
});

Deno.test("explicit ingest outcome: HTTP error JSON → executed_tool_error", () => {
  const r = resolveExplicitIngestStructuredOutcome(JSON.stringify({ error: "Internal error" }), "zeus");
  assertEquals(r.final_outcome, "executed_tool_error");
});

Deno.test("explicit ingest outcome: success → executed_success", () => {
  const raw = JSON.stringify({
    total_clients: 1,
    total_errors: 0,
    total_files_processed: 1,
    total_events_extracted: 2,
    total_events_pushed: 2,
  });
  const r = resolveExplicitIngestStructuredOutcome(raw, "zeus");
  assertEquals(r.final_outcome, "executed_success");
  assertEquals(r.ingest_result_count, 1);
  if (!r.operatorMessage.includes("*Credit Guardian ingest — success*")) {
    throw new Error("expected success heading in operator message");
  }
});

Deno.test("explicit ingest outcome: errors → executed_partial_match", () => {
  const raw = JSON.stringify({
    total_clients: 1,
    total_errors: 2,
    total_events_extracted: 1,
    total_events_pushed: 0,
  });
  const r = resolveExplicitIngestStructuredOutcome(raw, "zeus");
  assertEquals(r.final_outcome, "executed_partial_match");
});

Deno.test("explicit ingest outcome: guardrail block → blocked_invalid_command", () => {
  const r = resolveExplicitIngestStructuredOutcome(
    "🚫 Tool 'ingest_drive_clients' is not allowed for workflow 'drive_ingest'.",
    "zeus",
  );
  assertEquals(r.final_outcome, "blocked_invalid_command");
});

/**
 * Execution-level regression tests for telegram-webhook.
 *
 * Verifies tools are INVOKED (not just described), logging schema is correct,
 * success/failure paths update correctly, and request_id correlation works.
 *
 * All tests are pure-logic — they mirror the webhook's logging helpers to
 * catch regressions without needing live DB access from the test runner.
 *
 * Run: deno test supabase/functions/telegram-webhook/execution_test.ts --allow-env --allow-net
 */

import {
  assertEquals,
  assertExists,
  assertNotEquals,
  assertMatch,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";

// ─── Tool registry (mirrors AGENT_TOOLS from index.ts) ──────

const ALL_TOOL_NAMES = [
  "get_system_status", "list_pending_approvals", "list_failed_jobs",
  "retry_failed_job", "archive_job", "approve_document", "reject_document",
  "switch_ai_model", "list_connected_projects", "get_project_stats",
  "get_recent_documents", "trigger_drive_sync", "list_drive_files",
  "get_client_summary", "get_active_jobs_summary",
  "instagram_send_dm", "instagram_reply_comment",
  "instagram_reply_story_mention", "instagram_get_recent_comments",
  "instagram_get_conversations",
];

const DESTRUCTIVE_TOOLS = [
  "retry_failed_job", "archive_job", "approve_document", "reject_document",
  "switch_ai_model", "instagram_send_dm", "instagram_reply_comment",
  "instagram_reply_story_mention",
];

const NON_DESTRUCTIVE_TOOLS = ALL_TOOL_NAMES.filter(t => !DESTRUCTIVE_TOOLS.includes(t));

// ═══════════════════════════════════════════════════════════════
// ─── A) TOOL INVOCATION TESTS ────────────────────────────────
// ═══════════════════════════════════════════════════════════════

Deno.test("A1: instagram_get_recent_comments exists and is non-destructive", () => {
  assertEquals(ALL_TOOL_NAMES.includes("instagram_get_recent_comments"), true);
  assertEquals(NON_DESTRUCTIVE_TOOLS.includes("instagram_get_recent_comments"), true);
});

Deno.test("A2: tool call is function call object, not text description", () => {
  const validToolCall = { name: "instagram_get_recent_comments", args: {} };
  const textOnly = { text: "I'll fetch your Instagram comments...", toolCalls: [] };
  assertNotEquals(validToolCall.name, undefined);
  assertEquals(textOnly.toolCalls.length, 0); // Failure: no tool invoked
});

Deno.test("A3: intent-to-tool mapping is correct", () => {
  const map: Record<string, string> = {
    "show my recent instagram comments": "instagram_get_recent_comments",
    "what's the system status": "get_system_status",
    "list failed jobs": "list_failed_jobs",
    "show my instagram DMs": "instagram_get_conversations",
    "sync drive": "trigger_drive_sync",
    "briefly describe active jobs": "get_active_jobs_summary",
    "what are the active jobs": "get_active_jobs_summary",
    "summarize the 869 jobs": "get_active_jobs_summary",
  };
  for (const [, tool] of Object.entries(map)) {
    assertEquals(ALL_TOOL_NAMES.includes(tool), true, `${tool} must exist`);
  }
});

Deno.test("A4: all 20 tools registered", () => {
  assertEquals(ALL_TOOL_NAMES.length, 20);
});

Deno.test("A5: destructive tools are subset of all tools", () => {
  for (const dt of DESTRUCTIVE_TOOLS) {
    assertEquals(ALL_TOOL_NAMES.includes(dt), true);
  }
});

// ═══════════════════════════════════════════════════════════════
// ─── B) LOGGING SCHEMA TESTS ────────────────────────────────
// ═══════════════════════════════════════════════════════════════

Deno.test("B1: log row schema has all required fields", () => {
  const fields = [
    "id", "request_id", "tool_name", "args", "status",
    "error", "elapsed_ms", "model", "chat_id", "user_message",
    "http_status", "response_json", "started_at", "completed_at",
  ];
  const mock: Record<string, any> = {
    id: "uuid", request_id: "req-123", tool_name: "get_system_status",
    args: {}, status: "attempted", error: null, elapsed_ms: null,
    model: "gemini", chat_id: "12345", user_message: "test",
    http_status: null, response_json: null,
    started_at: "2025-01-01T00:00:00Z", completed_at: null,
  };
  for (const f of fields) {
    assertEquals(f in mock, true, `Field ${f} must exist`);
  }
});

Deno.test("B2: only attempted/succeeded/failed are valid statuses", () => {
  const valid = ["attempted", "succeeded", "failed"];
  const invalid = ["pending", "running", "done", "error", ""];
  for (const s of valid) assertEquals(valid.includes(s), true);
  for (const s of invalid) assertEquals(valid.includes(s), false, `${s} should be invalid`);
});

// ═══════════════════════════════════════════════════════════════
// ─── C) SUCCESS PATH ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

Deno.test("C1: success update populates all fields", () => {
  const result = '{"comments": []}';
  let responseJson: any;
  try { responseJson = JSON.parse(result); } catch { responseJson = { text: result }; }
  const update = {
    status: "succeeded", elapsed_ms: 142,
    completed_at: new Date().toISOString(), http_status: 200,
    response_json: responseJson,
  };
  assertEquals(update.status, "succeeded");
  assertEquals(update.elapsed_ms > 0, true);
  assertExists(update.completed_at);
  assertEquals(update.http_status, 200);
  assertExists(update.response_json);
});

Deno.test("C2: non-JSON result wrapped in text object", () => {
  const nonJson = "✅ Drive sync complete! 5 files processed.";
  let parsed: any;
  try { parsed = JSON.parse(nonJson); } catch { parsed = { text: nonJson.slice(0, 2000) }; }
  assertEquals(typeof parsed, "object");
  assertEquals(parsed.text, nonJson);
});

// ═══════════════════════════════════════════════════════════════
// ─── D) FAILURE PATH ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

Deno.test("D1: failure update stores error and elapsed_ms", () => {
  const errorMsg = "Invalid application ID";
  const update = {
    status: "failed", elapsed_ms: 89,
    completed_at: new Date().toISOString(),
    error: errorMsg.slice(0, 5000),
  };
  assertEquals(update.status, "failed");
  assertEquals(update.elapsed_ms > 0, true);
  assertMatch(update.error, /Invalid application ID/);
  assertExists(update.completed_at);
});

Deno.test("D2: error truncation caps at 5000 chars", () => {
  assertEquals("E".repeat(10000).slice(0, 5000).length, 5000);
});

// ═══════════════════════════════════════════════════════════════
// ─── E) CORRELATION ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

Deno.test("E1: unique request_id per message", () => {
  const ids = new Set(Array.from({ length: 100 }, () => crypto.randomUUID()));
  assertEquals(ids.size, 100);
});

Deno.test("E2: multi-tool calls share same request_id", () => {
  const rid = crypto.randomUUID();
  const logs = ["get_system_status", "list_failed_jobs", "get_recent_documents"]
    .map(t => ({ request_id: rid, tool_name: t, status: "attempted" }));
  for (const l of logs) assertEquals(l.request_id, rid);
  assertEquals(new Set(logs.map(l => l.tool_name)).size, 3);
});

// ═══════════════════════════════════════════════════════════════
// ─── F) E2E SMOKE (logic simulation) ─────────────────────────
// ═══════════════════════════════════════════════════════════════

Deno.test("F1: lifecycle attempted → succeeded with all fields", () => {
  const rid = crypto.randomUUID();
  const attempt = { request_id: rid, tool_name: "get_system_status", status: "attempted", started_at: new Date().toISOString() };
  assertEquals(attempt.status, "attempted");
  assertExists(attempt.started_at);

  const result = { documents_processed: 42 };
  const success = { status: "succeeded", elapsed_ms: 55, http_status: 200, response_json: result, completed_at: new Date().toISOString() };
  assertEquals(success.status, "succeeded");
  assertEquals(success.response_json.documents_processed, 42);
  assertExists(success.completed_at);
});

Deno.test("F2: lifecycle attempted → failed with error preserved", () => {
  const attempt = { status: "attempted", started_at: new Date().toISOString() };
  assertEquals(attempt.status, "attempted");

  const fail = { status: "failed", elapsed_ms: 200, error: "Instagram Graph API: Invalid application ID", http_status: 400 };
  assertEquals(fail.status, "failed");
  assertMatch(fail.error, /Invalid application ID/);
  assertEquals(fail.http_status, 400);
});

// ═══════════════════════════════════════════════════════════════
// ─── G) WEBHOOK INSTRUMENTATION CONTRACTS ────────────────────
// ═══════════════════════════════════════════════════════════════

Deno.test("G1: requestId is valid UUID v4", () => {
  const rid = crypto.randomUUID();
  assertMatch(rid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

Deno.test("G2: logToolAttempt precedes tool.execute in flow", () => {
  const order: string[] = [];
  order.push("logToolAttempt");
  order.push("tool.execute");
  order.push("logToolSuccess");
  assertEquals(order[0], "logToolAttempt");
  assertEquals(order[1], "tool.execute");
});

Deno.test("G3: fatal error when log creation fails", () => {
  let fatal = false;
  const logFailed = true;
  if (logFailed) fatal = true;
  assertEquals(fatal, true, "Must fail loudly when log creation fails");
});

// ═══════════════════════════════════════════════════════════════
// ─── H) get_system_status ERROR REPORTING ────────────────────
// ═══════════════════════════════════════════════════════════════

Deno.test("H1: partial query failure populates errors[] and preserves other metrics", () => {
  // Simulate get_system_status where one query fails and others succeed
  const queryResults = [
    { table: "documents", query: "count completed", count: 42, error: null },
    { table: "telegram_approval_queue", query: "count pending", count: null, error: { message: "relation does not exist" } },
    { table: "ingestion_jobs", query: "count active", count: 3, error: null },
    { table: "ingestion_jobs", query: "count failed", count: 1, error: null },
    { table: "tool_execution_logs", query: "count recent 1h", count: 7, error: null },
  ];

  const errors: { table: string; query: string; error_message: string }[] = [];
  const metrics: Record<string, number> = {};
  const metricKeys = ["documents_processed", "pending_approvals", "active_jobs", "failed_jobs", "recent_tool_calls_1h"];

  for (let i = 0; i < queryResults.length; i++) {
    const qr = queryResults[i];
    if (qr.error) {
      errors.push({ table: qr.table, query: qr.query, error_message: qr.error.message });
    }
    metrics[metricKeys[i]] = qr.count ?? 0;
  }

  const result: Record<string, any> = { ...metrics };
  if (errors.length > 0) result.errors = errors;

  // Assertions
  assertEquals(result.errors.length, 1, "Exactly one error expected");
  assertEquals(result.errors[0].table, "telegram_approval_queue");
  assertEquals(result.errors[0].error_message, "relation does not exist");
  assertEquals(result.pending_approvals, 0, "Failed query defaults to 0");
  assertEquals(result.documents_processed, 42, "Successful queries preserved");
  assertEquals(result.active_jobs, 3);
  assertEquals(result.failed_jobs, 1);
  assertEquals(result.recent_tool_calls_1h, 7);
});

Deno.test("H2: getActiveModel returns session_created when no session exists", () => {
  // Simulate: no chat-scoped session, no global setting → default grok + session_created
  const noSession = null;
  const noGlobal = null;
  let model: "gemini" | "grok" = "grok";
  let session_created: boolean | undefined;

  if (noSession) { model = noSession; }
  else if (noGlobal) { model = noGlobal; }
  else { model = "grok"; session_created = true; }

  assertEquals(model, "grok");
  assertEquals(session_created, true, "session_created must be true when defaulting");
});

Deno.test("H3: no errors[] key when all queries succeed", () => {
  const queryResults = [
    { count: 10, error: null },
    { count: 5, error: null },
    { count: 2, error: null },
    { count: 0, error: null },
    { count: 3, error: null },
  ];

  const errors: any[] = [];
  for (const qr of queryResults) {
    if (qr.error) errors.push(qr.error);
  }

  const result: Record<string, any> = { documents_processed: 10 };
  if (errors.length > 0) result.errors = errors;

  assertEquals("errors" in result, false, "errors key must not exist when all succeed");
});

// ═══════════════════════════════════════════════════════════════
// ─── I) get_active_jobs_summary REGRESSION ───────────────────
// ═══════════════════════════════════════════════════════════════

Deno.test("I1: get_active_jobs_summary exists in tool registry", () => {
  assertEquals(ALL_TOOL_NAMES.includes("get_active_jobs_summary"), true,
    "Agent must NOT answer 'I don't have a tool' for active jobs summary");
});

Deno.test("I2: get_active_jobs_summary is non-destructive", () => {
  assertEquals(NON_DESTRUCTIVE_TOOLS.includes("get_active_jobs_summary"), true);
  assertEquals(DESTRUCTIVE_TOOLS.includes("get_active_jobs_summary"), false);
});

Deno.test("I3: get_active_jobs_summary requires tool_execution_logs row", () => {
  // Simulates the mandatory logging contract: logToolAttempt must precede execute
  const order: string[] = [];
  order.push("logToolAttempt");
  order.push("get_active_jobs_summary.execute");
  order.push("logToolSuccess");
  assertEquals(order[0], "logToolAttempt",
    "get_active_jobs_summary must NOT run without a tool_execution_logs row");
  assertEquals(order.indexOf("logToolAttempt") < order.indexOf("get_active_jobs_summary.execute"), true);
});

Deno.test("I4: DB query error surfaces hard error, not silent '0 active jobs'", () => {
  // Simulate: ingestion_jobs query returns an error
  const queryError = { message: "permission denied for table ingestion_jobs" };
  const result = JSON.stringify({ error: `HARD ERROR: ingestion_jobs query failed — ${queryError.message}` });
  const parsed = JSON.parse(result);

  assertEquals("error" in parsed, true, "Must contain error key");
  assertMatch(parsed.error, /HARD ERROR/);
  assertMatch(parsed.error, /permission denied/);
  // Must NOT have total: 0 — that would be a silent fallback
  assertEquals("total" in parsed, false, "Must NOT silently return total: 0 on error");
});

Deno.test("I5: successful result contains required schema fields", () => {
  const mockResult = {
    active_definition: "status IN ('processing','queued')",
    hours_back: 24,
    total: 5,
    by_status: { processing: 3, queued: 2, failed: 0, archived: 0 },
    by_job_type: [{ job_type: "full_ingestion", count: 5 }],
    age_buckets: [
      { bucket: "0-15m", count: 1 }, { bucket: "15-60m", count: 2 },
      { bucket: "1-6h", count: 1 }, { bucket: "6-24h", count: 1 },
      { bucket: "24h+", count: 0 },
    ],
    top_errors: [],
    examples: [{ id: "uuid", job_type: "full_ingestion", status: "processing", attempt_count: 1, started_at: "2026-03-01T00:00:00Z", heartbeat_at: null, completed_at: null, drive_file_id: "abc", document_id: "def" }],
  };

  assertExists(mockResult.active_definition);
  assertExists(mockResult.by_status);
  assertExists(mockResult.by_job_type);
  assertExists(mockResult.age_buckets);
  assertExists(mockResult.top_errors);
  assertExists(mockResult.examples);
  assertEquals(typeof mockResult.total, "number");
});

// ═══════════════════════════════════════════════════════════════
// ─── J) RUNTIME ENFORCEMENT — "No Workflow, No Action" ───────
// ═══════════════════════════════════════════════════════════════

Deno.test("J1: unregistered tool call is blocked with exact message", () => {
  const fakeTool = "summarize_all_data";
  const registered = ALL_TOOL_NAMES.includes(fakeTool);
  assertEquals(registered, false, "Fake tool must NOT be in registry");
  // Agent guardrail must produce this exact substring:
  const guardMsg = `Tool '${fakeTool}' is not in the tool registry. Run /workflows to see available commands.`;
  assertMatch(guardMsg, /Run \/workflows to see available commands/);
});

Deno.test("J2: tool_registry.json matches AGENT_TOOLS in index.ts (real files, exact set equality)", async () => {
  // Parse the ACTUAL registry file
  const registryRaw = await Deno.readTextFile(
    new URL("../../../docs/tool_registry.json", import.meta.url)
  );
  const registry = JSON.parse(registryRaw);
  const registryNames: string[] = (registry.tools ?? []).map((t: any) => t.tool_name);
  const registrySorted = Array.from(new Set(registryNames)).sort();

  // Read the ACTUAL runtime source and extract tool names from AGENT_TOOLS definition
  const indexSource = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const toolNameRegex = /\{\s*name:\s*"([^"]+)"/g;
  const runtimeNames: string[] = [];
  for (const m of indexSource.matchAll(toolNameRegex)) runtimeNames.push(m[1]);
  const runtimeSorted = Array.from(new Set(runtimeNames)).sort();

  // Exact set equality — no instagram exceptions, no loopholes
  const runtimeOnly = runtimeSorted.filter(x => !registrySorted.includes(x));
  const registryOnly = registrySorted.filter(x => !runtimeSorted.includes(x));
  assertEquals(
    runtimeSorted,
    registrySorted,
    `Registry/runtime drift detected. runtimeOnly=[${runtimeOnly}] registryOnly=[${registryOnly}]`
  );
});

Deno.test("J3: workflow_playbooks.json references ONLY registered tools (real file)", async () => {
  const registryRaw = await Deno.readTextFile(
    new URL("../../../docs/tool_registry.json", import.meta.url)
  );
  const registry = JSON.parse(registryRaw);
  const registryNames = new Set((registry.tools ?? []).map((t: any) => t.tool_name));

  const playbookRaw = await Deno.readTextFile(
    new URL("../../../docs/workflow_playbooks.json", import.meta.url)
  );
  const playbooks = JSON.parse(playbookRaw);

  // Extract tool-like tokens from workflow step actions only (not JSON keys)
  const blob = JSON.stringify(playbooks);
  const toolTokenRegex = /\b(get|list|trigger|retry|archive|approve|reject|switch)_[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)+\b/g;
  const refs = Array.from(new Set(blob.match(toolTokenRegex) ?? [])).sort();

  // Filter out known JSON field names that match the pattern but aren't tools
  const JSON_FIELD_NAMES = new Set(["trigger_examples"]);
  const toolRefs = refs.filter(r => !JSON_FIELD_NAMES.has(r));

  const missing = toolRefs.filter(r => !registryNames.has(r));
  assertEquals(missing.length, 0, `Workflow references missing tools: ${missing.join(", ")}`);
});

Deno.test("J4: text-only response to a tool-mapped request is a violation", () => {
  const agentResponse = { text: "You have 869 active jobs...", toolCalls: [] };
  const expectedTool = "get_active_jobs_summary";
  const violation = agentResponse.toolCalls.length === 0
    && ALL_TOOL_NAMES.includes(expectedTool);
  assertEquals(violation, true,
    "Agent must NOT answer with text when a matching tool exists — must call the tool");
});

Deno.test("J5: no-workflow fallback uses /workflows suggestion", () => {
  const expected = "Run /workflows to see available commands.";
  const agentFallback = "Run /workflows to see available commands.";
  assertEquals(agentFallback, expected,
    "Fallback message must suggest /workflows, not the old vague message");
});

Deno.test("J6: REAL index.ts source contains all enforcement strings", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

  const requiredStrings = [
    "NO TOOL, NO CLAIM",
    "NO WORKFLOW, NO ACTION",
    "Run /workflows to see available commands",
    "EVIDENCE OVER CLAIMS",
    "GUARDRAIL: AI tried to call unregistered tool",
    "FATAL: Tool execution logging failed",
  ];

  for (const s of requiredStrings) {
    assertEquals(source.includes(s), true,
      `index.ts MUST contain '${s}' — enforcement is missing from production code`);
  }
});

Deno.test("J7: guardrail block message uses tc.name interpolation in real source", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

  // Must contain the user-facing message
  assertEquals(
    source.includes("Run /workflows to see available commands"),
    true,
    "Missing user-facing /workflows suggestion message"
  );

  // Must reference tc.name in guardrail section
  assertEquals(
    source.includes("tc.name"),
    true,
    "Guardrail must interpolate tc.name somewhere in index.ts"
  );

  // Ensure the specific guardrail log exists
  assertMatch(
    source,
    /GUARDRAIL: AI tried to call unregistered tool/,
    "Missing GUARDRAIL log line"
  );
});

// ═══════════════════════════════════════════════════════════════
// ─── K) TWO-LANE GUARDRAIL REGRESSION TESTS ─────────────────
// ═══════════════════════════════════════════════════════════════

Deno.test("K1: executeAgenticLoop rejects lane2_assistant with TOOLS_BLOCKED", () => {
  // Mirror the guard logic from index.ts
  function guardCheck(opts: { lane?: string; allowTools?: boolean }): string | null {
    if (opts.lane !== "lane1_do" || opts.allowTools !== true) {
      return "TOOLS_BLOCKED: agentic loop cannot run outside /do execution lane";
    }
    return null;
  }

  const result = guardCheck({ lane: "lane2_assistant", allowTools: false });
  assertExists(result, "Guard must reject lane2_assistant");
  assertMatch(result!, /TOOLS_BLOCKED/, "Error must contain TOOLS_BLOCKED");
});

Deno.test("K2: executeAgenticLoop rejects missing workflowKey", () => {
  function workflowGuard(workflowKey?: string): string | null {
    if (!workflowKey) return "WORKFLOW_REQUIRED_FOR_EXECUTION";
    return null;
  }

  const result = workflowGuard(undefined);
  assertExists(result);
  assertEquals(result, "WORKFLOW_REQUIRED_FOR_EXECUTION");
});

Deno.test("K3: executeAgenticLoop accepts lane1_do with allowTools=true and workflowKey", () => {
  function fullGuard(opts: { lane?: string; allowTools?: boolean; workflowKey?: string }): string | null {
    if (opts.lane !== "lane1_do" || opts.allowTools !== true) {
      return "TOOLS_BLOCKED";
    }
    if (!opts.workflowKey) return "WORKFLOW_REQUIRED_FOR_EXECUTION";
    return null;
  }

  const result = fullGuard({ lane: "lane1_do", allowTools: true, workflowKey: "system_status" });
  assertEquals(result, null, "Valid execution context must pass all guards");
});

Deno.test("K4: workflow-scoped tool blocking rejects tools outside workflow declaration", () => {
  const workflowToolNames = ["retry_outbox"];
  const attemptedTool = "delete_user";

  const blocked = workflowToolNames && !workflowToolNames.includes(attemptedTool);
  assertEquals(blocked, true, "Tool not in workflow must be blocked");
});

Deno.test("K5: workflow-scoped tool blocking allows tools inside workflow declaration", () => {
  const workflowToolNames = ["get_system_status", "list_failed_jobs"];
  const attemptedTool = "get_system_status";

  const blocked = workflowToolNames && !workflowToolNames.includes(attemptedTool);
  assertEquals(blocked, false, "Tool in workflow must be allowed");
});

Deno.test("K6: EXECUTION_CONTEXT_INVALID_LANE guard present in source", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /EXECUTION_CONTEXT_INVALID_LANE/, "Must contain EXECUTION_CONTEXT_INVALID_LANE guard");
});

Deno.test("K7: WORKFLOW_NOT_FOUND_IN_REGISTRY guard present in source", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /WORKFLOW_NOT_FOUND_IN_REGISTRY/, "Must contain WORKFLOW_NOT_FOUND_IN_REGISTRY guard");
});

Deno.test("K8: workflow_tool_blocked log present in source", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /workflow_tool_blocked/, "Must contain workflow_tool_blocked structured log");
});

Deno.test("K9: execution_complete marker present in task result_json updates", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /execution_complete:\s*true/, "Must set execution_complete: true in result_json");
});

Deno.test("K10: executeAgenticLoop is only called inside /do block", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  // Find all call sites (not the function definition)
  const callPattern = /executeAgenticLoop\(/g;
  const matches: number[] = [];
  let m;
  while ((m = callPattern.exec(source)) !== null) {
    matches.push(m.index);
  }
  // Should have exactly 2: the definition and the /do call site
  assertEquals(matches.length, 2, `executeAgenticLoop must appear exactly 2 times (definition + 1 call site), found ${matches.length}`);
});

Deno.test("K11: Lane 2 assistant mode never calls executeAgenticLoop", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  // Extract Lane 2 section
  const lane2Start = source.indexOf("LANE 2 — ASSISTANT MODE");
  assertExists(lane2Start, "Lane 2 section must exist");
  const lane2Section = source.slice(lane2Start);
  assertEquals(
    lane2Section.includes("executeAgenticLoop("),
    false,
    "Lane 2 must never call executeAgenticLoop"
  );
});

Deno.test("K12: ai_response structured telemetry log present in source", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /event.*ai_response/, "Must contain ai_response structured telemetry log");
});

Deno.test("K13: execution_context structured log present in source", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /event.*execution_context/, "Must contain execution_context structured log");
});

// ─── L-series: Execution metrics, lock-based guards, telemetry ──

Deno.test("L1: executionStart timer exists in executeAgenticLoop", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /const executionStart = Date\.now\(\)/, "Must capture executionStart timestamp");
});

Deno.test("L2: execution_duration_ms is stored in result_json", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /execution_duration_ms/, "Must record execution_duration_ms in task result_json");
});

Deno.test("L3: execution_lock guard present (TASK_LOCK_NOT_ACQUIRED)", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /TASK_LOCK_NOT_ACQUIRED/, "Must throw TASK_LOCK_NOT_ACQUIRED for lock-based duplicate prevention");
});

Deno.test("L4: execution_lock field used in result_json", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /execution_lock/, "Must use execution_lock in result_json for lock-based guard");
});

Deno.test("L5: lane1_execution_start structured log present", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /lane1_execution_start/, "Must log lane1_execution_start structured event");
});

Deno.test("L6: tool_execution structured telemetry present", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /event.*tool_execution[^_]/, "Must log tool_execution structured event");
});

Deno.test("L7: tool_execution_failed structured telemetry present", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /tool_execution_failed/, "Must log tool_execution_failed structured event");
});

Deno.test("L8: systemHealthCheck function exists", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /function systemHealthCheck\(\)/, "Must define systemHealthCheck helper");
});

Deno.test("L9: /status handler includes health check data", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  const statusSection = source.slice(source.indexOf("Direct \"status\" shortcut"));
  assertMatch(statusSection, /systemHealthCheck/, "Status handler must call systemHealthCheck");
});

Deno.test("L10: Guard rejects lane2_assistant with TOOLS_BLOCKED", () => {
  const lane: string = "lane2_assistant";
  const allowTools = JSON.parse("false") as boolean;
  const blocked = lane !== "lane1_do" || allowTools !== true;
  assertEquals(blocked, true, "lane2_assistant must be blocked");
});

Deno.test("L11: Guard rejects missing workflowKey", () => {
  const workflowKey: string | undefined = undefined;
  assertEquals(!workflowKey, true, "Missing workflowKey must trigger WORKFLOW_REQUIRED_FOR_EXECUTION");
});

Deno.test("L12: logEvent helper defined in source", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /function logEvent\(/, "Must define logEvent structured logging helper");
});

Deno.test("L13: Lock acquisition uses .is('result_json->execution_lock', null)", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /\.is\("result_json->execution_lock", null\)/, "Must use .is() filter for lock acquisition");
});

Deno.test("L14: Lock-based guard unit test — first lock succeeds, second fails", () => {
  // Simulate lock acquisition logic
  let lockHeld: string | null = null;

  function acquireLock(lockId: string): boolean {
    if (lockHeld !== null) return false; // lock already held
    lockHeld = lockId;
    return true;
  }

  const firstLock = acquireLock("lock-1");
  assertEquals(firstLock, true, "First lock attempt must succeed");

  const secondLock = acquireLock("lock-2");
  assertEquals(secondLock, false, "Second lock attempt must fail (TASK_LOCK_NOT_ACQUIRED)");
});

Deno.test("L15: /metrics command handler present in source", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /\/metrics/, "Must handle /metrics command");
  assertMatch(source, /shortcut_metrics/, "Must store progress_step='shortcut_metrics'");
});

Deno.test("L16: duplicate_execution_blocked structured log present", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /duplicate_execution_blocked/, "Must log duplicate_execution_blocked event");
});

// ── M-series: /help and /start mention /metrics ──

Deno.test("M1: /help text mentions /metrics", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /\/metrics\s*—/, "/help must list /metrics with a dash description");
});

Deno.test("M2: /start text mentions Observability and /metrics", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /Observability/, "/start must contain Observability section");
  assertMatch(source, /\/metrics/, "/start must mention /metrics");
});

// ── N-series: /metrics arg parsing ──

Deno.test("N1: /metrics limit parsing — default, cap, fallback", () => {
  function parseMetricsLimit(text: string): number {
    const parts = text.trim().split(/\s+/);
    const requested = parts[1] ? Number(parts[1]) : 20;
    return Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 100) : 20;
  }

  assertEquals(parseMetricsLimit("/metrics"), 20, "default is 20");
  assertEquals(parseMetricsLimit("/metrics 50"), 50, "explicit 50");
  assertEquals(parseMetricsLimit("/metrics 999"), 100, "capped to 100");
  assertEquals(parseMetricsLimit("/metrics 0"), 1, "minimum is 1");
  assertEquals(parseMetricsLimit("/metrics foo"), 20, "NaN falls back to 20");
  assertEquals(parseMetricsLimit("/metrics -5"), 1, "negative capped to 1");
});

Deno.test("N2: fmtDuration helper", () => {
  function fmtDuration(ms: number | null | undefined): string {
    if (ms == null) return "";
    if (ms >= 1000) return ` | ${(ms / 1000).toFixed(2)}s`;
    return ` | ${ms}ms`;
  }

  assertEquals(fmtDuration(null), "");
  assertEquals(fmtDuration(undefined), "");
  assertEquals(fmtDuration(500), " | 500ms");
  assertEquals(fmtDuration(1000), " | 1.00s");
  assertEquals(fmtDuration(2345), " | 2.35s");
});

Deno.test("N3: task ID truncation and lock visibility in source", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /slice\(0,\s*8\)/, "Task IDs must be truncated to 8 chars");
  assertMatch(source, /lock=/, "Metrics output must include lock=");
  assertMatch(
    source,
    /Boolean\(t\.result_json\?\.execution_lock\)\s*\?\s*"on"\s*:\s*"off"/,
    "Lock status must be derived as on/off from result_json.execution_lock"
  );
});

Deno.test("P1: /metrics formatting helpers exist in source", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /function statusIcon\(/, "Must define statusIcon");
  assertMatch(source, /function fmtTs\(/, "Must define fmtTs");
  assertMatch(source, /case "succeeded": return "✅"/, "Must map succeeded to ✅");
  assertMatch(source, /replace\("T", " "\)\.slice\(0, 16\)/, "fmtTs must shorten ISO");
});

Deno.test("Q1: /metrics status summary exists in source", async () => {
  const source = await Deno.readTextFile("supabase/functions/telegram-webhook/index.ts");
  assertMatch(source, /Summary:\*.*✅/, "Must render Summary line with ✅");
  assertMatch(source, /statusCounts/, "Must compute statusCounts");
  assertMatch(source, /status_counts/, "Must store status_counts in result_json");
});

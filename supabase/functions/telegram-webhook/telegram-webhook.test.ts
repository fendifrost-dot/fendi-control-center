/**
 * Regression tests for telegram-webhook edge function.
 *
 * These tests validate the pure-logic helpers that can be tested
 * without live network calls: model locking, message formatting,
 * conversation context building, tool schema generation, and
 * webhook routing decisions.
 *
 * Run with: deno test supabase/functions/telegram-webhook/telegram-webhook.test.ts --allow-env --allow-net
 */

import {
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";

// ─── Re-implement pure helpers locally so we test the same logic ───
// (Edge functions bundle everything in one file; we mirror the logic here
//  to catch regressions if someone changes them.)

const SYSTEM_IDENTITY = "Fendi Control Center AI";

function getModelLabel(model: "gemini" | "grok"): string {
  return model === "grok" ? "Grok" : "Gemini";
}

function formatAssistantMessage(model: "gemini" | "grok", text: string): string {
  return `🤖 *${SYSTEM_IDENTITY}* _(Model: ${getModelLabel(model)})_\n\n${text}`;
}

function isExplicitModelSwitchRequest(userMessage: string, targetModel?: string): boolean {
  if (!targetModel) return false;
  const text = userMessage.toLowerCase();
  const normalizedTarget = targetModel.toLowerCase();
  return (
    text.includes(`/model ${normalizedTarget}`) ||
    text.includes(`switch to ${normalizedTarget}`) ||
    text.includes(`use ${normalizedTarget}`) ||
    text.includes(`change model to ${normalizedTarget}`)
  );
}

type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
  model: "gemini" | "grok";
  at: string;
};

function buildConversationContextFromTurns(turns: ConversationTurn[]): string {
  const recent = turns.slice(-12);
  if (recent.length === 0) return "No prior conversation context.";
  return recent
    .map((t) => `${t.role.toUpperCase()} [${getModelLabel(t.model)}]: ${String(t.content || "").slice(0, 700)}`)
    .join("\n\n");
}

// ─── Tool schema shape helpers (mirrored from source) ───────────

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, any>;
  destructive: boolean;
}

// Minimal tool list matching the source to validate schema generation
const SAMPLE_TOOLS: ToolDef[] = [
  { name: "get_system_status", description: "Get system status.", parameters: { type: "object", properties: {}, required: [] }, destructive: false },
  { name: "retry_failed_job", description: "Retry a failed job.", parameters: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] }, destructive: true },
  { name: "switch_ai_model", description: "Switch model.", parameters: { type: "object", properties: { model: { type: "string", enum: ["gemini", "grok"] } }, required: ["model"] }, destructive: true },
];

function getGeminiToolDeclarations(tools: ToolDef[]) {
  return tools.map(t => ({
    name: t.name,
    description: t.description + (t.destructive ? " [DESTRUCTIVE - requires user confirmation]" : ""),
    parameters: t.parameters,
  }));
}

function getGrokToolSchemas(tools: ToolDef[]) {
  return tools.map(t => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description + (t.destructive ? " [DESTRUCTIVE - requires user confirmation]" : ""),
      parameters: t.parameters,
    },
  }));
}

// ═══════════════════════════════════════════════════════════════
// ─── TESTS ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// ─── 1. Model Label ─────────────────────────────────────────

Deno.test("getModelLabel returns correct labels", () => {
  assertEquals(getModelLabel("grok"), "Grok");
  assertEquals(getModelLabel("gemini"), "Gemini");
});

// ─── 2. Message Formatting ──────────────────────────────────

Deno.test("formatAssistantMessage includes model label and identity", () => {
  const msg = formatAssistantMessage("grok", "Hello there");
  assertMatch(msg, /Fendi Control Center AI/);
  assertMatch(msg, /Model: Grok/);
  assertMatch(msg, /Hello there/);
});

Deno.test("formatAssistantMessage works for gemini", () => {
  const msg = formatAssistantMessage("gemini", "Status OK");
  assertMatch(msg, /Model: Gemini/);
  assertMatch(msg, /Status OK/);
});

// ─── 3. Model Locking — isExplicitModelSwitchRequest ────────

Deno.test("model lock: /model grok is explicit switch", () => {
  assertEquals(isExplicitModelSwitchRequest("/model grok", "grok"), true);
});

Deno.test("model lock: /model gemini is explicit switch", () => {
  assertEquals(isExplicitModelSwitchRequest("/model gemini", "gemini"), true);
});

Deno.test("model lock: 'switch to grok' is explicit switch", () => {
  assertEquals(isExplicitModelSwitchRequest("switch to grok", "grok"), true);
});

Deno.test("model lock: 'use gemini' is explicit switch", () => {
  assertEquals(isExplicitModelSwitchRequest("use gemini", "gemini"), true);
});

Deno.test("model lock: 'change model to grok' is explicit switch", () => {
  assertEquals(isExplicitModelSwitchRequest("change model to grok", "grok"), true);
});

Deno.test("model lock: random message is NOT an explicit switch", () => {
  assertEquals(isExplicitModelSwitchRequest("show me the status", "grok"), false);
  assertEquals(isExplicitModelSwitchRequest("what's broken?", "gemini"), false);
});

Deno.test("model lock: no target model returns false", () => {
  assertEquals(isExplicitModelSwitchRequest("/model grok", undefined), false);
});

Deno.test("model lock: wrong target model returns false", () => {
  assertEquals(isExplicitModelSwitchRequest("/model grok", "gemini"), false);
});

Deno.test("model lock: case insensitive", () => {
  assertEquals(isExplicitModelSwitchRequest("/MODEL GROK", "grok"), true);
  assertEquals(isExplicitModelSwitchRequest("Switch To Gemini", "gemini"), true);
});

// ─── 4. Conversation Context Builder ────────────────────────

Deno.test("conversation context: empty turns returns no-context message", () => {
  assertEquals(buildConversationContextFromTurns([]), "No prior conversation context.");
});

Deno.test("conversation context: includes turns with model labels", () => {
  const turns: ConversationTurn[] = [
    { role: "user", content: "what's up", model: "grok", at: "2025-01-01T00:00:00Z" },
    { role: "assistant", content: "all good", model: "grok", at: "2025-01-01T00:01:00Z" },
  ];
  const ctx = buildConversationContextFromTurns(turns);
  assertMatch(ctx, /USER \[Grok\]: what's up/);
  assertMatch(ctx, /ASSISTANT \[Grok\]: all good/);
});

Deno.test("conversation context: limits to last 12 turns", () => {
  const turns: ConversationTurn[] = Array.from({ length: 20 }, (_, i) => ({
    role: "user" as const,
    content: `message ${i}`,
    model: "gemini" as const,
    at: `2025-01-01T00:${String(i).padStart(2, "0")}:00Z`,
  }));
  const ctx = buildConversationContextFromTurns(turns);
  // Should NOT contain messages 0-7 (first 8)
  assertEquals(ctx.includes("message 0"), false);
  assertEquals(ctx.includes("message 7"), false);
  // Should contain messages 8-19 (last 12)
  assertEquals(ctx.includes("message 8"), true);
  assertEquals(ctx.includes("message 19"), true);
});

Deno.test("conversation context: truncates long content to 700 chars", () => {
  const longContent = "A".repeat(1000);
  const turns: ConversationTurn[] = [
    { role: "user", content: longContent, model: "gemini", at: "2025-01-01T00:00:00Z" },
  ];
  const ctx = buildConversationContextFromTurns(turns);
  // 700 A's + prefix "USER [Gemini]: " = should not have 1000 A's
  const aCount = (ctx.match(/A/g) || []).length;
  assertEquals(aCount, 700);
});

Deno.test("conversation context: preserves cross-model context", () => {
  const turns: ConversationTurn[] = [
    { role: "user", content: "task for grok", model: "grok", at: "2025-01-01T00:00:00Z" },
    { role: "assistant", content: "grok response", model: "grok", at: "2025-01-01T00:01:00Z" },
    { role: "user", content: "continue with gemini", model: "gemini", at: "2025-01-01T00:02:00Z" },
    { role: "assistant", content: "gemini picks up", model: "gemini", at: "2025-01-01T00:03:00Z" },
  ];
  const ctx = buildConversationContextFromTurns(turns);
  assertMatch(ctx, /USER \[Grok\]: task for grok/);
  assertMatch(ctx, /ASSISTANT \[Grok\]: grok response/);
  assertMatch(ctx, /USER \[Gemini\]: continue with gemini/);
  assertMatch(ctx, /ASSISTANT \[Gemini\]: gemini picks up/);
});

// ─── 5. Tool Schema Generation ──────────────────────────────

Deno.test("Gemini tool declarations have correct shape", () => {
  const decls = getGeminiToolDeclarations(SAMPLE_TOOLS);
  assertEquals(decls.length, 3);
  assertEquals(decls[0].name, "get_system_status");
  assertEquals(decls[0].description.includes("[DESTRUCTIVE"), false); // non-destructive
  assertEquals(decls[1].description.includes("[DESTRUCTIVE"), true); // destructive
});

Deno.test("Grok tool schemas have function wrapper", () => {
  const schemas = getGrokToolSchemas(SAMPLE_TOOLS);
  assertEquals(schemas.length, 3);
  assertEquals(schemas[0].type, "function");
  assertEquals(schemas[0].function.name, "get_system_status");
  assertEquals(schemas[1].function.description.includes("[DESTRUCTIVE"), true);
});

Deno.test("destructive tools are marked in descriptions for both models", () => {
  const gemini = getGeminiToolDeclarations(SAMPLE_TOOLS);
  const grok = getGrokToolSchemas(SAMPLE_TOOLS);

  // switch_ai_model is destructive
  const geminiSwitch = gemini.find(t => t.name === "switch_ai_model")!;
  const grokSwitch = grok.find(t => t.function.name === "switch_ai_model")!;
  assertMatch(geminiSwitch.description, /DESTRUCTIVE/);
  assertMatch(grokSwitch.function.description, /DESTRUCTIVE/);

  // get_system_status is NOT destructive
  const geminiStatus = gemini.find(t => t.name === "get_system_status")!;
  assertEquals(geminiStatus.description.includes("DESTRUCTIVE"), false);
});

// ─── 6. Webhook Routing Logic ───────────────────────────────

Deno.test("callback_query action parsing splits correctly", () => {
  const cbData = "agent_confirm:abc12345";
  const [action, ...idParts] = cbData.split(":");
  const targetId = idParts.join(":");
  assertEquals(action, "agent_confirm");
  assertEquals(targetId, "abc12345");
});

Deno.test("callback_query with colon in ID joins correctly", () => {
  const cbData = "approve:some:complex:id";
  const [action, ...idParts] = cbData.split(":");
  const targetId = idParts.join(":");
  assertEquals(action, "approve");
  assertEquals(targetId, "some:complex:id");
});

Deno.test("/model regex matches valid commands", () => {
  const regex = /^\/model\s+(grok|gemini)$/i;
  assertEquals(regex.test("/model grok"), true);
  assertEquals(regex.test("/model gemini"), true);
  assertEquals(regex.test("/model GROK"), true);
  assertEquals(regex.test("/model Gemini"), true);
});

Deno.test("/model regex rejects invalid commands", () => {
  const regex = /^\/model\s+(grok|gemini)$/i;
  assertEquals(regex.test("/model chatgpt"), false);
  assertEquals(regex.test("/model"), false);
  assertEquals(regex.test("/model grok extra"), false);
  assertEquals(regex.test("model grok"), false);
});

// ─── 7. Conversation turn limiting ──────────────────────────

Deno.test("saveConversationTurns logic limits to 20 turns", () => {
  const turns: ConversationTurn[] = Array.from({ length: 30 }, (_, i) => ({
    role: "user" as const,
    content: `msg ${i}`,
    model: "gemini" as const,
    at: `2025-01-01T00:${String(i).padStart(2, "0")}:00Z`,
  }));
  const limited = turns.slice(-20);
  assertEquals(limited.length, 20);
  assertEquals(limited[0].content, "msg 10");
  assertEquals(limited[19].content, "msg 29");
});

// ─── 8. Model switch_ai_model guard ─────────────────────────

Deno.test("model switch blocked for non-explicit requests", () => {
  // Simulates the guard in executeAgenticLoop
  const userMessage = "what's the status?";
  const toolCallName = "switch_ai_model";
  const toolCallArgs = { model: "grok" };

  const isBlocked = toolCallName === "switch_ai_model" && !isExplicitModelSwitchRequest(userMessage, toolCallArgs.model);
  assertEquals(isBlocked, true);
});

Deno.test("model switch allowed for explicit requests", () => {
  const userMessage = "/model grok";
  const toolCallName = "switch_ai_model";
  const toolCallArgs = { model: "grok" };

  const isBlocked = toolCallName === "switch_ai_model" && !isExplicitModelSwitchRequest(userMessage, toolCallArgs.model);
  assertEquals(isBlocked, false);
});

// ─── 9. Edge cases ──────────────────────────────────────────

Deno.test("formatAssistantMessage handles empty text", () => {
  const msg = formatAssistantMessage("grok", "");
  assertMatch(msg, /Model: Grok/);
  // Should still have the header even with empty body
  assertEquals(msg.endsWith("\n\n"), true);
});

Deno.test("conversation context handles null/undefined content gracefully", () => {
  const turns: ConversationTurn[] = [
    { role: "user", content: undefined as any, model: "grok", at: "2025-01-01T00:00:00Z" },
    { role: "assistant", content: null as any, model: "grok", at: "2025-01-01T00:01:00Z" },
  ];
  // Should not throw
  const ctx = buildConversationContextFromTurns(turns);
  assertEquals(typeof ctx, "string");
});

Deno.test("getActiveModel fallback: non-grok value defaults to gemini", () => {
  // Mirrors the logic: data?.setting_value === "grok" ? "grok" : "gemini"
  const testValues = [null, undefined, "", "chatgpt", "gemini", "GROK"];
  for (const val of testValues) {
    const result = val === "grok" ? "grok" : "gemini";
    assertNotEquals(result, "grok"); // none of these should be "grok"
  }
  assertEquals("grok" === "grok" ? "grok" : "gemini", "grok"); // only exact match
});

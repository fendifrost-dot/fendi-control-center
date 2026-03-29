import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { fetchCreditGuardian } from "../_shared/creditGuardian.ts";

const BOT_TOKEN = Deno.env.get("FendiAIbot")!;
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_KEY = Deno.env.get("Frost_Gemini")!;
const GROK_KEY = Deno.env.get("Frost_Grok")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const SYSTEM_IDENTITY = "Fendi Control Center AI";
// ─── Implemented workflow keys → handler names (deterministic routing) ───
// Cardinality is IMPLEMENTED_WORKFLOW_KEYS.size (also exposed in /status health); do not hardcode counts in docs.
const IMPLEMENTED_WORKFLOW_KEYS = new Set([
  "ping", "system_status", "resend_failed", "list_workflows", "help",
    "model_switch", "document_approval", "document_rejection",
    "failed_job_management", "drive_sync", "client_overview",
    "file_browsing", "connected_project_stats", "error_explanation",
    "active_jobs_summary", "document_ingestion_processing",
    "drive_ingest", "free_agent",
    "find_playlist_opportunities", "get_pitch_report", "send_playlist_pitch", "update_pitch_status",
  "analyze_client_credit",
  "get_client_report",
  "generate_dispute_letters",
  "query_credit_compass",
  "get_tax_status",
  "get_tax_transactions",
  "get_tax_documents",
  "get_tax_discrepancies",
  "query_cc_tax",
]);

// ─── Workflow registry fetch ────────────────────────────────────
interface WorkflowEntry {
  key: string; name: string; description: string;
  trigger_phrases: string[]; tools: string[];
}

// Synthetic workflow for auto-promoted "find playlist opportunities" when DB registry doesn't have it
const SYNTHETIC_FIND_PLAYLIST_OPPORTUNITIES: WorkflowEntry = {
  key: "find_playlist_opportunities",
  name: "Find Playlist Opportunities",
  description: "Research playlist opportunities for a track on Spotify and SoundCloud.",
  trigger_phrases: ["find playlist opportunities", "playlist opportunities for"],
  tools: ["find_playlist_opportunities"],
};

function _normalizeText(s: string): string {
  return (s ?? "").trim().toLowerCase();
}

function _matchWorkflows(input: string, workflows: WorkflowEntry[]): { matches: WorkflowEntry[]; chosen?: WorkflowEntry } {
  const norm = _normalizeText(input);
  if (!norm) return { matches: [] };
  const matched: WorkflowEntry[] = [];
  const normKey = norm.replace(/\s+/g, "_");
  for (const wf of workflows) {
    const wfKeyNorm = _normalizeText(wf.key).replace(/\s+/g, "_");
    if (norm === wfKeyNorm || normKey === wfKeyNorm || norm.includes(wfKeyNorm) || wfKeyNorm.includes(norm)) {
      matched.push(wf);
      break;
    }
    for (const phrase of wf.trigger_phrases) {
      const np = _normalizeText(phrase);
      if (norm === np || norm.includes(np) || (norm.length >= 4 && np.includes(norm))) {
        matched.push(wf);
        break;
      }
    }
  }
  if (matched.length >= 1) return { matches: matched, chosen: matched.sort((a, b) => Math.max(...(b.trigger_phrases || []).map(p => p.length), b.key.length) - Math.max(...(a.trigger_phrases || []).map(p => p.length), a.key.length))[0] };
  return { matches: matched };
}

function _formatWorkflowList(workflows: WorkflowEntry[]): string {
  if (!workflows.length) return "No workflows registered.";
  const lines = workflows.map((wf) => {
    const status = IMPLEMENTED_WORKFLOW_KEYS.has(wf.key) ? "✅ Implemented" : "⚠️ Not Implemented";
    const triggers = (wf.trigger_phrases || []).slice(0, 4).join(", ");
    const tools = (wf.tools || []).join(", ") || "—";
    return `*${wf.name}* — \`${wf.key}\`\n  ${wf.description}\n  Triggers: ${triggers}\n  Tools: ${tools}\n  Status: ${status}`;
  });
  return `📋 *Workflow Registry*\n\n${lines.join("\n\n")}`;
}

function _formatNoMatch(workflows: WorkflowEntry[]): string {
  const suggestions = workflows.slice(0, 6)
    .map((wf) => `• *${wf.name}* — try: \`${wf.trigger_phrases[0] || wf.key}\``)
    .join("\n");
  return `❓ No matching workflow for that request.\n\nRun /workflows to see everything available.\n\nSuggestions:\n${suggestions}`;
}

async function fetchWorkflowRegistry(): Promise<WorkflowEntry[]> {
  try {
    const { data, error } = await supabase.rpc("list_workflows");
    if (error || !data) {
      console.error("[WORKFLOW] RPC list_workflows failed:", error?.message);
      return [];
    }
    // Runtime shape guard
    if (!Array.isArray(data)) return [];
    return (data as any[]).filter((w) => w.key && w.name).map((w) => ({
              key: String(w.key),
              name: String(w.name),
              description: String(w.description || ""),
              trigger_phrases: Array.isArray(w.trigger_phrases) ? w.trigger_phrases.map(String) : [],
              tools: Array.isArray(w.tools) ? w.tools.map(String) : [],
    }));
  } catch (e) {
    console.error("[WORKFLOW] fetchWorkflowRegistry exception:", e);
    return [];
  }
}

async function sendHeaderOnce(taskId: string, chatId: string, model: "gemini" | "grok") {
  const headerText = `🤖 *${SYSTEM_IDENTITY}* _(Model: ${getModelLabel(model)})_`;
  await enqueueTelegram(taskId, chatId, "sendMessage", {
    chat_id: chatId, text: headerText, parse_mode: "Markdown",
  }, `task:${taskId}:header`);
  await flushTelegramOutbox(chatId, 1);
}

// ─── Outbox-aware Telegram delivery ─────────────────────────────
let _currentTaskId: string | null = null;

async function _rawTelegramSend(method: string, payload: Record<string, any>) {
  const resp = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return resp.json();
}

async function enqueueTelegram(taskId: string, chatId: string, kind: string, payload: Record<string, any>, dedupeKey?: string) {
  try {
    const row: Record<string, any> = {
      task_id: taskId, chat_id: chatId, kind, payload,
      status: "queued", attempt_count: 0,
      next_attempt_at: new Date().toISOString(),
    };
    if (dedupeKey) row.dedupe_key = dedupeKey;
    const { error } = await supabase.from("telegram_outbox").insert(row);
    if (error) {
      if (error.code === "23505") { console.log(`[OUTBOX] Dedupe hit: ${dedupeKey}`); return; }
      console.error("[OUTBOX] Enqueue error:", error.message);
    }
  } catch (e) { console.error("[OUTBOX] Enqueue fatal:", e); }
}

async function flushTelegramOutbox(chatId: string, max = 5): Promise<{ sent: number; failed: number }> {
  let sent = 0, failed = 0;
  try {
    const { data: due } = await supabase
      .from("telegram_outbox")
      .select("id, kind, payload, attempt_count")
      .in("status", ["queued", "failed"])
      .eq("chat_id", chatId)
      .lte("next_attempt_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(max);
    if (!due || due.length === 0) return { sent: 0, failed: 0 };
    for (const row of due) {
      await supabase.from("telegram_outbox").update({
        status: "sending", last_attempt_at: new Date().toISOString(),
        attempt_count: row.attempt_count + 1,
      }).eq("id", row.id);
      try {
        const result = await _rawTelegramSend(row.kind || "sendMessage", row.payload as Record<string, any>);
        if (result.ok) {
          await supabase.from("telegram_outbox").update({ status: "sent", sent_at: new Date().toISOString(), last_error: null }).eq("id", row.id);
          sent++;
        } else {
          const backoff = Math.min(Math.pow(row.attempt_count + 1, 2) * 5, 120);
          await supabase.from("telegram_outbox").update({
            status: "failed", last_error: result.description || JSON.stringify(result).slice(0, 500),
            next_attempt_at: new Date(Date.now() + backoff * 1000).toISOString(),
          }).eq("id", row.id);
          failed++;
        }
      } catch (e) {
        const backoff = Math.min(Math.pow(row.attempt_count + 1, 2) * 5, 120);
        await supabase.from("telegram_outbox").update({
          status: "failed", last_error: e instanceof Error ? e.message : String(e),
          next_attempt_at: new Date(Date.now() + backoff * 1000).toISOString(),
        }).eq("id", row.id);
        failed++;
      }
    }
    console.log(`[OUTBOX-FLUSH] chatId=${chatId} picked=${due.length} sent=${sent} failed=${failed}`);
  } catch (e) { console.error("[OUTBOX-FLUSH] Fatal:", e); }
  return { sent, failed };
}

async function sendMessage(chatId: string, text: string, options: any = {}, dedupeKey?: string) {
  const payload = { chat_id: chatId, text, parse_mode: "Markdown", ...options };
  if (_currentTaskId) {
    await enqueueTelegram(_currentTaskId, chatId, "sendMessage", payload, dedupeKey);
    await flushTelegramOutbox(chatId, 3);
  } else {
    console.warn("[OUTBOX] No _currentTaskId, direct send fallback");
    await _rawTelegramSend("sendMessage", payload);
  }
}

async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  await _rawTelegramSend("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

async function editMessageReplyMarkup(chatId: string, messageId: number) {
  const payload = { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } };
  if (_currentTaskId) {
    await enqueueTelegram(_currentTaskId, chatId, "editMessageReplyMarkup", payload);
    await flushTelegramOutbox(chatId, 1);
  } else {
    await _rawTelegramSend("editMessageReplyMarkup", payload);
  }
}

// ─── Model & conversation state helpers ─────────────────────────
async function getActiveModel(chatId?: string): Promise<{ model: "gemini" | "grok"; session_created?: boolean }> {
  // Try chat-scoped session first
  if (chatId) {
    const { data: session } = await supabase
      .from("bot_settings")
      .select("setting_value")
      .eq("setting_key", `session:${chatId}:active_model`)
      .single();
    if (session?.setting_value) {
      return { model: session.setting_value === "grok" ? "grok" : "gemini" };
    }
  }

  // Fall back to global setting
  const { data } = await supabase
    .from("bot_settings")
    .select("setting_value")
    .eq("setting_key", "ai_model")
    .single();

  if (data?.setting_value) {
    return { model: data.setting_value === "grok" ? "grok" : "gemini" };
  }

  // No session exists — default to grok
  return { model: "grok", session_created: true };
}

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

async function getConversationTurns(chatId: string): Promise<ConversationTurn[]> {
  const { data } = await supabase
    .from("bot_settings")
    .select("setting_value")
    .eq("setting_key", `conversation:${chatId}`)
    .single();

  if (!data?.setting_value) return [];

  try {
    const parsed = JSON.parse(data.setting_value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveConversationTurns(chatId: string, turns: ConversationTurn[]): Promise<void> {
  const limited = turns.slice(-20);
  await supabase.from("bot_settings").upsert(
    {
      setting_key: `conversation:${chatId}`,
      setting_value: JSON.stringify(limited),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "setting_key" }
  );
}

async function appendConversationTurn(chatId: string, turn: ConversationTurn): Promise<void> {
  const turns = await getConversationTurns(chatId);
  turns.push(turn);
  await saveConversationTurns(chatId, turns);
}

async function buildConversationContext(chatId: string): Promise<string> {
  const turns = await getConversationTurns(chatId);
  const recent = turns.slice(-12);
  if (recent.length === 0) return "No prior conversation context.";

  return recent
    .map((t) => `${t.role.toUpperCase()} [${getModelLabel(t.model)}]: ${String(t.content || "").slice(0, 700)}`)
    .join("\n\n");
}

// ─── Fetch last 3 processed documents for context ───────────────
async function getRecentDocContext(): Promise<string> {
  const { data: docs } = await supabase
    .from("documents")
    .select("file_name, doc_type, bureau, status, client_id, clients(name)")
    .eq("status", "completed")
    .order("updated_at", { ascending: false })
    .limit(3);

  if (!docs || docs.length === 0) return "No recently processed documents.";

  return docs.map((d: any, i: number) => {
    const client = d.clients as any;
    return `${i + 1}. ${d.file_name} | Type: ${d.doc_type || "unknown"} | Bureau: ${d.bureau || "N/A"} | Client: ${client?.name || "Unknown"}`;
  }).join("\n");
}

// ─── Session & Task helpers (deterministic spine) ───────────────

async function resolveSession(chatId: string): Promise<{ id: string; active_model: string }> {
  // Try to find existing session
  const { data: existing } = await supabase
    .from("sessions")
    .select("id, active_model")
    .eq("channel", "telegram")
    .eq("channel_user_id", chatId)
    .maybeSingle();

  if (existing) return existing;

  // Create new session (default model: grok)
  const { data: created, error } = await supabase
    .from("sessions")
    .insert({ channel: "telegram", channel_user_id: chatId, active_model: "grok", context: {} })
    .select("id, active_model")
    .single();

  if (error || !created) throw new Error(`Failed to create session: ${error?.message}`);
  return created;
}

async function createTaskRow(sessionId: string, requestText: string, requestedModel?: string | null): Promise<string> {
  const { data, error } = await supabase.from("tasks").insert({
    session_id: sessionId,
    status: "queued",
    request_text: requestText,
    requested_model: requestedModel || null,
    selected_workflow: "unknown",
    result_json: { action: "created" },
  }).select("id").single();

  if (error || !data) throw new Error(`Failed to create task: ${error?.message}`);
  return data.id;
}

// ─── Error code classifier ─────────────────────────────────────
function classifyErrorCode(errMsg: string): { error_code: string; error_hint: string } {
  const msg = (errMsg || "").toLowerCase();
  if (msg.includes("timeout")) return { error_code: "TIMEOUT", error_hint: "Execution exceeded time limit" };
  if (msg.includes("ai unavailable") || msg.includes("gemini agentic error") || msg.includes("grok agentic error") || /\b(4\d{2}|5\d{2})\b/.test(msg) && (msg.includes("api") || msg.includes("fetch"))) return { error_code: "AI_HTTP", error_hint: "AI API returned an error" };
  if (msg.includes("parse") || msg.includes("json") || msg.includes("unexpected token")) return { error_code: "AI_PARSE", error_hint: "Failed to parse AI response" };
  if (msg.includes("tools_blocked")) return { error_code: "TOOL_BLOCKED", error_hint: "Tool execution blocked outside Lane 1" };
  if (msg.includes("workflow_not_found") || msg.includes("registry")) return { error_code: "WORKFLOW_NOT_FOUND", error_hint: "Workflow not found in registry" };
  if (msg.includes("lock_not_acquired") || msg.includes("task_lock")) return { error_code: "LOCK_NOT_ACQUIRED", error_hint: "Another execution already running" };
  return { error_code: "UNKNOWN", error_hint: "Unclassified failure" };
}

function buildFailureResultJson(base: Record<string, any>, errMsg: string, executionStart?: number): Record<string, any> {
  const { error_code, error_hint } = classifyErrorCode(errMsg);
  return {
    ...base,
    error_code,
    error_hint,
    execution_duration_ms: executionStart ? Date.now() - executionStart : undefined,
    execution_lock: null,
    execution_lock_released_ts: Date.now(),
  };
}

// Helper: set shortcut workflow attribution BEFORE running shortcut logic
async function setShortcutAttribution(taskId: string, command: string) {
  await supabase.from("tasks").update({
    status: "running",
    selected_workflow: `shortcut_${command}`,
    result_json: { execution_lane: "shortcut", progress_step: `shortcut_${command}_start` },
  }).eq("id", taskId);
}

// ─── Cross-project helpers ──────────────────────────────────────
async function getConnectedProjects() {
  const { data } = await supabase
    .from("connected_projects")
    .select("*")
    .eq("is_active", true)
    .order("name");
  return data || [];
}

// Each connected project may expose a different endpoint name.
// We try them in order: cross-project-api, control-center-api, project-stats (GET).
const CROSS_PROJECT_ENDPOINTS = ["cross-project-api", "control-center-api"];

async function fetchProjectStats(project: any): Promise<{ name: string; tables: Record<string, number> } | null> {
  try {
    const apiKey = Deno.env.get(project.secret_key_name);
    if (!apiKey) {
      console.error(`[fetchProjectStats] Missing secret: ${project.secret_key_name}`);
      return null;
    }

    // Fairway Fixer / Credit Guardian: POST cross-project-api (or control-center-api) with x-api-key
    for (const ep of CROSS_PROJECT_ENDPOINTS) {
      try {
        const resp = await fetch(`${project.supabase_url}/functions/v1/${ep}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey },
          body: JSON.stringify({ action: "get_clients" }),
        });
        if (resp.ok) {
          const j = await resp.json();
          const n = Array.isArray(j.data) ? j.data.length : 0;
          return { name: project.name, tables: { clients: n } };
        }
        await resp.text();
      } catch { /* try next */ }
    }

    try {
      const fallback = await fetch(`${project.supabase_url}/functions/v1/project-stats`, {
        method: "GET",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      });
      if (fallback.ok) return await fallback.json();
      await fallback.text();
    } catch { /* ignore */ }

    console.error(`[fetchProjectStats] ${project.name}: all endpoints failed`);
    return null;
  } catch (err) {
    console.error(`[fetchProjectStats] ${project.name} error:`, err);
    return null;
  }
}

// ─── System health check ────────────────────────────────────────
function systemHealthCheck() {
  return {
    timestamp_ms: Date.now(),
    uptime_ms: Math.round(performance.now()),
    tool_count: AGENT_TOOLS.length,
    implemented_workflow_count: IMPLEMENTED_WORKFLOW_KEYS.size,
  };
}

// ═══════════════════════════════════════════════════════════════
// ─── AGENTIC TOOL DEFINITIONS ─────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// Each tool: { name, description, parameters, destructive, execute }
// destructive tools require confirmation before execution

/** Passed into tool.execute from the agentic loop (playlist tools use userMessage + conversationContext to infer track_name). */
interface ToolExecuteContext {
  chatId?: string;
  userMessage?: string;
  conversationContext?: string;
}

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, any>;
  destructive: boolean;
  execute: (args: any, context?: ToolExecuteContext) => Promise<string>;
}

const AGENT_TOOLS: ToolDef[] = [
  {
    name: "get_system_status",
    description: "Get overall system status: document counts, pending approvals, active/failed jobs, and current AI model.",
    parameters: { type: "object", properties: {}, required: [] },
    destructive: false,
    execute: async (_args: any, context?: { chatId?: string }) => {
      const errors: { table: string; query: string; error_message: string }[] = [];

      const q1 = await supabase.from("documents").select("*", { count: "exact", head: true }).eq("status", "completed");
      if (q1.error) { console.error("get_system_status: documents query error:", q1.error.message); errors.push({ table: "documents", query: "count completed", error_message: q1.error.message }); }

      const q2 = await supabase.from("telegram_approval_queue").select("*", { count: "exact", head: true }).eq("status", "pending");
      if (q2.error) { console.error("get_system_status: telegram_approval_queue query error:", q2.error.message); errors.push({ table: "telegram_approval_queue", query: "count pending", error_message: q2.error.message }); }

      const q3 = await supabase.from("ingestion_jobs").select("*", { count: "exact", head: true }).in("status", ["queued", "processing", "retrying"]);
      if (q3.error) { console.error("get_system_status: ingestion_jobs active query error:", q3.error.message); errors.push({ table: "ingestion_jobs", query: "count active", error_message: q3.error.message }); }

      const q4 = await supabase.from("ingestion_jobs").select("*", { count: "exact", head: true }).eq("status", "failed");
      if (q4.error) { console.error("get_system_status: ingestion_jobs failed query error:", q4.error.message); errors.push({ table: "ingestion_jobs", query: "count failed", error_message: q4.error.message }); }

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const q5 = await supabase.from("tool_execution_logs").select("*", { count: "exact", head: true }).gte("started_at", oneHourAgo);
      if (q5.error) { console.error("get_system_status: tool_execution_logs query error:", q5.error.message); errors.push({ table: "tool_execution_logs", query: "count recent 1h", error_message: q5.error.message }); }

      const modelResult = await getActiveModel(context?.chatId);

      const result: Record<string, any> = {
        documents_processed: q1.count ?? 0,
        pending_approvals: q2.count ?? 0,
        active_jobs: q3.count ?? 0,
        failed_jobs: q4.count ?? 0,
        recent_tool_calls_1h: q5.count ?? 0,
        active_model: modelResult.model,
      };
      if (modelResult.session_created) result.session_created = true;
      if (errors.length > 0) result.errors = errors;
      return JSON.stringify(result);
    },
  },
  {
    name: "list_pending_approvals",
    description: "List documents waiting for approval with client names and observation counts.",
    parameters: { type: "object", properties: {}, required: [] },
    destructive: false,
    execute: async () => {
      const { data: pending } = await supabase
        .from("telegram_approval_queue")
        .select("*, documents(file_name), clients(name)")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(10);
      return JSON.stringify(pending?.map((p: any) => ({
        id: p.id,
        file_name: (p.documents as any)?.file_name,
        client: (p.clients as any)?.name,
        observation_count: p.observation_count,
      })) || []);
    },
  },
  {
    name: "list_failed_jobs",
    description: "List failed ingestion jobs with file names, error messages, and attempt counts.",
    parameters: { type: "object", properties: {}, required: [] },
    destructive: false,
    execute: async () => {
      const { data: failed } = await supabase
        .from("ingestion_jobs")
        .select("*, documents(file_name), clients(name)")
        .eq("status", "failed")
        .order("completed_at", { ascending: false })
        .limit(10);
      return JSON.stringify(failed?.map((j: any) => ({
        id: j.id,
        file_name: (j.documents as any)?.file_name,
        client: (j.clients as any)?.name,
        attempt_count: j.attempt_count,
        last_error: j.last_error,
      })) || []);
    },
  },
  {
    name: "retry_failed_job",
    description: "Retry a specific failed ingestion job by re-queuing it and triggering processing. Requires job_id.",
    parameters: { type: "object", properties: { job_id: { type: "string", description: "The UUID of the failed job to retry" } }, required: ["job_id"] },
    destructive: true,
    execute: async (args: any) => {
      const { data: job, error } = await supabase
        .from("ingestion_jobs")
        .select("*, documents(file_name)")
        .eq("id", args.job_id)
        .single();
      if (error || !job) return "❌ Job not found.";
      if (job.status !== "failed") return `Job is currently ${job.status}, can only retry failed jobs.`;
      await supabase.from("ingestion_jobs").update({ status: "queued", last_error: null, started_at: null, completed_at: null }).eq("id", args.job_id);
      if (job.document_id) await supabase.from("documents").update({ status: "pending" }).eq("id", job.document_id);
      try {
        const ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || SUPABASE_SERVICE_ROLE_KEY;
        await fetch(`${SUPABASE_URL}/functions/v1/process-document`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}` },
          body: JSON.stringify({ job_id: args.job_id }),
        });
      } catch (e) { console.error("Retry trigger failed:", e); }
      const doc = job.documents as any;
      return `Retry initiated for "${doc?.file_name || "Unknown"}".`;
    },
  },
  {
    name: "archive_job",
    description: "Archive a job so it won't be retried. Requires job_id.",
    parameters: { type: "object", properties: { job_id: { type: "string", description: "The UUID of the job to archive" } }, required: ["job_id"] },
    destructive: true,
    execute: async (args: any) => {
      const { data: job, error } = await supabase.from("ingestion_jobs").select("*, documents(file_name)").eq("id", args.job_id).single();
      if (error || !job) return "❌ Job not found.";
      await supabase.from("ingestion_jobs").update({ status: "archived", completed_at: new Date().toISOString() }).eq("id", args.job_id);
      return `Archived "${(job.documents as any)?.file_name || "Unknown"}".`;
    },
  },
  {
    name: "approve_document",
    description: "Approve a pending document, verifying all its observations. Requires queue_id.",
    parameters: { type: "object", properties: { queue_id: { type: "string", description: "The UUID of the approval queue entry" } }, required: ["queue_id"] },
    destructive: true,
    execute: async (args: any) => {
      const { data: queue, error } = await supabase.from("telegram_approval_queue").select("*").eq("id", args.queue_id).single();
      if (error || !queue) return "❌ Approval record not found.";
      if (queue.status !== "pending") return "Already processed.";
      const now = new Date().toISOString();
      await supabase.from("observations").update({ is_verified: true, verified_at: now, verified_via: "telegram" }).eq("document_id", queue.document_id).eq("client_id", queue.client_id);
      await supabase.from("telegram_approval_queue").update({ status: "approved", resolved_at: now }).eq("id", args.queue_id);
      return `Approved: ${queue.observation_count} observations verified.`;
    },
  },
  {
    name: "reject_document",
    description: "Reject a pending document, leaving observations unverified. Requires queue_id.",
    parameters: { type: "object", properties: { queue_id: { type: "string", description: "The UUID of the approval queue entry" } }, required: ["queue_id"] },
    destructive: true,
    execute: async (args: any) => {
      const { data: queue, error } = await supabase.from("telegram_approval_queue").select("*").eq("id", args.queue_id).single();
      if (error || !queue) return "❌ Approval record not found.";
      if (queue.status !== "pending") return "Already processed.";
      await supabase.from("telegram_approval_queue").update({ status: "rejected", resolved_at: new Date().toISOString() }).eq("id", args.queue_id);
      return `Rejected. Observations remain unverified for manual review.`;
    },
  },
  {
    name: "switch_ai_model",
    description: "Switch the active AI model between 'gemini' and 'grok'. This is only allowed when the user explicitly requests a switch.",
    parameters: { type: "object", properties: { model: { type: "string", enum: ["gemini", "grok"], description: "The model to switch to" } }, required: ["model"] },
    destructive: true,
    execute: async (args: any) => {
      const nextModel = args.model === "grok" ? "grok" : "gemini";
      await supabase.from("bot_settings").upsert({ setting_key: "ai_model", setting_value: nextModel, updated_at: new Date().toISOString() }, { onConflict: "setting_key" });
      return `Switched to ${nextModel}.`;
    },
  },
  {
    name: "list_connected_projects",
    description: "List all connected external projects with their status.",
    parameters: { type: "object", properties: {}, required: [] },
    destructive: false,
    execute: async () => {
      const projects = await getConnectedProjects();
      return JSON.stringify(projects.map((p: any) => ({ name: p.name, description: p.description, is_active: p.is_active })));
    },
  },
  {
    name: "get_project_stats",
    description: "Get table record counts from a connected project. Provide project_name or leave empty for all.",
    parameters: { type: "object", properties: { project_name: { type: "string", description: "Name of the project (partial match). Leave empty for all projects." } }, required: [] },
    destructive: false,
    execute: async (args: any) => {
      const projects = await getConnectedProjects();
      if (projects.length === 0) return "No connected projects.";
      const target = args.project_name
        ? projects.filter((p: any) => p.name.toLowerCase().includes(args.project_name.toLowerCase()))
        : projects;
      if (target.length === 0) return `No project matching "${args.project_name}".`;
      const results: any[] = [];
      for (const p of target) {
        const stats = await fetchProjectStats(p);
        results.push({ name: p.name, stats: stats?.tables || null, reachable: !!stats });
      }
      return JSON.stringify(results);
    },
  },
  {
    name: "get_recent_documents",
    description: "Get recently processed documents with their details.",
    parameters: { type: "object", properties: { limit: { type: "number", description: "Number of documents to fetch (max 20)" } }, required: [] },
    destructive: false,
    execute: async (args: any) => {
      const limit = Math.min(args.limit || 5, 20);
      const { data: docs } = await supabase
        .from("documents")
        .select("id, file_name, doc_type, bureau, status, created_at, clients(name)")
        .order("updated_at", { ascending: false })
        .limit(limit);
      return JSON.stringify(docs?.map((d: any) => ({
        id: d.id, file_name: d.file_name, doc_type: d.doc_type, bureau: d.bureau,
        status: d.status, client: (d.clients as any)?.name, created_at: d.created_at,
      })) || []);
    },
  },
  {
    name: "trigger_drive_sync",
    description: "Trigger a Google Drive sync to scan for new or updated files in the shared Drive folder. This will discover new documents and queue them for processing.",
    parameters: { type: "object", properties: {}, required: [] },
    destructive: false,
    execute: async () => {
      try {
        const ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || SUPABASE_SERVICE_ROLE_KEY;
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/drive-sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}` },
          body: JSON.stringify({}),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          return `❌ Drive sync failed (${resp.status}): ${errText}`;
        }
        const result = await resp.json();
        return `✅ Drive sync complete! Scanned ${result.folders_scanned || 0} folders, processed ${result.total_processed || 0} files, ${result.total_errors || 0} errors. Run ID: ${result.run_id}`;
      } catch (e) {
        return `❌ Drive sync error: ${String(e)}`;
      }
    },
  },
  {
    name: "list_drive_files",
    description: "List files stored in the system from Google Drive, optionally filtered by client name. Shows file name, status, type, and client.",
    parameters: { type: "object", properties: { client_name: { type: "string", description: "Filter by client name (partial match). Leave empty for all." }, status: { type: "string", description: "Filter by status: pending, processing, completed, failed. Leave empty for all." }, limit: { type: "number", description: "Number of files to return (max 50)" } }, required: [] },
    destructive: false,
    execute: async (args: any) => {
      const limit = Math.min(args.limit || 20, 50);
      let query = supabase
        .from("documents")
        .select("id, file_name, doc_type, bureau, status, mime_type, drive_file_id, created_at, updated_at, clients(name)")
        .eq("is_deleted", false)
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (args.status) query = query.eq("status", args.status);
      const { data: docs } = await query;
      let results = docs?.map((d: any) => ({
        id: d.id, file_name: d.file_name, doc_type: d.doc_type, bureau: d.bureau,
        status: d.status, mime_type: d.mime_type, client: (d.clients as any)?.name,
        created_at: d.created_at, updated_at: d.updated_at,
      })) || [];
      if (args.client_name) {
        results = results.filter((r: any) => r.client?.toLowerCase().includes(args.client_name.toLowerCase()));
      }
      if (results.length === 0) return "No files found matching your criteria.";
      return JSON.stringify(results);
    },
  },
  {
    name: "get_client_summary",
    description: "Get a summary of all clients with document counts and processing status.",
    parameters: { type: "object", properties: {}, required: [] },
    destructive: false,
    execute: async () => {
      const { data: clients } = await supabase.from("clients").select("id, name, drive_folder_id");
      if (!clients || clients.length === 0) return "No clients found.";
      const summaries = [];
      for (const client of clients) {
        const { data: docs } = await supabase.from("documents").select("id, status").eq("client_id", client.id).eq("is_deleted", false);
        const statusCounts: Record<string, number> = {};
        (docs || []).forEach((d: any) => { statusCounts[d.status] = (statusCounts[d.status] || 0) + 1; });
        summaries.push({ name: client.name, total_documents: docs?.length || 0, by_status: statusCounts });
      }
      return JSON.stringify(summaries);
    },
  },

  {
    name: "get_active_jobs_summary",
    description: "Get a structured breakdown of active (processing/queued) ingestion jobs: counts by status, job type, age buckets, top errors, and example rows. Use when the user asks 'what are the active jobs', 'describe the jobs', or 'summarize the N jobs'.",
    parameters: {
      type: "object",
      properties: {
        status_filter: { type: "string", enum: ["processing", "queued", "failed", "archived"], description: "Filter to a specific status. Default: shows processing+queued." },
        hours_back: { type: "number", description: "Only include jobs created in the last N hours. Default: 24." },
        limit: { type: "number", description: "Max example rows to return. Default: 50, max: 50." },
      },
      required: [],
    },
    destructive: false,
    execute: async (args: any) => {
      const hoursBack = args.hours_back ?? 24;
      const limit = Math.min(args.limit ?? 50, 50);
      const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

      const statusFilter: string[] = args.status_filter
        ? [args.status_filter]
        : ["processing", "queued"];

      // Main query — fetch rows (capped at limit)
      const { data: jobs, error } = await supabase
        .from("ingestion_jobs")
        .select("id, job_type, status, attempt_count, started_at, heartbeat_at, completed_at, created_at, drive_file_id, document_id, last_error")
        .in("status", statusFilter)
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) {
        const errMsg = `HARD ERROR: ingestion_jobs query failed — ${error.message}`;
        console.error("get_active_jobs_summary:", errMsg);
        return JSON.stringify({ error: errMsg });
      }

      // Total count (may exceed limit)
      const { count: totalCount, error: countErr } = await supabase
        .from("ingestion_jobs")
        .select("*", { count: "exact", head: true })
        .in("status", statusFilter)
        .gte("created_at", cutoff);

      if (countErr) {
        console.error("get_active_jobs_summary count error:", countErr.message);
      }

      const total = totalCount ?? jobs.length;
      const allJobs = jobs || [];

      // by_status
      const byStatus: Record<string, number> = { processing: 0, queued: 0, failed: 0, archived: 0 };
      for (const j of allJobs) { byStatus[j.status] = (byStatus[j.status] || 0) + 1; }

      // by_job_type
      const jobTypeCounts: Record<string, number> = {};
      for (const j of allJobs) { jobTypeCounts[j.job_type] = (jobTypeCounts[j.job_type] || 0) + 1; }
      const byJobType = Object.entries(jobTypeCounts).map(([job_type, count]) => ({ job_type, count }));

      // age_buckets based on COALESCE(heartbeat_at, started_at, created_at)
      const buckets = { "0-15m": 0, "15-60m": 0, "1-6h": 0, "6-24h": 0, "24h+": 0 };
      const now = Date.now();
      for (const j of allJobs) {
        const ref = new Date(j.heartbeat_at || j.started_at || j.created_at).getTime();
        const ageMin = (now - ref) / 60000;
        if (ageMin <= 15) buckets["0-15m"]++;
        else if (ageMin <= 60) buckets["15-60m"]++;
        else if (ageMin <= 360) buckets["1-6h"]++;
        else if (ageMin <= 1440) buckets["6-24h"]++;
        else buckets["24h+"]++;
      }
      const ageBuckets = Object.entries(buckets).map(([bucket, count]) => ({ bucket, count }));

      // top_errors (from rows that have last_error)
      const errCounts: Record<string, number> = {};
      for (const j of allJobs) {
        if (j.last_error) {
          const key = j.last_error.slice(0, 200);
          errCounts[key] = (errCounts[key] || 0) + 1;
        }
      }
      const topErrors = Object.entries(errCounts)
        .map(([last_error, count]) => ({ last_error, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      // examples (first 5 rows)
      const examples = allJobs.slice(0, 5).map((j: any) => ({
        id: j.id, job_type: j.job_type, status: j.status,
        attempt_count: j.attempt_count, started_at: j.started_at,
        heartbeat_at: j.heartbeat_at, completed_at: j.completed_at,
        drive_file_id: j.drive_file_id, document_id: j.document_id,
      }));

      return JSON.stringify({
        active_definition: "status IN (" + statusFilter.map(s => `'${s}'`).join(",") + ")",
        hours_back: hoursBack,
        total,
        by_status: byStatus,
        by_job_type: byJobType,
        age_buckets: ageBuckets,
        top_errors: topErrors,
        examples,
      });
    },
  },

  // ─── Instagram Messaging Tools ────────────────────────────────
  {
    name: "instagram_send_dm",
    description: "Send an Instagram Direct Message to a user. Requires recipient_id (Instagram-scoped user ID) and message text. [DESTRUCTIVE - requires user confirmation]",
    parameters: { type: "object", properties: { recipient_id: { type: "string", description: "Instagram-scoped user ID (IGSID) of the recipient" }, message: { type: "string", description: "The message text to send" } }, required: ["recipient_id", "message"] },
    destructive: true,
    execute: async (args: any) => {
      const ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || SUPABASE_SERVICE_ROLE_KEY;
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/instagram-messaging`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}` },
        body: JSON.stringify({ action: "send_dm", recipient_id: args.recipient_id, message: args.message }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) return `❌ DM failed: ${data.error || "Unknown error"}`;
      return `✅ Instagram DM sent to ${args.recipient_id}.`;
    },
  },
  {
    name: "instagram_reply_comment",
    description: "Reply to a comment on an Instagram post. Requires comment_id and reply_text. [DESTRUCTIVE - requires user confirmation]",
    parameters: { type: "object", properties: { comment_id: { type: "string", description: "The ID of the Instagram comment to reply to" }, reply_text: { type: "string", description: "The reply text" } }, required: ["comment_id", "reply_text"] },
    destructive: true,
    execute: async (args: any) => {
      const ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || SUPABASE_SERVICE_ROLE_KEY;
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/instagram-messaging`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}` },
        body: JSON.stringify({ action: "reply_comment", comment_id: args.comment_id, reply_text: args.reply_text }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) return `❌ Comment reply failed: ${data.error || "Unknown error"}`;
      return `✅ Replied to Instagram comment ${args.comment_id}.`;
    },
  },
  {
    name: "instagram_reply_story_mention",
    description: "Reply to someone who mentioned you in their Instagram story via DM. Requires recipient_id and message. [DESTRUCTIVE - requires user confirmation]",
    parameters: { type: "object", properties: { recipient_id: { type: "string", description: "Instagram-scoped user ID of the person who mentioned you" }, message: { type: "string", description: "The reply message" } }, required: ["recipient_id", "message"] },
    destructive: true,
    execute: async (args: any) => {
      const ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || SUPABASE_SERVICE_ROLE_KEY;
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/instagram-messaging`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}` },
        body: JSON.stringify({ action: "reply_story_mention", recipient_id: args.recipient_id, message: args.message }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) return `❌ Story mention reply failed: ${data.error || "Unknown error"}`;
      return `✅ Replied to story mention from ${args.recipient_id}.`;
    },
  },
  {
    name: "instagram_get_recent_comments",
    description: "Fetch recent comments on your latest Instagram posts to see what people are saying.",
    parameters: { type: "object", properties: {}, required: [] },
    destructive: false,
    execute: async () => {
      const ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || SUPABASE_SERVICE_ROLE_KEY;
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/instagram-messaging`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}` },
        body: JSON.stringify({ action: "get_recent_comments" }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) return `❌ Could not fetch comments: ${data.error || "Unknown error"}`;
      return JSON.stringify(data.data);
    },
  },
  {
    name: "instagram_get_conversations",
    description: "List recent Instagram DM conversations with latest messages.",
    parameters: { type: "object", properties: {}, required: [] },
    destructive: false,
    execute: async () => {
      const ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || SUPABASE_SERVICE_ROLE_KEY;
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/instagram-messaging`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}` },
        body: JSON.stringify({ action: "get_conversations" }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) return `❌ Could not fetch conversations: ${data.error || "Unknown error"}`;
      return JSON.stringify(data.data);
    },
  },
  {
    name: "ingest_drive_clients" as const,
    description: "Scans Google Drive for all client folders, reads every document, extracts forensic credit timeline events using AI, and imports them into Credit Guardian. WRITE operation — always call propose_plan first in autonomous mode.",
    destructive: false,
    parameters: {
      type: "object" as const,
      properties: {
        client_name: {
          type: "string",
          description: "Optional: only process one specific client folder by name. Omit to process all clients.",
        },
      },
      required: [],
    },
    execute: async (args: { client_name?: string }) => {
      const INGEST_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/ingest-drive-clients`;
      const resp = await fetch(INGEST_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ client_name: args.client_name }),
      });
      if (!resp.ok) throw new Error(`Drive ingestion failed: ${resp.status} — ${await resp.text()}`);
      return JSON.stringify(await resp.json());
    },
  },
  {
    name: "query_credit_guardian" as const,
    description:
      "Read-only query of Fairway Fixer (Credit Guardian) via cross-project-api. Uses get_clients, get_client_detail (includes timeline events), get_documents, get_recent_activity. For legacy prompts, session_id is treated as Fairway client UUID.",
    destructive: false,
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: [
            "get_clients",
            "get_client_detail",
            "get_documents",
            "get_recent_activity",
            "get_assessments",
            "get_timeline_events",
            "get_assessment_detail",
            "get_report",
          ],
          description:
            "Fairway actions: get_clients, get_client_detail, get_documents, get_recent_activity. Legacy names map to get_clients or get_client_detail (use client_id).",
        },
        client_id: {
          type: "string",
          description: "Fairway client UUID — required for get_client_detail, get_documents; optional filter for get_recent_activity.",
        },
        session_id: {
          type: "string",
          description: "Alias for client_id (legacy). Used when client_id omitted.",
        },
        limit: { type: "number", description: "For get_recent_activity (max 100)." },
      },
      required: ["action"],
    },
    execute: async (args: {
      action: string;
      client_id?: string;
      session_id?: string;
      limit?: number;
    }) => {
      const cid = args.client_id || args.session_id;
      let body: Record<string, unknown>;

      switch (args.action) {
        case "get_clients":
        case "get_assessments":
          body = { action: "get_clients" };
          break;
        case "get_timeline_events":
        case "get_assessment_detail":
        case "get_report":
        case "get_client_detail":
          if (!cid) {
            throw new Error("client_id or session_id (Fairway client UUID) required for this action");
          }
          body = { action: "get_client_detail", params: { client_id: cid } };
          break;
        case "get_documents":
          if (!cid) throw new Error("client_id or session_id required");
          body = { action: "get_documents", params: { client_id: cid } };
          break;
        case "get_recent_activity": {
          const params: Record<string, unknown> = {};
          if (typeof args.limit === "number") params.limit = args.limit;
          if (cid) params.client_id = cid;
          body = { action: "get_recent_activity", params };
          break;
        }
        default:
          throw new Error(`Unknown action: ${args.action}`);
      }

      const resp = await fetchCreditGuardian(body);
      const text = await resp.text();
      if (!resp.ok) throw new Error(`Credit Guardian query failed: ${resp.status} — ${text.slice(0, 300)}`);
      return text;
    },
  },
  {
    name: "query_credit_compass" as const,
    description:
      "Query Credit Compass (same Supabase/Lovable project as Credit Guardian — GitHub: fairway-fixer-18; Lovable may show the Credit Compass name) for credit assessment data, client records, dispute sessions, and strategy context. Use when the user asks about credit assessments, battle plans, or Credit Compass specifically.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: [
            "get_clients",
            "get_client_detail",
            "get_assessment",
            "create_assessment",
            "get_dispute_letters",
            "generate_dispute_letters",
          ],
          description: "The Credit Compass action to perform",
        },
        client_name: {
          type: "string",
          description: "Client name to look up",
        },
        client_id: {
          type: "string",
          description: "Client ID for specific record lookups",
        },
        assessment_id: {
          type: "string",
          description: "Assessment ID for detailed queries",
        },
      },
      required: ["action"],
    },
    destructive: false,
    execute: async (params: {
      action: string;
      client_name?: string;
      client_id?: string;
      assessment_id?: string;
    }) => {
      const { action, client_name, client_id, assessment_id } = params;
      // Credit Compass = fairway-fixer-18 / Credit Guardian (same project); Lovable display name may say Credit Compass.
      // Secrets: often same host as CREDIT_GUARDIAN_URL. This path uses Bearer → control-center-api (legacy shape).
      // Fairway’s control-center-api handler is the same as cross-project-api and expects x-api-key — if CREDIT_COMPASS_URL
      // points at Fairway and you get 401, align with CREDIT_GUARDIAN_KEY or refactor this tool to fetchCreditGuardian().
      const CREDIT_COMPASS_URL = Deno.env.get("CREDIT_COMPASS_URL");
      if (!CREDIT_COMPASS_URL) {
        return JSON.stringify({ error: "CREDIT_COMPASS_URL secret is not set in this project" });
      }
      // Service role or shared secret for the Credit Compass / Fairway project (CREDIT_COMPASS_KEY in CC Edge secrets).
      const compassKey = Deno.env.get("CREDIT_COMPASS_KEY") ?? "";
      if (!compassKey) {
        return JSON.stringify({
          error:
            "CREDIT_COMPASS_KEY is not set — add it to Control Center Edge Function secrets",
        });
      }
      try {
        const resp = await fetch(`${CREDIT_COMPASS_URL}/functions/v1/control-center-api`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${compassKey}`,
          },
          body: JSON.stringify({ action, client_name, client_id, assessment_id }),
        });
        if (!resp.ok) {
          return JSON.stringify({
            error: `Credit Compass returned ${resp.status}`,
            detail: (await resp.text()).slice(0, 2000),
          });
        }
        return JSON.stringify(await resp.json());
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `Failed to reach Credit Compass: ${msg}` });
      }
    },
  },
  {
    name: "query_cc_tax" as const,
    description:
      "Query CC Tax (taxgenerator project) for tax data — workflow status, tax year configuration, documents, transactions, evidence, invoices, income reconciliation, and discrepancies. Use when the user asks about tax filings, tax year progress, tax documents, expenses, or anything CC Tax-related.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: [
            "get_workflow_status",
            "get_year_config",
            "get_documents",
            "get_transactions",
            "get_evidence",
            "get_invoices",
            "get_reconciliations",
            "get_discrepancies",
            "get_pl_report",
          ],
          description: "The CC Tax action to perform",
        },
        tax_year: {
          type: "number",
          description: "The tax year to query (e.g. 2024). Defaults to current/most recent year if omitted.",
        },
        status_filter: {
          type: "string",
          description: "Optional filter — e.g. 'unresolved', 'missing', 'critical', 'pending'",
        },
        limit: {
          type: "number",
          description: "Max number of records to return (default 20)",
        },
      },
      required: ["action"],
    },
    destructive: false,
    execute: async (params: {
      action: string;
      tax_year?: number;
      status_filter?: string;
      limit?: number;
    }) => {
      const { action, tax_year, status_filter, limit } = params;
      const CC_TAX_URL = Deno.env.get("CC_TAX_URL");
      if (!CC_TAX_URL) {
        return JSON.stringify({
          error: "CC_TAX_URL secret is not set in this project. CC Tax integration is not yet connected.",
        });
      }
      const ccTaxKey = Deno.env.get("CC_TAX_KEY") ?? "";
      if (!ccTaxKey) {
        return JSON.stringify({
          error: "CC_TAX_KEY is not set — add taxgenerator service role to Control Center Edge Function secrets",
        });
      }
      try {
        const resp = await fetch(`${CC_TAX_URL}/functions/v1/control-center-api`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ccTaxKey}`,
          },
          body: JSON.stringify({ action, tax_year, status_filter, limit }),
        });
        if (!resp.ok) {
          return JSON.stringify({
            error: `CC Tax returned ${resp.status}`,
            detail: (await resp.text()).slice(0, 2000),
          });
        }
        return JSON.stringify(await resp.json());
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `Failed to reach CC Tax: ${msg}` });
      }
    },
  },
  {
    name: "scan_drive_overview" as const,
    description: "Read-only scan of Google Drive client folders. Returns client names, file counts, and file types — does NOT read file contents. Call this first in autonomous mode to understand what's in Drive. Safe to call without approval.",
    destructive: false,
    parameters: {
      type: "object" as const,
      properties: {},
      required: [],
    },
    execute: async () => {
      const GOOGLE_API_KEY = Deno.env.get("Google_Cloud_Key")!;
      const rawFolder = Deno.env.get("DRIVE_FOLDER_ID")!;
      const rootFolderId = rawFolder.includes("/folders/")
        ? rawFolder.split("/folders/").pop()!.split("?")[0]
        : rawFolder;
      const q = `'${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      const foldersResp = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&key=${GOOGLE_API_KEY}`
      );
      if (!foldersResp.ok) throw new Error(`Drive API error: ${foldersResp.status}`);
      const { files: clientFolders } = await foldersResp.json();
      const overview: Array<{ client: string; folder_id: string; file_count: number; file_types: string[] }> = [];
      for (const folder of (clientFolders || []).slice(0, 30)) {
        const filesQ = `'${folder.id}' in parents and trashed = false`;
        const filesResp = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(filesQ)}&fields=files(id,name,mimeType)&key=${GOOGLE_API_KEY}`
        );
        const { files } = await filesResp.json();
        const fileList: any[] = files || [];
        const mimeShort = (m: string) =>
          m.includes("google-apps.document") ? "Google Doc"
          : m.includes("google-apps.spreadsheet") ? "Sheet"
          : m.includes("pdf") ? "PDF"
          : m.includes("word") ? "Word"
          : "Other";
        overview.push({
          client: folder.name,
          folder_id: folder.id,
          file_count: fileList.length,
          file_types: [...new Set(fileList.map(f => mimeShort(f.mimeType)))] as string[],
        });
      }
      return JSON.stringify({ total_clients: clientFolders?.length ?? 0, clients: overview });
    },
  },
  {
    name: "propose_plan" as const,
    description: "MANDATORY before any write operation in autonomous mode. Presents a step-by-step plan to the user via Telegram and waits for approval. After calling this you MUST stop — do not call any write tools until the user sends an approval word in their next message.",
    destructive: false,
    parameters: {
      type: "object" as const,
      properties: {
        goal: { type: "string", description: "One sentence: what you are trying to accomplish." },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "Ordered list of actions you will take.",
        },
        reads: {
          type: "array",
          items: { type: "string" },
          description: "Data sources you will read from.",
        },
        writes: {
          type: "array",
          items: { type: "string" },
          description: "Systems you will write to. Empty if read-only.",
        },
        risk_level: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "low=read-only. medium=writes new data. high=modifies existing data.",
        },
      },
      required: ["goal", "steps", "risk_level"],
    },
    execute: async (args: {
      goal: string;
      steps: string[];
      reads?: string[];
      writes?: string[];
      risk_level: "low" | "medium" | "high";
    }) => {
      const riskEmoji = { low: "🟢", medium: "🟡", high: "🔴" }[args.risk_level] ?? "⚪";
      const stepsList = (args.steps || []).map((s, i) => `  ${i + 1}. ${s}`).join("\n");
      const readsList = args.reads?.length ? `\n📖 *Reads:* ${args.reads.join(", ")}` : "";
      const writesList = args.writes?.length ? `\n✏️ *Writes to:* ${args.writes.join(", ")}` : "";
      const planMsg = [
        `🤖 *Autonomous Plan* — ${riskEmoji} ${args.risk_level.toUpperCase()} risk`,
        ``,
        `*Goal:* ${args.goal}`,
        ``,
        `*Steps:*`,
        stepsList,
        readsList,
        writesList,
        ``,
        `Reply *yes*, *go*, or *approved* to execute.`,
        `Reply *no* or *cancel* to abort.`,
      ].join("\n");
      const planId = crypto.randomUUID();
      await supabase.from("bot_settings").upsert(
        {
          setting_key: `pending_plan:${planId}`,
          setting_value: JSON.stringify({ goal: args.goal, steps: args.steps, planId, created_at: new Date().toISOString() }),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "setting_key" }
      );
      return JSON.stringify({
        plan_presented: true,
        plan_id: planId,
        telegram_message: planMsg,
        awaiting_approval: true,
        instruction: "Send telegram_message to the user via sendMessage and STOP. Do NOT call any write tools. Wait for user approval.",
      });
    },
  },
  {
    name: "find_playlist_opportunities",
    description:
      "Research playlist opportunities for a track (FanFuel Hub). If the user has not confirmed a vibe yet, the tool will ask them to confirm in Telegram — do not invent results. When the user already confirmed or provided a vibe, pass user_vibe.",
    parameters: {
      type: "object",
      properties: {
        track_name: {
          type: "string",
          description:
            "Track title to research. Omit if the user already named the track in the message — the tool infers from the user message and conversation.",
        },
        user_vibe: {
          type: "string",
          description:
            "Optional. Confirmed vibe (e.g. west coast chill). Omit on first call if unknown — user will confirm in chat.",
        },
      },
      required: [] as string[],
    },
    destructive: false,
    execute: async (args: { track_name?: string; user_vibe?: string }, context?: ToolExecuteContext) => {
      const trackName = await resolvePlaylistTrackName(args, context);
      const explicitVibe = args?.user_vibe?.trim();

      if (!trackName) {
        return [
          `🎧 *Playlist opportunities*`,
          ``,
          `I couldn’t detect a track name from your message.`,
          `Try: \`/do find_playlist_opportunities\` with the track (e.g. *Meditate by Fendi Frost*) or name the track in your next message.`,
        ].join("\n");
      }

      if (explicitVibe) {
        return await runPlaylistHubResearch(trackName, explicitVibe, context?.chatId);
      }

      const chatId = context?.chatId;
      if (!chatId) {
        const inferred = inferVibeFromTrack(trackName);
        return await runPlaylistHubResearch(trackName, inferred);
      }

      const inferred = inferVibeFromTrack(trackName);
      await setPlaylistConfirm(chatId, {
        track_name: trackName,
        inferred_vibe: inferred,
        created_at: new Date().toISOString(),
      });

      return [
        `🎧 *Confirm vibe before playlist search*`,
        ``,
        `Track: *${trackName}*`,
        `Suggested vibe: *${inferred}*`,
        ``,
        `Reply *yes*, *y*, or *ok* to use this vibe, or type your own vibe in one message.`,
        `Send *cancel* to abort.`,
      ].join("\n");
    },
  },
  {
    name: "get_pitch_report",
    description: "Get a report of all playlist pitches sent, replied, and placed.",
    parameters: { type: "object", properties: { track_name: { type: "string" } }, required: [] },
    destructive: false,
    execute: async (args: { track_name?: string }) => {
      const result = await callFanFuelHub("pitch-status", { track_name: args?.track_name ?? "" });
      const entries = result?.entries ?? [];
      if (!Array.isArray(entries) || entries.length === 0) return "No pitches logged yet.";
      const lines = entries.slice(0, 25).map((p: any) =>
        `• ${p.playlist_id} — ${p.track_name} — ${p.status} (${p.method ?? "?"})`
      ).join("\n");
      const cap = result?.summary?.email_pitches_last_24h;
      const capLine = typeof cap === "number" ? `\nEmail pitches (last 24h): ${cap}/10` : "";
      return `Pitch log (${entries.length} shown):\n\n${lines}${capLine}`;
    },
  },
  {
    name: "send_playlist_pitch",
    description: "Execute one pitch for a playlist via FanFuel Hub (email or instructions). Pass playlist_id and track_name.",
    parameters: {
      type: "object",
      properties: {
        playlist_id: { type: "string" },
        track_name: { type: "string" },
        tier_confirmed: { type: "boolean", description: "Set true if user confirmed a tier-3 target." },
      },
      required: ["playlist_id", "track_name"],
    },
    destructive: true,
    execute: async (args: any) => {
      const res = await callFanFuelHub("execute-pitch", {
        playlist_id: args.playlist_id,
        track_name: args.track_name,
        tier_confirmed: Boolean(args.tier_confirmed),
      });
      return typeof res?.message_to_user === "string" ? res.message_to_user : JSON.stringify(res ?? {});
    },
  },
  {
    name: "update_pitch_status",
    description: "Update curator response for a pitch (responded or rejected) in pitch_log.",
    parameters: {
      type: "object",
      properties: {
        playlist_id: { type: "string" },
        playlist_name: { type: "string", description: "If playlist_id unknown, pass name to resolve." },
        track_name: { type: "string" },
        status: { type: "string", description: "responded | rejected" },
        notes: { type: "string" },
      },
      required: ["track_name", "status"],
    },
    destructive: false,
    execute: async (args: any) => {
      const res = await callFanFuelHub("update-pitch-status", {
        playlist_id: args.playlist_id,
        playlist_name: args.playlist_name,
        track_name: args.track_name,
        status: args.status,
        notes: args.notes,
      });
      return typeof res?.message_to_user === "string" ? res.message_to_user : JSON.stringify(res ?? {});
    },
  },
];

// ─── Build tool schemas for AI models ───────────────────────────

function getToolsForWorkflow(workflowKey: string): ToolDef[] {
  // Find the workflow's declared tools from the registry cache or AGENT_TOOLS
  // This is called after fetchWorkflowRegistry, so we filter AGENT_TOOLS by the workflow's tool list
  return AGENT_TOOLS; // Filtered at call site using workflowToolNames
}

function getGeminiToolDeclarations(allowedToolNames?: string[]) {
  const tools = allowedToolNames
    ? AGENT_TOOLS.filter(t => allowedToolNames.includes(t.name))
    : AGENT_TOOLS;
  return tools.map(t => ({
    name: t.name,
    description: t.description + (t.destructive ? " [DESTRUCTIVE - requires user confirmation]" : ""),
    parameters: t.parameters,
  }));
}

function getGrokToolSchemas(allowedToolNames?: string[]) {
  const tools = allowedToolNames
    ? AGENT_TOOLS.filter(t => allowedToolNames.includes(t.name))
    : AGENT_TOOLS;
  return tools.map(t => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description + (t.destructive ? " [DESTRUCTIVE - requires user confirmation]" : ""),
      parameters: t.parameters,
    },
  }));
}

// ─── Pending confirmations store (in-memory per invocation, persisted via DB) ──
// We'll store pending actions in bot_settings with a special key pattern

async function storePendingAction(actionId: string, toolName: string, args: any) {
  await supabase.from("bot_settings").upsert({
    setting_key: `pending_action:${actionId}`,
    setting_value: JSON.stringify({ tool: toolName, args }),
    updated_at: new Date().toISOString(),
  }, { onConflict: "setting_key" });
}

async function getPendingAction(actionId: string): Promise<{ tool: string; args: any } | null> {
  const { data } = await supabase
    .from("bot_settings")
    .select("setting_value")
    .eq("setting_key", `pending_action:${actionId}`)
    .single();
  if (!data) return null;
  try { return JSON.parse(data.setting_value); } catch { return null; }
}

async function deletePendingAction(actionId: string) {
  await supabase.from("bot_settings").delete().eq("setting_key", `pending_action:${actionId}`);
}

// ─── Playlist vibe confirmation (two-step) — persisted per chat ───
function playlistConfirmKey(chatId: string): string {
  return `playlist_confirm:${chatId}`;
}

interface PlaylistConfirmState {
  track_name: string;
  inferred_vibe: string;
  created_at: string;
}

async function getPlaylistConfirm(chatId: string): Promise<PlaylistConfirmState | null> {
  const { data } = await supabase
    .from("bot_settings")
    .select("setting_value")
    .eq("setting_key", playlistConfirmKey(chatId))
    .maybeSingle();
  if (!data?.setting_value) return null;
  try {
    return JSON.parse(data.setting_value) as PlaylistConfirmState;
  } catch {
    return null;
  }
}

async function setPlaylistConfirm(chatId: string, state: PlaylistConfirmState): Promise<void> {
  await supabase.from("bot_settings").upsert(
    {
      setting_key: playlistConfirmKey(chatId),
      setting_value: JSON.stringify(state),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "setting_key" },
  );
}

async function clearPlaylistConfirm(chatId: string): Promise<void> {
  await supabase.from("bot_settings").delete().eq("setting_key", playlistConfirmKey(chatId));
}

// ─── Last playlist research (pitch report / pitch N) ─────────────────
type LastPlaylistResearch = {
  track_name: string;
  user_vibe: string;
  ranked_playlist_ids: string[];
  ts: string;
};

function lastPlaylistResearchKey(chatId: string): string {
  return `last_playlist_research:${chatId}`;
}

function pendingPitchBulkKey(chatId: string): string {
  return `pending_pitch_bulk:${chatId}`;
}

function pendingPitchTier3Key(chatId: string): string {
  return `pending_pitch_tier3:${chatId}`;
}

async function saveLastPlaylistResearch(chatId: string, data: LastPlaylistResearch): Promise<void> {
  await supabase.from("bot_settings").upsert(
    {
      setting_key: lastPlaylistResearchKey(chatId),
      setting_value: JSON.stringify(data),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "setting_key" },
  );
}

async function getLastPlaylistResearch(chatId: string): Promise<LastPlaylistResearch | null> {
  const { data } = await supabase
    .from("bot_settings")
    .select("setting_value")
    .eq("setting_key", lastPlaylistResearchKey(chatId))
    .maybeSingle();
  if (!data?.setting_value) return null;
  try {
    const p = JSON.parse(data.setting_value);
    if (p && typeof p.track_name === "string" && Array.isArray(p.ranked_playlist_ids)) {
      return p as LastPlaylistResearch;
    }
  } catch { /* ignore */ }
  return null;
}

type PendingPitchBulk = { track_name: string; playlist_ids: string[]; ts: string };
type PendingPitchTier3 = { playlist_id: string; track_name: string; ts: string };

async function setPendingPitchBulk(chatId: string, state: PendingPitchBulk): Promise<void> {
  await supabase.from("bot_settings").upsert(
    {
      setting_key: pendingPitchBulkKey(chatId),
      setting_value: JSON.stringify(state),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "setting_key" },
  );
}

async function getPendingPitchBulk(chatId: string): Promise<PendingPitchBulk | null> {
  const { data } = await supabase
    .from("bot_settings")
    .select("setting_value")
    .eq("setting_key", pendingPitchBulkKey(chatId))
    .maybeSingle();
  if (!data?.setting_value) return null;
  try {
    const p = JSON.parse(data.setting_value);
    if (p?.track_name && Array.isArray(p.playlist_ids)) return p as PendingPitchBulk;
  } catch { /* ignore */ }
  return null;
}

async function clearPendingPitchBulk(chatId: string): Promise<void> {
  await supabase.from("bot_settings").delete().eq("setting_key", pendingPitchBulkKey(chatId));
}

async function setPendingPitchTier3(chatId: string, state: PendingPitchTier3): Promise<void> {
  await supabase.from("bot_settings").upsert(
    {
      setting_key: pendingPitchTier3Key(chatId),
      setting_value: JSON.stringify(state),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "setting_key" },
  );
}

async function getPendingPitchTier3(chatId: string): Promise<PendingPitchTier3 | null> {
  const { data } = await supabase
    .from("bot_settings")
    .select("setting_value")
    .eq("setting_key", pendingPitchTier3Key(chatId))
    .maybeSingle();
  if (!data?.setting_value) return null;
  try {
    const p = JSON.parse(data.setting_value);
    if (p?.playlist_id && p?.track_name) return p as PendingPitchTier3;
  } catch { /* ignore */ }
  return null;
}

async function clearPendingPitchTier3(chatId: string): Promise<void> {
  await supabase.from("bot_settings").delete().eq("setting_key", pendingPitchTier3Key(chatId));
}

const NON_BULK_PITCH_METHODS = new Set(["algorithmic", "distributor_pitch"]);

async function hubPlaylistBatch(playlistIds: string[]): Promise<any[]> {
  if (!playlistIds.length) return [];
  const r = await callFanFuelHub("playlist-batch", { playlist_ids: playlistIds });
  return Array.isArray(r?.playlists) ? r.playlists : [];
}

/** Heuristic vibe label from track title (no external API). */
function inferVibeFromTrack(trackName: string): string {
  const t = (trackName || "").toLowerCase();
  if (/meditat|zen|calm|peace|sleep|ambient|lofi/.test(t)) return "calm / chill / ambient-adjacent";
  if (/grind|hustle|motivat|money|boss/.test(t)) return "motivational hip-hop / street energy";
  if (/love|heart|soul|slow/.test(t)) return "R&B / soulful / late-night";
  return "West Coast hip-hop / smooth soulful lane (Larry June–adjacent)";
}

/**
 * Calls FanFuel Hub playlist research. Prefer the dedicated `playlist-research` edge function with body
 * `{ track_name, user_vibe }` only — do NOT route this through control-center-api using the tool name as
 * `action` (Hub reports "Unknown action: findplaylistopportunities" when misrouted).
 * Override edge name with FANFUEL_HUB_PLAYLIST_FN if your project uses a different function name.
 */
async function runPlaylistHubResearch(trackName: string, userVibe: string, chatId?: string): Promise<string> {
  const body = { track_name: trackName, user_vibe: userVibe };
  const edgeName = (Deno.env.get("FANFUEL_HUB_PLAYLIST_FN") || "playlist-research").trim();

  let result: any;
  try {
    result = await callFanFuelHub(edgeName, body);
  } catch (e1) {
    const m = e1 instanceof Error ? e1.message : String(e1);
    // Some Hub deployments only expose playlist via control-center-api with a fixed action name.
    if (/404|not found|Unknown action|FunctionsHttpError|502|503/i.test(m)) {
      try {
        result = await callFanFuelHub("control-center-api", {
          action: "playlist_research",
          track_name: trackName,
          user_vibe: userVibe,
        });
      } catch {
        console.error("[runPlaylistHubResearch] primary failed:", m, "fallback playlist_research failed");
        throw e1;
      }
    } else {
      throw e1;
    }
  }

  if (result?.playlists && Array.isArray(result.playlists) && result.playlists.length > 0) {
    const rankedIds = result.playlists.map((p: { playlist_id?: string }) => p.playlist_id).filter(Boolean) as string[];
    if (chatId && rankedIds.length > 0) {
      await saveLastPlaylistResearch(chatId, {
        track_name: trackName,
        user_vibe: userVibe,
        ranked_playlist_ids: rankedIds,
        ts: new Date().toISOString(),
      });
    }
    const lines = result.playlists
      .slice(0, 20)
      .map((p: any, i: number) => {
        const mid =
          p.followers_label ??
          (typeof p.followers === "number"
            ? p.followers.toLocaleString()
            : p.follower_count != null
              ? p.follower_count.toLocaleString()
              : "?");
        const suffix = mid === "editorial" || mid === "N/A" ? "" : " followers";
        return `${i + 1}. ${p.name ?? p.playlist_name} — ${mid}${suffix}`;
      })
      .join("\n");
    return `Found ${result.playlists.length} playlist opportunities for "${trackName}":\n\n${lines}`;
  }
  return `Playlist research complete for "${trackName}" (vibe: ${userVibe}). Results stored. Check back with "show pitch report".`;
}

/** Infer track title from /do text + recent chat (so /do find_playlist_opportunities still works). */
function extractPlaylistTrackName(userMessage: string, conversationContext: string): string | null {
  const combined = `${userMessage}\n${conversationContext}`;
  // "Title by Artist" (e.g. Meditate by Fendi Frost)
  const byMatch = combined.match(/\b([A-Za-z0-9][^\n]{0,100}?)\s+by\s+[A-Za-z]/i);
  if (byMatch) {
    const t = byMatch[1].trim().replace(/^["']|["']$/g, "");
    if (t.length >= 1 && t.length <= 120) return t;
  }
  // "... for Meditate" / "for TRACK" (end of line, comma, or before by)
  const forMatch = userMessage.match(
    /(?:for|about)\s+["']?([^"'\n]+?)["']?(?:\s+by|\s*$|,)/i,
  );
  if (forMatch) {
    const t = forMatch[1].trim();
    if (t.length >= 1 && t.length <= 120 && !/^(me|the|a|an)$/i.test(t)) return t;
  }
  const opp = combined.match(
    /playlist\s+opportunities?\s+for\s+["']?([^"'\n]+?)["']?(?:\s+by|\s*$|,|\s+)/i,
  );
  if (opp) {
    const t = opp[1].trim();
    if (t.length >= 1 && t.length <= 120) return t;
  }
  const opp2 = combined.match(/find\s+playlist\s+opportunities\s+for\s+["']?([^"'\n]+?)["']?/i);
  if (opp2) {
    const t = opp2[1].trim();
    if (t.length >= 1 && t.length <= 120) return t;
  }
  return null;
}

/** Resolve track title for find_playlist_opportunities when the model omits or sends placeholder track_name. */
async function resolvePlaylistTrackName(
  args: { track_name?: string; user_vibe?: string },
  context?: ToolExecuteContext,
): Promise<string> {
  let raw = (args?.track_name || "").trim();
  if (raw && !/^unknown$/i.test(raw) && raw.toLowerCase() !== "unknown track") {
    return raw;
  }
  const um = context?.userMessage || "";
  const cc = context?.conversationContext || "";
  const fromExtract = extractPlaylistTrackName(um, cc);
  if (fromExtract) return fromExtract;
  if (context?.chatId) {
    const conv = cc || (await buildConversationContext(context.chatId));
    const fromConv = extractPlaylistTrackName(um, conv);
    if (fromConv) return fromConv;
  }
  return "";
}

function playlistWorkflowSystemAddendum(): string {
  return `
PLAYLIST WORKFLOW (ACTIVE — this run is restricted to find_playlist_opportunities):
- You MUST call the tool find_playlist_opportunities with track_name set to a real song title.
- If the user only sent a workflow key (e.g. "find_playlist_opportunities"), infer track_name from the Conversation Context below (e.g. messages like "Meditate by Fendi Frost" → track_name "Meditate").
- Do NOT refuse. Do NOT say you have no tool — find_playlist_opportunities IS available in this workflow.
- If track_name is truly impossible to infer, call find_playlist_opportunities with track_name "unknown" and the tool will prompt the user.
`;
}

// ─── Agentic AI call with tool use ─────────────────────────────

async function agenticGeminiCall(
  userMessage: string,
  docContext: string,
  conversationContext: string,
  allowedToolNames?: string[],
  workflowKey?: string,
): Promise<{ text: string; toolCalls: Array<{ name: string; args: any }> }> {
  const playlistBlock = workflowKey === "find_playlist_opportunities" ? playlistWorkflowSystemAddendum() : "";
  const systemPrompt = `You are the ${SYSTEM_IDENTITY}. You serve Fendi Frost as a personal command center assistant.
${playlistBlock}
CRITICAL RULES — MANDATORY:
1. NO TOOL, NO CLAIM: You MUST use your available tools to fulfill requests. NEVER describe what you would do — actually call the function. If the user asks to see comments, call the tool. Do NOT respond with text saying "I'll do X" without calling the corresponding function.
2. NO WORKFLOW, NO ACTION: If the user's request does not correspond to ANY of your available tools, respond with a short message suggesting they run /workflows to see available commands. Never invent workflows.
3. EVIDENCE OVER CLAIMS: All data must come from tool calls. Never invent counts, names, or metrics.
4. For destructive actions (retry, archive, approve, reject, Instagram DMs/replies), ALWAYS call the tool — the system will handle confirmation.

Available capabilities via tools:
- System status, job management (active jobs summary, failed jobs), document approvals
- Instagram: send DMs, reply to comments, reply to story mentions, view conversations & comments
- Drive sync, file listing, client summaries
- Connected project stats
- FanFuel / playlists: find_playlist_opportunities (research playlists for a track — FanFuel Hub)

Be concise, professional, and use emoji sparingly.

Recent Documents Context:
${docContext}

Conversation Context (shared across all models):
${conversationContext}`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        tools: [{ functionDeclarations: getGeminiToolDeclarations(allowedToolNames) }],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        generationConfig: { maxOutputTokens: 1024 },
      }),
    }
  );

  if (!resp.ok) {
    console.error("Gemini agentic error:", resp.status, await resp.text());
    return { text: "⚠️ AI unavailable. Try again shortly.", toolCalls: [] };
  }

  const data = await resp.json();
  const parts = data.candidates?.[0]?.content?.parts || [];

  const toolCalls: Array<{ name: string; args: any }> = [];
  let textResponse = "";

  for (const part of parts) {
    if (part.functionCall) {
      toolCalls.push({ name: part.functionCall.name, args: part.functionCall.args || {} });
    }
    if (part.text) {
      textResponse += part.text;
    }
  }

  return { text: textResponse, toolCalls };
}

async function agenticGrokCall(
  userMessage: string,
  docContext: string,
  conversationContext: string,
  allowedToolNames?: string[],
  workflowKey?: string,
): Promise<{ text: string; toolCalls: Array<{ name: string; args: any }> }> {
  const isAutonomousLane = workflowKey === "free_agent";
  const autonomousPrefix = isAutonomousLane
    ? `🤖 AUTONOMOUS AGENT MODE ACTIVE
You have full tool access. Your rules:
READ tools — run immediately, no approval needed:
  • scan_drive_overview
  • query_credit_guardian
  • get_system_status, list_failed_jobs, list_pending_approvals, list_connected_projects
WRITE tools — ALWAYS call propose_plan first, then STOP:
  • ingest_drive_clients
WORKFLOW:
1. Call scan_drive_overview and/or query_credit_guardian to understand current state
2. If a write is needed: call propose_plan with your full plan and STOP
3. After user sends an approval word (yes/go/approved/confirmed), execute the plan step by step
4. Send short progress updates as you work
5. Send a clear summary when done
Systems:
  • Google Drive → client folders with dispute documents
  • Credit Guardian → dispute sessions, accounts, timeline events
  • Fendi Control Center → tasks, jobs, settings
HARD RULE: propose_plan MUST be called before ingest_drive_clients. After calling propose_plan you MUST stop.
`
    : "";
  const playlistBlock = workflowKey === "find_playlist_opportunities" ? playlistWorkflowSystemAddendum() : "";
  const systemPrompt = `${autonomousPrefix}${playlistBlock}You are the ${SYSTEM_IDENTITY}. You serve Fendi Frost as a personal command center assistant.

CRITICAL RULES — MANDATORY:
1. NO TOOL, NO CLAIM: You MUST use your available tools to fulfill requests. NEVER describe what you would do — actually call the function. If the user asks to see comments, call the tool. Do NOT respond with text saying "I'll do X" without calling the corresponding function.
2. NO WORKFLOW, NO ACTION: If the user's request does not correspond to ANY of your available tools, respond with a short message suggesting they run /workflows to see available commands. Never invent workflows.
3. EVIDENCE OVER CLAIMS: All data must come from tool calls. Never invent counts, names, or metrics.
4. For destructive actions (retry, archive, approve, reject, Instagram DMs/replies), ALWAYS call the tool — the system will handle confirmation.

Available capabilities via tools:
- System status, job management (active jobs summary, failed jobs), document approvals
- Instagram: send DMs, reply to comments, reply to story mentions, view conversations & comments
- Drive sync, file listing, client summaries
- Connected project stats
- FanFuel / playlists: find_playlist_opportunities (research playlists for a track)

Be witty, direct, and concise. Use emoji sparingly.

Recent Documents Context:
${docContext}

Conversation Context (shared across all models):
${conversationContext}`;

  const resp = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROK_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "grok-3-mini-fast",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      tools: getGrokToolSchemas(allowedToolNames),
      tool_choice: "auto",
      max_tokens: 1024,
    }),
  });

  if (!resp.ok) {
    console.error("Grok agentic error:", resp.status, await resp.text());
    return { text: "⚠️ AI unavailable. Try again shortly.", toolCalls: [] };
  }

  const data = await resp.json();
  const choice = data.choices?.[0];
  const toolCalls: Array<{ name: string; args: any }> = [];

  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
      toolCalls.push({ name: tc.function.name, args });
    }
  }

  return { text: choice?.message?.content || "", toolCalls };
}

// ─── Execution logging helpers ─────────────────────────────────

async function logToolAttempt(requestId: string, toolName: string, args: any, model: string, chatId: string, userMessage: string): Promise<string> {
  const { data, error } = await supabase.from("tool_execution_logs").insert({
    request_id: requestId,
    tool_name: toolName,
    args,
    status: "attempted",
    model,
    chat_id: chatId,
    user_message: userMessage,
    started_at: new Date().toISOString(),
  }).select("id").single();
  if (error || !data) {
    console.error("FATAL: Failed to create tool_execution_logs row", error);
    throw new Error(`Execution logging failed for ${toolName}: no log row created`);
  }
  return data.id;
}

async function logToolSuccess(logId: string, result: string, startedAt: number, httpStatus?: number) {
  const elapsed = Date.now() - startedAt;
  let responseJson: any = null;
  try { responseJson = JSON.parse(result); } catch { responseJson = { text: result.slice(0, 2000) }; }
  await supabase.from("tool_execution_logs").update({
    status: "succeeded",
    elapsed_ms: elapsed,
    completed_at: new Date().toISOString(),
    http_status: httpStatus ?? 200,
    response_json: responseJson,
  }).eq("id", logId);
}

async function logToolFailure(logId: string, error: string, startedAt: number) {
  const elapsed = Date.now() - startedAt;
  await supabase.from("tool_execution_logs").update({
    status: "failed",
    elapsed_ms: elapsed,
    completed_at: new Date().toISOString(),
    error: error.slice(0, 5000),
  }).eq("id", logId);
}

// ─── Structured log helper ─────────────────────────────────────
function logEvent(e: Record<string, any>) {
  console.log(JSON.stringify({ ts: Date.now(), ...e }));
}

// ─── Execute agentic loop ──────────────────────────────────────

async function executeAgenticLoop(chatId: string, userMessage: string, opts: { taskId: string; sessionModel: "grok" | "gemini" | "chatgpt"; lane?: "lane1_do" | "lane2_assistant" | "lane3_autonomous"; allowTools?: boolean; workflowKey?: string }): Promise<void> {
  // ── STEP 1: EXECUTION METRICS ──
  const executionStart = Date.now();

  // ── HARD EXECUTION GUARD ──
  if ((opts.lane !== "lane1_do" && opts.lane !== "lane3_autonomous") || opts.allowTools !== true) {
    console.error(JSON.stringify({ ts: Date.now(), event: "tools_blocked", taskId: opts.taskId, lane: opts.lane, allowTools: opts.allowTools }));
    throw new Error("TOOLS_BLOCKED: agentic loop cannot run outside /do execution lane");
  }

  // ── EXECUTION CONTEXT ASSERTION ──
  logEvent({ event: "execution_context", lane: opts.lane, allowTools: opts.allowTools, workflowKey: opts.workflowKey, taskId: opts.taskId });

  if (opts.lane !== "lane1_do" && opts.lane !== "lane3_autonomous") {
    throw new Error("EXECUTION_CONTEXT_INVALID_LANE");
  }

  // ── REQUIRE WORKFLOW KEY ──
  if (!opts.workflowKey) {
    throw new Error("WORKFLOW_REQUIRED_FOR_EXECUTION");
  }

  // ── EXECUTION LOCK: prevent duplicate execution ──
  const lockId = crypto.randomUUID();
  const { data: locked } = await supabase
    .from("tasks")
    .update({
      status: "running",
      selected_workflow: opts.workflowKey,
      result_json: {
        execution_lane: "lane1_do",
        selected_workflow: opts.workflowKey,
        model_used: opts.sessionModel,
        execution_lock: lockId,
        execution_lock_ts: Date.now(),
      },
    })
    .eq("id", opts.taskId)
    .in("status", ["queued", "running"])
    .is("result_json->execution_lock", null)
    .select("id")
    .maybeSingle();

  if (!locked) {
    console.warn(JSON.stringify({ ts: Date.now(), event: "duplicate_execution_blocked", taskId: opts.taskId }));
    throw new Error("TASK_LOCK_NOT_ACQUIRED");
  }

  logEvent({ event: "lane1_execution_start", workflow: opts.workflowKey, taskId: opts.taskId, model: opts.sessionModel, lockId });

  // ── LOAD TOOLS FROM WORKFLOW ──
  const workflows = await fetchWorkflowRegistry();
  let matchedWorkflow = workflows.find(w => w.key === opts.workflowKey);

  // Allow known implemented workflows when registry doesn't have them (e.g. find_playlist_opportunities in Lovable)
  if (!matchedWorkflow && opts.workflowKey === "find_playlist_opportunities" && IMPLEMENTED_WORKFLOW_KEYS.has("find_playlist_opportunities")) {
    matchedWorkflow = SYNTHETIC_FIND_PLAYLIST_OPPORTUNITIES;
    console.log(JSON.stringify({ ts: Date.now(), event: "workflow_synthetic_fallback", key: opts.workflowKey, taskId: opts.taskId }));
  }

  // ── VALIDATE WORKFLOW EXISTS ──
  if (!matchedWorkflow) {
    console.error(JSON.stringify({ ts: Date.now(), event: "workflow_invalid", key: opts.workflowKey }));
    throw new Error("WORKFLOW_NOT_FOUND_IN_REGISTRY");
  }

  const workflowToolNames: string[] | undefined = matchedWorkflow.tools?.length
    ? matchedWorkflow.tools
    : undefined;

  logEvent({ event: "workflow_tools_loaded", workflow: opts.workflowKey, tools: workflowToolNames || "all", taskId: opts.taskId });

  const model: "grok" | "gemini" = opts.sessionModel === "chatgpt" ? "grok" : opts.sessionModel as "grok" | "gemini";
  const docContext = await getRecentDocContext();
  const requestId = crypto.randomUUID();

  await appendConversationTurn(chatId, {
    role: "user",
    content: userMessage,
    model,
    at: new Date().toISOString(),
  });

  const conversationContext = await buildConversationContext(chatId);

  // Step 1: Get AI response with workflow-scoped tool calls
  logEvent({ event: "ai_call_start", taskId: opts.taskId, model, workflow: opts.workflowKey });

  // Deterministic playlist run: if we can infer track from chat, skip LLM refusal paths
  let result: { text: string; toolCalls: Array<{ name: string; args: any }> };
  if (opts.workflowKey === "find_playlist_opportunities") {
    const inferredTrack = extractPlaylistTrackName(userMessage, conversationContext);
    if (inferredTrack) {
      logEvent({ event: "playlist_track_inferred", taskId: opts.taskId, inferredTrack });
      result = {
        text: "",
        toolCalls: [{ name: "find_playlist_opportunities", args: { track_name: inferredTrack } }],
      };
    } else {
      result = model === "grok"
        ? await agenticGrokCall(userMessage, docContext, conversationContext, workflowToolNames, opts.workflowKey)
        : await agenticGeminiCall(userMessage, docContext, conversationContext, workflowToolNames, opts.workflowKey);
    }
  } else {
    result = model === "grok"
      ? await agenticGrokCall(userMessage, docContext, conversationContext, workflowToolNames, opts.workflowKey)
      : await agenticGeminiCall(userMessage, docContext, conversationContext, workflowToolNames, opts.workflowKey);
  }
  logEvent({ event: "ai_response", taskId: opts.taskId, workflow: opts.workflowKey, model, toolCalls: result.toolCalls.length, hasText: !!result.text });
  await supabase.from("tasks").update({ result_json: { progress_step: "E_ai_done", tool_count: result.toolCalls.length, execution_lock: lockId } }).eq("id", opts.taskId);

  // Step 2: If no tool calls, just send the text response
  if (result.toolCalls.length === 0) {
    const responseText = result.text || "I'm not sure how to help with that. Try /workflows for available commands.";
    const reply = formatAssistantMessage(model, responseText);
    await sendMessage(chatId, reply);
    await appendConversationTurn(chatId, {
      role: "assistant",
      content: reply,
      model,
      at: new Date().toISOString(),
    });

    const executionDuration = Date.now() - executionStart;
    await supabase.from("tasks").update({
      status: "succeeded",
      selected_tools: [],
      result_json: { execution_complete: true, workflow: opts.workflowKey, text_response: responseText.slice(0, 2000), model_used: opts.sessionModel, execution_duration_ms: executionDuration, execution_lock: null, execution_lock_released_ts: Date.now() },
    }).eq("id", opts.taskId);
    await sendMessage(chatId, `✅ Done: \`${opts.taskId}\``, {}, `task:${opts.taskId}:done`);
    return;
  }

  // Step 3: Execute tool calls with mandatory logging
  const toolResults: string[] = [];
  const confirmationButtons: Array<{ text: string; callback_data: string }> = [];

  for (const tc of result.toolCalls) {
    // WORKFLOW-SCOPED GUARDRAIL: block tools not in this workflow's declared tool list
    if (workflowToolNames && !workflowToolNames.includes(tc.name)) {
      console.error(JSON.stringify({ ts: Date.now(), event: "workflow_tool_blocked", tool: tc.name, workflow: opts.workflowKey, taskId: opts.taskId }));
      toolResults.push(`🚫 Tool '${tc.name}' is not allowed for workflow '${opts.workflowKey}'.`);
      continue;
    }

    const tool = AGENT_TOOLS.find(t => t.name === tc.name);
    if (!tool) {
      console.error(`GUARDRAIL: AI tried to call unregistered tool '${tc.name}' — blocked.`);
      toolResults.push(`🚫 Tool '${tc.name}' is not in the tool registry. Run /workflows to see available commands.`);
      continue;
    }

    // HARD BLOCK: switch_ai_model is NEVER allowed inside the agentic loop.
    // Model switching is handled exclusively by /model command before the loop runs.
    if (tc.name === "switch_ai_model") {
      toolResults.push("🔒 Model switching is blocked inside the execution loop. Use `/model grok` or `/model gemini` explicitly.");
      continue;
    }

    // Log attempt BEFORE execution — hard rule: no log = fail loudly
    let logId: string;
    const startedAt = Date.now();
    try {
      logId = await logToolAttempt(requestId, tc.name, tc.args, model, chatId, userMessage);
    } catch (logErr) {
      const errMsg = `🚨 FATAL: Tool execution logging failed for ${tc.name}. Aborting tool call.`;
      console.error(errMsg, logErr);
      await sendMessage(chatId, formatAssistantMessage(model, errMsg));
      return;
    }

    if (tool.destructive) {
      // Store pending action and create confirmation button
      const actionId = crypto.randomUUID().slice(0, 8);
      await storePendingAction(actionId, tc.name, tc.args);

      const label = tc.name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const targetId = tc.args.job_id || tc.args.queue_id || "";
      const shortId = targetId.slice(0, 8);
      confirmationButtons.push(
        { text: `✅ ${label}${shortId ? ` (${shortId}…)` : ""}`, callback_data: `agent_confirm:${actionId}` },
        { text: `❌ Cancel`, callback_data: `agent_cancel:${actionId}` },
      );
      toolResults.push(`⏳ *${label}* — Awaiting your confirmation.`);
      // Update log to succeeded (destructive actions are deferred, logging the intent)
      await logToolSuccess(logId, "Awaiting confirmation", startedAt);
    } else {
      // Execute immediately with telemetry
      const toolStart = Date.now();
      try {
        const output = await tool.execute(tc.args, { chatId, userMessage, conversationContext });
        const toolDuration = Date.now() - toolStart;
        await logToolSuccess(logId, output, startedAt);
        console.log(JSON.stringify({ event: "tool_execution", tool: tc.name, workflow: opts.workflowKey, duration_ms: toolDuration, taskId: opts.taskId, ts: Date.now() }));
        toolResults.push(output);
      } catch (e) {
        const toolDuration = Date.now() - toolStart;
        const errStr = e instanceof Error ? e.message : String(e);
        await logToolFailure(logId, errStr, startedAt);
        console.error(JSON.stringify({ event: "tool_execution_failed", tool: tc.name, workflow: opts.workflowKey, taskId: opts.taskId, duration_ms: toolDuration, error: errStr, ts: Date.now() }));
        toolResults.push(`❌ Error executing ${tc.name}: ${errStr}`);
      }
    }
  }

  // Step 4: If we have tool results, feed them back to AI for a final summary
  const executedToolNames = result.toolCalls.map(tc => tc.name);

  if (toolResults.length > 0 && confirmationButtons.length === 0) {
    // All tools were non-destructive, get a summary
    const summaryPrompt = `The user asked: "${userMessage}"

You called these tools and got these results:
${result.toolCalls.map((tc, i) => `- ${tc.name}: ${toolResults[i]}`).join("\n")}

Now provide a clear, concise summary for the user based on the results. Use markdown formatting.`;

    let summary: string;
    if (model === "grok") {
      const resp = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${GROK_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "grok-3-mini-fast",
          messages: [
            { role: "system", content: `You are the ${SYSTEM_IDENTITY}. Summarize tool results concisely. Be witty and direct.` },
            { role: "user", content: summaryPrompt },
          ],
          max_tokens: 1024,
        }),
      });
      const data = await resp.json();
      summary = data.choices?.[0]?.message?.content || toolResults.join("\n\n");
    } else {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: summaryPrompt }] }],
            systemInstruction: { parts: [{ text: `You are the ${SYSTEM_IDENTITY}. Summarize tool results concisely and clearly.` }] },
            generationConfig: { maxOutputTokens: 1024 },
          }),
        }
      );
      const data = await resp.json();
      summary = data.candidates?.[0]?.content?.parts?.[0]?.text || toolResults.join("\n\n");
    }

    const finalSummary = formatAssistantMessage(model, summary);
    logEvent({ event: "sending_summary", taskId: opts.taskId, workflow: opts.workflowKey });
    await sendMessage(chatId, finalSummary, {}, `task:${opts.taskId}:summary`);
    await appendConversationTurn(chatId, {
      role: "assistant",
      content: finalSummary,
      model,
      at: new Date().toISOString(),
    });

    // ── TASK LIFECYCLE: mark succeeded with duration ──
    const executionDuration = Date.now() - executionStart;
    await supabase.from("tasks").update({
      status: "succeeded",
      selected_tools: executedToolNames,
      result_json: { execution_complete: true, workflow: opts.workflowKey, progress_step: "F_succeeded", summary: summary.slice(0, 2000), toolResults: toolResults.map(r => r.slice(0, 500)), model_used: opts.sessionModel, execution_duration_ms: executionDuration, execution_lock: null, execution_lock_released_ts: Date.now() },
    }).eq("id", opts.taskId);
    logEvent({ event: "task_succeeded", taskId: opts.taskId, workflow: opts.workflowKey, execution_duration_ms: executionDuration });
    await sendMessage(chatId, `✅ Done: \`${opts.taskId}\``, {}, `task:${opts.taskId}:done`);

  } else if (confirmationButtons.length > 0) {
    // Has destructive actions needing confirmation
    const nonDestructiveResults = toolResults.filter(r => !r.startsWith("⏳"));
    let message = "";

    if (result.text) message += result.text + "\n\n";
    if (nonDestructiveResults.length > 0) message += nonDestructiveResults.join("\n\n") + "\n\n";
    message += toolResults.filter(r => r.startsWith("⏳")).join("\n");

    // Group confirmation buttons into rows of 2
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < confirmationButtons.length; i += 2) {
      keyboard.push(confirmationButtons.slice(i, i + 2));
    }

    const confirmationMessage = formatAssistantMessage(model, message.trim());
    await sendMessage(chatId, confirmationMessage, {
      reply_markup: { inline_keyboard: keyboard },
    }, `task:${opts.taskId}:confirm`);
    await appendConversationTurn(chatId, {
      role: "assistant",
      content: confirmationMessage,
      model,
      at: new Date().toISOString(),
    });

    // ── TASK LIFECYCLE: mark succeeded (awaiting user confirmation for destructive actions) ──
    const executionDuration = Date.now() - executionStart;
    await supabase.from("tasks").update({
      status: "succeeded",
      selected_tools: executedToolNames,
      result_json: { execution_complete: true, workflow: opts.workflowKey, awaiting_confirmation: true, toolResults: toolResults.map(r => r.slice(0, 500)), model_used: opts.sessionModel, execution_duration_ms: executionDuration, execution_lock: null, execution_lock_released_ts: Date.now() },
    }).eq("id", opts.taskId);
    await sendMessage(chatId, `✅ Done: \`${opts.taskId}\``, {}, `task:${opts.taskId}:done`);

  } else {
    // No tool calls at all — mark succeeded with text-only result
    const executionDuration = Date.now() - executionStart;
    await supabase.from("tasks").update({
      status: "succeeded",
      selected_tools: [],
      result_json: { execution_complete: true, workflow: opts.workflowKey, text_response: (result.text || "").slice(0, 2000), model_used: opts.sessionModel, execution_duration_ms: executionDuration, execution_lock: null, execution_lock_released_ts: Date.now() },
    }).eq("id", opts.taskId);
    await sendMessage(chatId, `✅ Done: \`${opts.taskId}\``, {}, `task:${opts.taskId}:done`);
  }
}

// ─── Handle agent confirmation callbacks ────────────────────────

async function handleAgentConfirm(actionId: string): Promise<string> {
  const pending = await getPendingAction(actionId);
  if (!pending) return "❌ Action expired or not found.";

  const tool = AGENT_TOOLS.find(t => t.name === pending.tool);
  if (!tool) return "❌ Unknown action.";

  await deletePendingAction(actionId);

  try {
    const result = await tool.execute(pending.args);
    const label = pending.tool.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    return `✅ *${SYSTEM_IDENTITY} — ${label} Executed*\n\n${result}`;
  } catch (e) {
    console.error("Agent confirm execution error:", e);
    return "❌ Failed to execute action.";
  }
}

async function handleAgentCancel(actionId: string): Promise<string> {
  await deletePendingAction(actionId);
  return `🚫 *${SYSTEM_IDENTITY}* — Action cancelled.`;
}

// ─── Legacy callback handlers (for existing approval/retry buttons) ──

async function handleApproval(queueId: string, approved: boolean) {
  const { data: queue, error: qErr } = await supabase
    .from("telegram_approval_queue")
    .select("*")
    .eq("id", queueId)
    .single();

  if (qErr || !queue) return "❌ Approval record not found.";
  if (queue.status !== "pending") return "⏳ Already processed.";

  const now = new Date().toISOString();

  if (approved) {
    const { error: obsErr } = await supabase
      .from("observations")
      .update({ is_verified: true, verified_at: now, verified_via: "telegram" })
      .eq("document_id", queue.document_id)
      .eq("client_id", queue.client_id);

    if (obsErr) return "❌ Failed to verify observations.";

    await supabase.from("telegram_approval_queue").update({ status: "approved", resolved_at: now }).eq("id", queueId);
    return `✅ *${SYSTEM_IDENTITY} — Verified.* ${queue.observation_count} observations confirmed.`;
  } else {
    await supabase.from("telegram_approval_queue").update({ status: "rejected", resolved_at: now }).eq("id", queueId);
    return `❌ *${SYSTEM_IDENTITY} — Rejected.* Observations remain unverified.`;
  }
}

async function handleRetry(jobId: string): Promise<string> {
  const tool = AGENT_TOOLS.find(t => t.name === "retry_failed_job")!;
  return await tool.execute({ job_id: jobId });
}

async function handleArchive(jobId: string): Promise<string> {
  const tool = AGENT_TOOLS.find(t => t.name === "archive_job")!;
  return await tool.execute({ job_id: jobId });
}

async function handleExplainMore(jobId: string): Promise<string> {
  const { data: job, error } = await supabase
    .from("ingestion_jobs")
    .select("*, documents(file_name, mime_type)")
    .eq("id", jobId)
    .single();
  if (error || !job) return "❌ Job not found.";
  const doc = job.documents as any;
  const prompt = `A document processing job failed. File: ${doc?.file_name || "Unknown"}, MIME: ${doc?.mime_type || "Unknown"}, Attempts: ${job.attempt_count}, Error: ${job.last_error || "No error"}. Explain what went wrong and how to fix it in plain English.`;
  const { model } = await getActiveModel();
  const docContext = await getRecentDocContext();

  let response: string;
  if (model === "grok") {
    const resp = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROK_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-3-mini-fast", messages: [{ role: "system", content: `You are the ${SYSTEM_IDENTITY}.` }, { role: "user", content: prompt }], max_tokens: 1024 }),
    });
    const data = await resp.json();
    response = data.choices?.[0]?.message?.content || "No response.";
  } else {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1024 } }),
    });
    const data = await resp.json();
    response = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
  }
  return `💬 *${SYSTEM_IDENTITY} — Troubleshooting*\n\n📁 *File:* ${doc?.file_name || "Unknown"}\n\n${response}`;
}

// ─── Main Webhook Handler ───────────────────────────────────────
serve(async (req) => {
  try {
    const update = await req.json();
    console.log("📨 Update:", JSON.stringify(update).slice(0, 500));
    _currentTaskId = null;

    // ── Callback queries (inline button presses) ──
    if (update.callback_query) {
      const cb = update.callback_query;
      const cbChatId = String(cb.message.chat.id);
      if (cbChatId !== CHAT_ID) return new Response("ok");

      // Create task for callback observability + outbox routing
      try {
        const cbSession = await resolveSession(cbChatId);
        const cbTaskId = await createTaskRow(cbSession.id, `callback:${cb.data}`, null);
        _currentTaskId = cbTaskId;
      } catch (e) {
        console.error("Callback task creation failed:", e);
      }

      const [action, ...idParts] = cb.data.split(":");
      const targetId = idParts.join(":");
      await answerCallbackQuery(cb.id, "Processing...");

      let result: string;

      switch (action) {
        case "approve": result = await handleApproval(targetId, true); break;
        case "reject": result = await handleApproval(targetId, false); break;
        case "retry": result = await handleRetry(targetId); break;
        case "archive": result = await handleArchive(targetId); break;
        case "explain": result = await handleExplainMore(targetId); break;
        case "agent_confirm": result = await handleAgentConfirm(targetId); break;
        case "agent_cancel": result = await handleAgentCancel(targetId); break;
        default: result = "❓ Unknown action.";
      }

      await editMessageReplyMarkup(cbChatId, cb.message.message_id);
      await sendMessage(cbChatId, result);
      if (_currentTaskId) {
        await supabase.from("tasks").update({ status: "succeeded", result_json: { action: `callback:${action}` } }).eq("id", _currentTaskId);
      }
      _currentTaskId = null;
      return new Response("ok");
    }

    // ── Text messages ──
    const message = update.message;
    if (!message?.text) return new Response("ok");

    const chatId = String(message.chat.id);
    const text = message.text.trim();

    if (chatId !== CHAT_ID) {
      console.log(`🚫 Blocked message from unauthorized chat: ${chatId}`);
      return new Response("ok");
    }

    // ─── DETERMINISTIC SPINE: resolve session + create task ───
    let session: { id: string; active_model: string };
    let taskId: string;

    try {
      session = await resolveSession(chatId);
    } catch (sessionErr) {
      console.error("FATAL: session resolution failed:", sessionErr);
      await sendMessage(chatId, `🚨 *${SYSTEM_IDENTITY}* — Session resolution failed: ${String(sessionErr)}`);
      return new Response("ok");
    }

    // Determine if this is an explicit model request (for requested_model field only — no mutation)
    const modelRequestMatch = text.match(/^\/model\s+(grok|gemini|chatgpt)$/i);
    const requestedModel = modelRequestMatch ? modelRequestMatch[1].toLowerCase() : null;

    const routingClearAndContinue =
      text.toLowerCase().trim().startsWith("/do ") ||
      text.toLowerCase().trim() === "/start" ||
      text.toLowerCase().trim().startsWith("/workflows") ||
      text.toLowerCase().trim().startsWith("/metrics") ||
      text.toLowerCase().trim().startsWith("/triage") ||
      text.toLowerCase().trim().startsWith("/status") ||
      text.toLowerCase().trim().startsWith("/help") ||
      text.toLowerCase().trim() === "/ping" ||
      text.toLowerCase().trim().startsWith("/resend") ||
      text.toLowerCase().trim().startsWith("/model");

    // ── Pending bulk pitch (confirm all) ────────────────────────────────
    const pendingBulkEarly = await getPendingPitchBulk(chatId);
    if (pendingBulkEarly) {
      const lower = text.toLowerCase().trim();
      if (routingClearAndContinue) {
        await clearPendingPitchBulk(chatId);
      } else if (lower === "cancel" || lower === "no") {
        try {
          taskId = await createTaskRow(session.id, text, requestedModel);
          _currentTaskId = taskId;
        } catch (taskErr) {
          console.error("FATAL: task creation failed:", taskErr);
          await sendMessage(chatId, `🚨 *${SYSTEM_IDENTITY}* — Task creation failed: ${String(taskErr)}`);
          return new Response("ok");
        }
        await sendMessage(chatId, `📋 Queued: \`${taskId}\``, {}, `task:${taskId}:queued`);
        await clearPendingPitchBulk(chatId);
        await sendMessage(chatId, "Bulk pitch cancelled.", {}, `task:${taskId}:bulk-cancel`);
        await supabase.from("tasks").update({ status: "succeeded", result_json: { shortcut: "pitch_bulk_cancel" } }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      } else if (/^confirm\s+all$/i.test(text.trim())) {
        try {
          taskId = await createTaskRow(session.id, text, requestedModel);
          _currentTaskId = taskId;
        } catch (taskErr) {
          console.error("FATAL: task creation failed:", taskErr);
          await sendMessage(chatId, `🚨 *${SYSTEM_IDENTITY}* — Task creation failed: ${String(taskErr)}`);
          return new Response("ok");
        }
        await sendMessage(chatId, `📋 Queued: \`${taskId}\``, {}, `task:${taskId}:queued`);
        const modelForPitch = (session.active_model === "grok" ? "grok" : "gemini") as "grok" | "gemini";
        const ids = [...pendingBulkEarly.playlist_ids];
        await clearPendingPitchBulk(chatId);
        for (const pid of ids) {
          try {
            const res = await callFanFuelHub("execute-pitch", {
              playlist_id: pid,
              track_name: pendingBulkEarly.track_name,
              bulk: true,
            });
            const msg = typeof res?.message_to_user === "string" ? res.message_to_user : JSON.stringify(res ?? {});
            await sendMessage(chatId, formatAssistantMessage(modelForPitch, msg), {}, `task:${taskId}:bulk-pitch`);
          } catch (e) {
            const errStr = e instanceof Error ? e.message : String(e);
            await sendMessage(chatId, formatAssistantMessage(modelForPitch, `❌ ${errStr}`), {}, `task:${taskId}:bulk-pitch-err`);
          }
        }
        await supabase.from("tasks").update({
          status: "succeeded",
          result_json: { shortcut: "pitch_bulk_done", count: ids.length },
        }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      } else {
        await sendMessage(chatId, "Reply *confirm all* to pitch the listed playlists, or *cancel*.");
        return new Response("ok");
      }
    }

    // ── Pending tier-3 pitch confirm ────────────────────────────────────
    const pendingTier3Early = await getPendingPitchTier3(chatId);
    if (pendingTier3Early) {
      const lower = text.toLowerCase().trim();
      if (routingClearAndContinue) {
        await clearPendingPitchTier3(chatId);
      } else if (lower === "cancel" || lower === "no") {
        try {
          taskId = await createTaskRow(session.id, text, requestedModel);
          _currentTaskId = taskId;
        } catch (taskErr) {
          console.error("FATAL: task creation failed:", taskErr);
          await sendMessage(chatId, `🚨 *${SYSTEM_IDENTITY}* — Task creation failed: ${String(taskErr)}`);
          return new Response("ok");
        }
        await sendMessage(chatId, `📋 Queued: \`${taskId}\``, {}, `task:${taskId}:queued`);
        await clearPendingPitchTier3(chatId);
        await sendMessage(chatId, "Tier-3 pitch cancelled.", {}, `task:${taskId}:t3-cancel`);
        await supabase.from("tasks").update({ status: "succeeded", result_json: { shortcut: "pitch_t3_cancel" } }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      } else if (/^confirm$/i.test(text.trim())) {
        try {
          taskId = await createTaskRow(session.id, text, requestedModel);
          _currentTaskId = taskId;
        } catch (taskErr) {
          console.error("FATAL: task creation failed:", taskErr);
          await sendMessage(chatId, `🚨 *${SYSTEM_IDENTITY}* — Task creation failed: ${String(taskErr)}`);
          return new Response("ok");
        }
        await sendMessage(chatId, `📋 Queued: \`${taskId}\``, {}, `task:${taskId}:queued`);
        const modelForPitch = (session.active_model === "grok" ? "grok" : "gemini") as "grok" | "gemini";
        await clearPendingPitchTier3(chatId);
        try {
          const res = await callFanFuelHub("execute-pitch", {
            playlist_id: pendingTier3Early.playlist_id,
            track_name: pendingTier3Early.track_name,
            tier_confirmed: true,
          });
          const msg = typeof res?.message_to_user === "string" ? res.message_to_user : JSON.stringify(res ?? {});
          await sendMessage(chatId, formatAssistantMessage(modelForPitch, msg), {}, `task:${taskId}:t3-pitch`);
        } catch (e) {
          const errStr = e instanceof Error ? e.message : String(e);
          await sendMessage(chatId, formatAssistantMessage(modelForPitch, `❌ ${errStr}`), {}, `task:${taskId}:t3-pitch-err`);
        }
        await supabase.from("tasks").update({ status: "succeeded", result_json: { shortcut: "pitch_tier3_confirmed" } }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      } else {
        await sendMessage(chatId, "Reply *confirm* to pitch this tier-3 playlist, or *cancel*.");
        return new Response("ok");
      }
    }

    // ── Pending playlist vibe: handle BEFORE task row + lane routing (so Lane 2 never steals yes/cancel) ──
    const pendingPlaylistEarly = await getPlaylistConfirm(chatId);
    if (pendingPlaylistEarly) {
      const lower = text.toLowerCase().trim();
      const clearAndContinue =
        lower.startsWith("/do ") ||
        lower === "/start" ||
        lower.startsWith("/workflows") ||
        lower.startsWith("/metrics") ||
        lower.startsWith("/triage") ||
        lower.startsWith("/status") ||
        lower.startsWith("/help") ||
        lower === "/ping" ||
        lower.startsWith("/resend") ||
        lower.startsWith("/model");

      if (clearAndContinue) {
        await clearPlaylistConfirm(chatId);
        // fall through: one task + normal routing
      } else if (lower === "cancel" || lower === "no" || lower === "/playlist_cancel") {
        try {
          taskId = await createTaskRow(session.id, text, requestedModel);
          _currentTaskId = taskId;
        } catch (taskErr) {
          console.error("FATAL: task creation failed:", taskErr);
          await sendMessage(chatId, `🚨 *${SYSTEM_IDENTITY}* — Task creation failed: ${String(taskErr)}`);
          return new Response("ok");
        }
        await sendMessage(chatId, `📋 Queued: \`${taskId}\``, {}, `task:${taskId}:queued`);
        await clearPlaylistConfirm(chatId);
        await sendMessage(chatId, `🎧 Playlist search cancelled.`, {}, `task:${taskId}:playlist-cancel`);
        await supabase.from("tasks").update({ status: "succeeded", result_json: { shortcut: "playlist_confirm_cancel" } }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      } else {
        const isYes = /^(yes|y|confirm|ok|go|approve)$/i.test(text.trim());
        const userVibe = isYes ? pendingPlaylistEarly.inferred_vibe : text.trim();
        try {
          taskId = await createTaskRow(session.id, text, requestedModel);
          _currentTaskId = taskId;
        } catch (taskErr) {
          console.error("FATAL: task creation failed:", taskErr);
          await sendMessage(chatId, `🚨 *${SYSTEM_IDENTITY}* — Task creation failed: ${String(taskErr)}`);
          return new Response("ok");
        }
        await sendMessage(chatId, `📋 Queued: \`${taskId}\``, {}, `task:${taskId}:queued`);
        if (!userVibe) {
          await sendMessage(chatId, "Reply *yes* to use the suggested vibe, or type your own vibe. Send *cancel* to abort.");
          await supabase.from("tasks").update({ status: "succeeded", result_json: { shortcut: "playlist_confirm_prompt" } }).eq("id", taskId);
          await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
          _currentTaskId = null;
          return new Response("ok");
        }
        await clearPlaylistConfirm(chatId);
        const modelForPlaylist = (session.active_model === "grok" ? "grok" : "gemini") as "grok" | "gemini";
        try {
          const out = await runPlaylistHubResearch(pendingPlaylistEarly.track_name, userVibe, chatId);
          await sendMessage(chatId, formatAssistantMessage(modelForPlaylist, out), {}, `task:${taskId}:playlist-result`);
        } catch (e) {
          const errStr = e instanceof Error ? e.message : String(e);
          await sendMessage(chatId, formatAssistantMessage(modelForPlaylist, `❌ ${errStr}`), {}, `task:${taskId}:playlist-err`);
        }
        await appendConversationTurn(chatId, {
          role: "user",
          content: text,
          model: modelForPlaylist,
          at: new Date().toISOString(),
        });
        await supabase.from("tasks").update({
          status: "succeeded",
          result_json: {
            shortcut: "playlist_confirm_execute",
            track: pendingPlaylistEarly.track_name,
            user_vibe: userVibe,
          },
        }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      }
    }

    try {
      taskId = await createTaskRow(session.id, text, requestedModel);
      _currentTaskId = taskId;
    } catch (taskErr) {
      console.error("FATAL: task creation failed:", taskErr);
      await sendMessage(chatId, `🚨 *${SYSTEM_IDENTITY}* — Task creation failed: ${String(taskErr)}`);
      return new Response("ok");
    }

    // Send queued confirmation with task_id
    await sendMessage(chatId, `📋 Queued: \`${taskId}\``, {}, `task:${taskId}:queued`);

    const modelPitch = (session.active_model === "grok" ? "grok" : "gemini") as "grok" | "gemini";

    // ── Manual curator response → pitch_log ───────────────────────────
    const plResp = text.match(/^playlist\s+(.+?)\s+responded\s*[—–-]\s*interested\s*$/i);
    const plRej = text.match(/^playlist\s+(.+?)\s+rejected\s*$/i);
    if (plResp || plRej) {
      const lastRs = await getLastPlaylistResearch(chatId);
      const trackForStatus = lastRs?.track_name?.trim() || "";
      if (!trackForStatus) {
        await sendMessage(
          chatId,
          formatAssistantMessage(modelPitch, "No recent research — run *find playlist opportunities for [track]* first."),
          {},
          `task:${taskId}:pitch-status-no-track`,
        );
        await supabase.from("tasks").update({ status: "succeeded", result_json: { shortcut: "pitch_status_no_track" } }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      }
      const namePart = (plResp ?? plRej)?.[1]?.trim() ?? "";
      try {
        const res = await callFanFuelHub("update-pitch-status", {
          playlist_name: namePart,
          track_name: trackForStatus,
          status: plResp ? "responded" : "rejected",
        });
        const msg = typeof res?.message_to_user === "string" ? res.message_to_user : JSON.stringify(res ?? {});
        await sendMessage(chatId, formatAssistantMessage(modelPitch, msg), {}, `task:${taskId}:pitch-manual-status`);
      } catch (e) {
        const errStr = e instanceof Error ? e.message : String(e);
        await sendMessage(chatId, formatAssistantMessage(modelPitch, `❌ ${errStr}`), {}, `task:${taskId}:pitch-manual-err`);
      }
      await supabase.from("tasks").update({ status: "succeeded", result_json: { shortcut: "pitch_manual_status" } }).eq("id", taskId);
      await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      _currentTaskId = null;
      return new Response("ok");
    }

    // ── pitch all tier 1 (max 5, confirm) ─────────────────────────────
    if (/^pitch\s+all\s+(?:tier\s*1|t1)\s*$/i.test(text.trim())) {
      const lastBulk = await getLastPlaylistResearch(chatId);
      if (!lastBulk?.ranked_playlist_ids?.length) {
        await sendMessage(
          chatId,
          formatAssistantMessage(modelPitch, "No recent research found. Try: *find playlist opportunities for [track name]*"),
          {},
          `task:${taskId}:pitch-all-no-research`,
        );
        await supabase.from("tasks").update({ status: "succeeded", result_json: { shortcut: "pitch_all_no_research" } }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      }
      const allPl = await hubPlaylistBatch(lastBulk.ranked_playlist_ids);
      const tier1 = allPl
        .filter((p: { tier?: number; submission_method?: string }) =>
          p.tier === 1 && !NON_BULK_PITCH_METHODS.has(String(p.submission_method || "").toLowerCase())
        )
        .slice(0, 5);
      if (!tier1.length) {
        await sendMessage(
          chatId,
          formatAssistantMessage(
            modelPitch,
            "No tier *1* pitchable targets in your last results (or all are algorithmic/distributor). Run research again or pitch by number.",
          ),
          {},
          `task:${taskId}:pitch-all-empty`,
        );
        await supabase.from("tasks").update({ status: "succeeded", result_json: { shortcut: "pitch_all_empty" } }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      }
      const lines = tier1
        .map((p: { playlist_name?: string; playlist_id: string; submission_method?: string }, i: number) =>
          `${i + 1}. *${p.playlist_name ?? p.playlist_id}* — ${p.submission_method ?? "?"}`
        )
        .join("\n");
      await setPendingPitchBulk(chatId, {
        track_name: lastBulk.track_name,
        playlist_ids: tier1.map((p: { playlist_id: string }) => p.playlist_id),
        ts: new Date().toISOString(),
      });
      const bulkMsg = [
        `📣 *Pitch all tier 1* (max 5)`,
        ``,
        `Track: *${lastBulk.track_name}*`,
        ``,
        lines,
        ``,
        `Reply *confirm all* to run these pitches sequentially, or *cancel*.`,
      ].join("\n");
      await sendMessage(chatId, formatAssistantMessage(modelPitch, bulkMsg), {}, `task:${taskId}:pitch-all-confirm`);
      await supabase.from("tasks").update({
        status: "succeeded",
        result_json: { shortcut: "pitch_all_await_confirm", count: tier1.length },
      }).eq("id", taskId);
      await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      _currentTaskId = null;
      return new Response("ok");
    }

    // ── show pitch report ─────────────────────────────────────────────
    if (/^(?:show\s+)?pitch\s+report$/i.test(text.trim())) {
      const lastRep = await getLastPlaylistResearch(chatId);
      if (!lastRep?.ranked_playlist_ids?.length) {
        await sendMessage(
          chatId,
          formatAssistantMessage(modelPitch, "No recent research found. Try: *find playlist opportunities for [track name]*"),
          {},
          `task:${taskId}:pitch-report-empty`,
        );
      } else {
        const playlists = await hubPlaylistBatch(lastRep.ranked_playlist_ids.slice(0, 20));
        const repLines = playlists
          .map((p: { playlist_name?: string; playlist_id: string; tier?: number; submission_method?: string }, i: number) => {
            const tier = p.tier != null ? `T${p.tier}` : "?";
            const method = p.submission_method ?? "—";
            return `${i + 1}. *${p.playlist_name ?? p.playlist_id}* — ${tier} — ${method}`;
          })
          .join("\n");
        const reportMsg = [
          `📋 *Pitch report* (last search: *${lastRep.track_name}*)`,
          ``,
          repLines,
          ``,
          `Reply *pitch 1* … *pitch 20*, *pitch [name]*, or *pitch all tier 1*.`,
        ].join("\n");
        await sendMessage(chatId, formatAssistantMessage(modelPitch, reportMsg), {}, `task:${taskId}:pitch-report`);
      }
      await supabase.from("tasks").update({ status: "succeeded", result_json: { shortcut: "pitch_report" } }).eq("id", taskId);
      await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      _currentTaskId = null;
      return new Response("ok");
    }

    // ── pitch status / my pitches ─────────────────────────────────────
    if (/^(?:pitch\s+status|my\s+pitches)$/i.test(text.trim())) {
      try {
        const lastSt = await getLastPlaylistResearch(chatId);
        const r = await callFanFuelHub("pitch-status", { track_name: lastSt?.track_name ?? "" });
        const entries = r?.entries ?? [];
        const cap = r?.summary?.email_pitches_last_24h;
        let body: string;
        if (!entries.length) {
          body = "No pitches logged yet.";
        } else {
          const lines = entries.slice(0, 25).map((p: Record<string, string>) =>
            `• ${p.playlist_id} — ${p.track_name} — ${p.status} (${p.method ?? "?"})`
          ).join("\n");
          body = `*Pitch log* (${entries.length})\n\n${lines}`;
          if (typeof cap === "number") body += `\n\n📧 Email pitches (last 24h): ${cap}/10`;
        }
        await sendMessage(chatId, formatAssistantMessage(modelPitch, body), {}, `task:${taskId}:pitch-status`);
      } catch (e) {
        const errStr = e instanceof Error ? e.message : String(e);
        await sendMessage(chatId, formatAssistantMessage(modelPitch, `❌ ${errStr}`), {}, `task:${taskId}:pitch-status-err`);
      }
      await supabase.from("tasks").update({ status: "succeeded", result_json: { shortcut: "pitch_status_cmd" } }).eq("id", taskId);
      await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      _currentTaskId = null;
      return new Response("ok");
    }

    // ── pitch [n] / pitch [name] ──────────────────────────────────────
    const pitchNumMatch = text.match(/^pitch\s+#?(\d+)\s*$/i);
    const pitchNameMatch = !pitchNumMatch && /^pitch\s+(.+)$/i.exec(text.trim());
    if (pitchNumMatch || pitchNameMatch) {
      const lastOne = await getLastPlaylistResearch(chatId);
      if (!lastOne?.ranked_playlist_ids?.length) {
        await sendMessage(
          chatId,
          formatAssistantMessage(modelPitch, "No recent research found. Try: *find playlist opportunities for [track name]*"),
          {},
          `task:${taskId}:pitch-single-no-research`,
        );
        await supabase.from("tasks").update({ status: "succeeded", result_json: { shortcut: "pitch_single_no_research" } }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      }
      let playlistId: string | null = null;
      if (pitchNumMatch) {
        const idx = Number(pitchNumMatch[1]);
        if (!Number.isFinite(idx) || idx < 1 || idx > lastOne.ranked_playlist_ids.length) {
          await sendMessage(
            chatId,
            formatAssistantMessage(modelPitch, `Pick a number between 1 and ${lastOne.ranked_playlist_ids.length}.`),
            {},
            `task:${taskId}:pitch-bad-index`,
          );
          await supabase.from("tasks").update({ status: "succeeded", result_json: { shortcut: "pitch_bad_index" } }).eq("id", taskId);
          await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
          _currentTaskId = null;
          return new Response("ok");
        }
        playlistId = lastOne.ranked_playlist_ids[idx - 1];
      } else if (pitchNameMatch) {
        const q = pitchNameMatch[1].trim().toLowerCase();
        const allNm = await hubPlaylistBatch(lastOne.ranked_playlist_ids);
        const hit = allNm.find((p: { playlist_name?: string; playlist_id?: string }) =>
          String(p.playlist_name ?? "").toLowerCase().includes(q) ||
          String(p.playlist_id ?? "").toLowerCase().includes(q)
        );
        if (!hit) {
          await sendMessage(
            chatId,
            formatAssistantMessage(modelPitch, `No playlist in your last results matches "${pitchNameMatch[1].trim()}". Try *show pitch report*.`),
            {},
            `task:${taskId}:pitch-name-miss`,
          );
          await supabase.from("tasks").update({ status: "succeeded", result_json: { shortcut: "pitch_name_miss" } }).eq("id", taskId);
          await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
          _currentTaskId = null;
          return new Response("ok");
        }
        playlistId = hit.playlist_id;
      }
      if (playlistId) {
        try {
          const res = await callFanFuelHub("execute-pitch", {
            playlist_id: playlistId,
            track_name: lastOne.track_name,
          });
          if (res?.action_taken === "tier_gate" && res?.ok === false) {
            await setPendingPitchTier3(chatId, {
              playlist_id: playlistId,
              track_name: lastOne.track_name,
              ts: new Date().toISOString(),
            });
          }
          const msg = typeof res?.message_to_user === "string" ? res.message_to_user : JSON.stringify(res ?? {});
          await sendMessage(chatId, formatAssistantMessage(modelPitch, msg), {}, `task:${taskId}:pitch-one`);
        } catch (e) {
          const errStr = e instanceof Error ? e.message : String(e);
          await sendMessage(chatId, formatAssistantMessage(modelPitch, `❌ ${errStr}`), {}, `task:${taskId}:pitch-one-err`);
        }
      }
      await supabase.from("tasks").update({ status: "succeeded", result_json: { shortcut: "pitch_single" } }).eq("id", taskId);
      await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      _currentTaskId = null;
      return new Response("ok");
    }

    // Normalized text for intent routing (auto-promote + autonomous mode). Must run before Lane 2.
    const lowerText = text.toLowerCase().trim();

    // ══════════════════════════════════════════════════════════
    // PLAYLIST INTENT — deterministic (NO executeAgenticLoop / NO Lane 2 Grok)
    // Natural language: extract track → setPlaylistConfirm → vibe question → return.
    // /do find_playlist_opportunities is handled later in the /do → Lane 1 path.
    // ══════════════════════════════════════════════════════════
    const findPlaylistRequested =
      /\bfind\s+playlist\s+opportunities\b/i.test(lowerText) ||
      /\bsearch\s+playlist\s+opportunities\s+for\s+/i.test(lowerText) ||
      /\bplaylist\s+opportunities\s+for\s+/i.test(lowerText) ||
      (/\bplaylist\s+opportunities\b/i.test(lowerText) && /\bfor\s+\S+/i.test(lowerText)) ||
      /\bfind\s+playlists?\s+for\s+/i.test(lowerText);

    if (
      findPlaylistRequested &&
      IMPLEMENTED_WORKFLOW_KEYS.has("find_playlist_opportunities") &&
      !lowerText.startsWith("/do")
    ) {
      const conv = await buildConversationContext(chatId);
      const trackNl = extractPlaylistTrackName(text, conv);
      const modelNl = (session.active_model === "grok" ? "grok" : "gemini") as "grok" | "gemini";

      if (trackNl) {
        const inferredNl = inferVibeFromTrack(trackNl);
        await setPlaylistConfirm(chatId, {
          track_name: trackNl,
          inferred_vibe: inferredNl,
          created_at: new Date().toISOString(),
        });
        const vibePrompt =
          `🎵 To find the right playlists for *${trackNl}*, tell me:\n\n` +
          `1️⃣ *Genre/subgenre* — e.g. chill trap, drill, conscious rap, west coast\n` +
          `2️⃣ *Similar artists or features* — e.g. Larry June, FBG Duck\n` +
          `3️⃣ *Mood/theme* — e.g. spiritual, street, introspective, healing\n\n` +
          `Just reply with whatever fits. More detail = better results.`;
        console.log("[PLAYLIST_NL] vibe prompt (deterministic)", { taskId, track: trackNl });
        await sendMessage(chatId, formatAssistantMessage(modelNl, vibePrompt), {}, `task:${taskId}:playlist-vibe-prompt`);
        await supabase.from("tasks").update({
          status: "succeeded",
          result_json: {
            execution_lane: "playlist_nl",
            shortcut: "playlist_vibe_prompt_natural",
            track: trackNl,
          },
        }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      }

      const needTrack = [
        `🎧 *Playlist opportunities*`,
        ``,
        `I need a *track name* in your message.`,
        `Example: *Find playlist opportunities for Meditate by Fendi Frost*.`,
      ].join("\n");
      await sendMessage(chatId, formatAssistantMessage(modelNl, needTrack), {}, `task:${taskId}:playlist-need-track`);
      await supabase.from("tasks").update({
        status: "succeeded",
        result_json: { execution_lane: "playlist_nl", shortcut: "playlist_need_track_natural" },
      }).eq("id", taskId);
      await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      _currentTaskId = null;
      return new Response("ok");
    }

    // ══════════════════════════════════════════════════════════
    // INTENT-BASED LANE 1 AUTO-PROMOTION (early — before shortcuts/Lane 2)
    // "Run / execute / start …" → other workflows (playlist NL handled above).
    // ══════════════════════════════════════════════════════════
    const EXECUTION_INTENT_PREFIXES = ["run ", "execute ", "trigger ", "start "];
    const hasExecutionIntent = EXECUTION_INTENT_PREFIXES.some(p => lowerText.startsWith(p));

    let autoPromotedWorkflow: WorkflowEntry | undefined;
    if (hasExecutionIntent) {
      const intentArg = lowerText.replace(/^(run|execute|trigger|start)\s+/, "").trim();
      const intentWorkflows = await fetchWorkflowRegistry();
      const { chosen: intentChosen } = _matchWorkflows(intentArg, intentWorkflows);
      if (intentChosen && IMPLEMENTED_WORKFLOW_KEYS.has(intentChosen.key)) {
        autoPromotedWorkflow = intentChosen;
      }
    }

    if (autoPromotedWorkflow) {
      console.log("[AUTO_PROMOTE] Routing to Lane 1", {
        taskId,
        workflowKey: autoPromotedWorkflow.key,
      });
      await supabase.from("tasks").update({
        status: "running",
        selected_workflow: autoPromotedWorkflow.key,
        result_json: { execution_lane: "lane1_do", progress_step: "lane1_auto_promoted", auto_promoted: true },
      }).eq("id", taskId);
      try {
        await Promise.race([
          executeAgenticLoop(chatId, text, {
            taskId,
            lane: "lane1_do",
            allowTools: true,
            workflowKey: autoPromotedWorkflow.key,
            sessionModel: session.active_model as "grok" | "gemini" | "chatgpt",
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), 55000)),
        ]);
      } catch (err) {
        const errMsg = (err as Error).message || "unknown";
        const failResult = buildFailureResultJson({ execution_lane: "lane1_do" }, errMsg);
        await supabase.from("tasks").update({ status: "failed", error: errMsg.slice(0, 300), result_json: failResult }).eq("id", taskId);
        await sendMessage(chatId, `❌ Failed: \`${taskId}\` — ${errMsg.slice(0, 200)}`, {}, `task:${taskId}:failed`);
      }
      return new Response("ok");
    }

    // /start still shows the help menu
    if (text === "/start") {
      await setShortcutAttribution(taskId, "start");
      await sendMessage(chatId, [
        `🎯 *${SYSTEM_IDENTITY} — Online (Two-Lane Mode)*`,
        ``,
        `💬 *Lane 2 (Default):* Just talk to me — I'll answer, explain, draft, plan.`,
        `⚡ *Lane 1 (Execute):* Prefix with \`/do\` to run a workflow.`,
        ``,
        `*Examples:*`,
        `• "What's broken today?" → I'll explain (Lane 2)`,
        `• \`/do status\` → Executes system status check (Lane 1)`,
        `• \`/do retry failed jobs\` → Executes retry workflow (Lane 1)`,
        `• "How are my projects doing?" → I'll discuss (Lane 2)`,
        ``,
        `*Commands:*`,
        `• /status — System status`,
        `• /metrics — Metrics + recent tasks`,
        `• /ping — Connectivity test`,
        `• /workflows — See all registered workflows`,
        `• /help — Quick help`,
        `• /do <workflow> — Execute a workflow`,
        `• /model — Check or switch AI model`,
        ``,
        `📈 *Observability:*`,
        `• /status — health snapshot`,
        `• /metrics — last 20 tasks + durations`,
        ``,
        `🔒 I will NEVER execute tools unless you use \`/do\` or a direct command.`,
      ].join("\n"));
      await supabase.from("tasks").update({ status: "succeeded", result_json: { execution_lane: "shortcut", progress_step: "shortcut_start", action: "start_help" } }).eq("id", taskId);
      await sendMessage(chatId, `✅ Done: \`${taskId}\``);
      return new Response("ok");
    }

    if (text.toLowerCase() === "/model") {
      await setShortcutAttribution(taskId, "model");
      await sendMessage(chatId, `🤖 *${SYSTEM_IDENTITY}*\n\nActive model: *${getModelLabel(session.active_model as any)}*\n🔒 Model switching is locked until you explicitly run /model grok or /model gemini.`);
      await supabase.from("tasks").update({ status: "succeeded", result_json: { execution_lane: "shortcut", progress_step: "shortcut_model", action: "model_check", active_model: session.active_model } }).eq("id", taskId);
      await sendMessage(chatId, `✅ Done: \`${taskId}\``);
      return new Response("ok");
    }

    if (modelRequestMatch) {
      await setShortcutAttribution(taskId, "model_switch");
      const reqModel = modelRequestMatch[1].toLowerCase();
      await supabase.from("sessions").update({ active_model: reqModel }).eq("id", session.id);
      await supabase.from("bot_settings").upsert(
        { setting_key: "ai_model", setting_value: reqModel, updated_at: new Date().toISOString() },
        { onConflict: "setting_key" }
      );
      await sendMessage(chatId, `✅ *${SYSTEM_IDENTITY}* switched to *${getModelLabel(reqModel as any)}*.\n\nI'll stay on this model until you switch again.`);
      await supabase.from("tasks").update({ status: "succeeded", result_json: { execution_lane: "shortcut", progress_step: "shortcut_model_switch", action: "model_switch", new_model: reqModel } }).eq("id", taskId);
      await sendMessage(chatId, `✅ Done: \`${taskId}\``);
      return new Response("ok");
    }

    // ── /ping — outbox dogfood test ──
    if (text.toLowerCase() === "/ping") {
      await setShortcutAttribution(taskId, "ping");
      await sendMessage(chatId, `🏓 pong`, {}, `task:${taskId}:pong`);
      await supabase.from("tasks").update({ status: "succeeded", result_json: { execution_lane: "shortcut", progress_step: "shortcut_ping", action: "ping" } }).eq("id", taskId);
      await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      _currentTaskId = null;
      return new Response("ok");
    }

    // ── /resend_failed — flush failed outbox items ──
    if (text.toLowerCase() === "/resend_failed") {
      await setShortcutAttribution(taskId, "resend_failed");
      const { sent, failed } = await flushTelegramOutbox(chatId, 10);
      await sendMessage(chatId, `📤 *Outbox flush:* ${sent} sent, ${failed} failed`, {}, `task:${taskId}:resend`);
      await supabase.from("tasks").update({ status: "succeeded", result_json: { execution_lane: "shortcut", progress_step: "shortcut_resend_failed", action: "resend_failed", sent, failed } }).eq("id", taskId);
      await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      _currentTaskId = null;
      return new Response("ok");
    }

    // ── Direct "status" shortcut — bypasses AI entirely ──
    if (text.toLowerCase() === "status" || text.toLowerCase() === "/status") {
      console.log(`[SHORTCUT] Direct status bypass taskId=${taskId}`);
      await setShortcutAttribution(taskId, "status");
      try {
        const statusTool = AGENT_TOOLS.find(t => t.name === "get_system_status");
        const statusResult = statusTool ? await statusTool.execute({}) : "Tool get_system_status not found";
        const health = systemHealthCheck();
        const model = session.active_model as "grok" | "gemini";

        // Parse and format status into human-readable text
        let formattedStatus: string;
        try {
          const parsed = JSON.parse(statusResult);
          const lines = [
            `📄 *Documents Processed:* ${parsed.documents_processed ?? 0}`,
            `⏳ *Pending Approvals:* ${parsed.pending_approvals ?? 0}`,
            `⚡ *Active Jobs:* ${parsed.active_jobs ?? 0}`,
            `❌ *Failed Jobs:* ${parsed.failed_jobs ?? 0}`,
            `🔧 *Tool Calls (1h):* ${parsed.recent_tool_calls_1h ?? 0}`,
            `🤖 *Active Model:* ${parsed.active_model ?? "unknown"}`,
          ];
          if (parsed.errors?.length) {
            lines.push(``, `⚠️ *Errors:* ${parsed.errors.length} query failures`);
          }
          formattedStatus = lines.join("\n");
        } catch {
          formattedStatus = statusResult;
        }

        // Fetch connected project stats
        let projectSection = "";
        try {
          const projects = await getConnectedProjects();
          if (projects.length > 0) {
            const projectLines: string[] = [``, `🌐 *Connected Projects (${projects.length})*`];
            for (const p of projects) {
              const stats = await fetchProjectStats(p);
              if (stats?.tables) {
                const tableCount = Object.keys(stats.tables).length;
                const totalRows = Object.values(stats.tables).reduce((a: number, b: any) => a + (Number(b) || 0), 0);
                projectLines.push(`  ✅ *${p.name}* — ${tableCount} tables, ${totalRows} rows`);
              } else {
                projectLines.push(`  ❌ *${p.name}* — unreachable`);
              }
            }
            projectSection = projectLines.join("\n");
          }
        } catch (projErr) {
          console.error("Status: project stats error:", projErr);
          projectSection = `\n\n⚠️ Could not fetch project stats`;
        }

        const reply = formatAssistantMessage(model, `📊 *System Status*\n\n${formattedStatus}${projectSection}\n\n🏥 *Health:* uptime=${Math.round(health.uptime_ms / 1000)}s tools=${health.tool_count} workflows=${health.implemented_workflow_count}`);
        await sendMessage(chatId, reply);
        await supabase.from("tasks").update({
          status: "succeeded",
          selected_tools: ["get_system_status"],
          result_json: { execution_lane: "shortcut", progress_step: "shortcut_status", result: statusResult, health, model_used: session.active_model },
        }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``);
      } catch (statusErr) {
        const errMsg = statusErr instanceof Error ? statusErr.message : String(statusErr);
        console.error("Status shortcut error:", statusErr);
        const failResult = buildFailureResultJson({ execution_lane: "shortcut", progress_step: "shortcut_status_failed", model_used: session.active_model }, errMsg);
        await supabase.from("tasks").update({ status: "failed", error: errMsg.slice(0, 300), result_json: failResult }).eq("id", taskId);
        await sendMessage(chatId, `❌ Failed: \`${taskId}\` — ${errMsg.slice(0, 200)}`);
      }
      return new Response("ok");
    }

    // ── /workflows — list from DB registry ──
    if (text.toLowerCase() === "/workflows") {
      await setShortcutAttribution(taskId, "workflows");
      const workflows = await fetchWorkflowRegistry();
      const listText = workflows.length > 0
        ? _formatWorkflowList(workflows)
        : "⚠️ Workflow registry unavailable right now. Try /status or try again.";
      await sendMessage(chatId, listText, {}, `task:${taskId}:workflows`);
      await supabase.from("tasks").update({ status: "succeeded", result_json: { execution_lane: "shortcut", progress_step: "shortcut_workflows", action: "list_workflows" } }).eq("id", taskId);
      await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      _currentTaskId = null;
      return new Response("ok");
    }

    // ── /help — short help ──
    if (text.toLowerCase() === "/help") {
      await setShortcutAttribution(taskId, "help");
      const helpText = [
        `🎯 *${SYSTEM_IDENTITY} — Quick Help*`,
        ``,
        `*Two-Lane System:*`,
        `💬 Just type normally → Assistant mode (Lane 2)`,
        `⚡ \`/do <workflow>\` → Execution mode (Lane 1)`,
        ``,
        `*Commands:*`,
        `• /status — System status`,
        `• /metrics — Metrics + recent tasks`,
        `• /ping — Connectivity test`,
        `• /resend\\_failed — Retry failed outbox items`,
        `• /workflows — See all available workflows`,
        `• /do <workflow> — Execute a specific workflow`,
        `• /model — Check or switch AI model`,
        ``,
        `💡 Tip: run \`/metrics\` to inspect recent task runs and durations.`,
      ].join("\n");
      await sendMessage(chatId, helpText, {}, `task:${taskId}:help`);
      await supabase.from("tasks").update({ status: "succeeded", result_json: { execution_lane: "shortcut", progress_step: "shortcut_help", action: "help" } }).eq("id", taskId);
      await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      _currentTaskId = null;
      return new Response("ok");
    }

    // ── /metrics — execution metrics ──
    if (text.toLowerCase().startsWith("/metrics")) {
      await setShortcutAttribution(taskId, "metrics");
      try {
        // Parse optional limit arg: /metrics 50 (default 20, max 100)
        const metricsParts = text.trim().split(/\s+/);
        const requestedLimitRaw = metricsParts[1] ? Number(metricsParts[1]) : 20;
        const requestedLimit = Number.isFinite(requestedLimitRaw) ? requestedLimitRaw : 20;
        const metricsLimit = Number.isFinite(requestedLimitRaw) ? Math.min(Math.max(requestedLimitRaw, 1), 100) : 20;

        const { data: rawTasks, error: tasksErr } = await supabase
          .from("tasks")
          .select("id, status, selected_workflow, result_json, created_at, error")
          .order("created_at", { ascending: false })
          .limit(metricsLimit);

        const safeTasks = (tasksErr || !rawTasks) ? [] : rawTasks;

        const health = systemHealthCheck();

        function fmtDuration(ms: number | null | undefined): string {
          if (ms == null) return "";
          if (ms >= 1000) return ` | ${(ms / 1000).toFixed(2)}s`;
          return ` | ${ms}ms`;
        }

        function statusIcon(status: string): string {
          switch (status) {
            case "succeeded": return "✅";
            case "running": return "⏳";
            case "failed": return "❌";
            case "queued": return "🕒";
            default: return "•";
          }
        }

        function fmtTs(ts?: string): string {
          if (!ts) return "";
          return ts.replace("T", " ").slice(0, 16);
        }

        const statusCounts = safeTasks.reduce((acc: Record<string, number>, t: any) => {
          const s = String(t.status || "unknown");
          acc[s] = (acc[s] || 0) + 1;
          return acc;
        }, {});

        function countLine(counts: Record<string, number>): string {
          const s = (k: string) => counts[k] || 0;
          return `📌 *Summary:* ✅ ${s("succeeded")}  ⏳ ${s("running")}  ❌ ${s("failed")}  🕒 ${s("queued")}`;
        }

        const taskSummaries = safeTasks.map((t: any) => {
          const shortId = (t.id || "").slice(0, 8) || "unknown";
          const lockHeld = t.status === "running" && Boolean(t.result_json?.execution_lock) ? "on" : "off";
          const dur = fmtDuration(t.result_json?.execution_duration_ms);
          const ts = fmtTs(t.created_at);
          const icon = statusIcon(t.status);
          const wf = t.selected_workflow || "—";
          const errCode = t.status === "failed" ? ` | code=${t.result_json?.error_code || "UNKNOWN"}` : "";
          return `${icon} \`${shortId}\` ${t.status} | ${wf} | lock=${lockHeld}${dur} | ${ts}${errCode}`;
        });

        const limitLine = requestedLimit !== metricsLimit
          ? `*Last ${metricsLimit} Tasks* (requested: ${requestedLimit})`
          : `*Last ${metricsLimit} Tasks:*`;

        const newestTs = safeTasks[0]?.created_at ? fmtTs(safeTasks[0].created_at) : "";
        const oldestTs = safeTasks[safeTasks.length - 1]?.created_at
          ? fmtTs(safeTasks[safeTasks.length - 1].created_at)
          : "";
        const rangeLine = newestTs && oldestTs
          ? `🕰️ *Range:* ${oldestTs} → ${newestTs}`
          : `🕰️ *Range:* —`;

        const lines = [
          `📊 *${SYSTEM_IDENTITY} — Metrics*`,
          ``,
          `🏥 *Health:* uptime=${Math.round(health.uptime_ms / 1000)}s tools=${health.tool_count} workflows=${health.implemented_workflow_count}`,
          ``,
          countLine(statusCounts),
          ``,
          limitLine,
          ...(taskSummaries.length > 0 ? taskSummaries : ["_No tasks found._"]),
          ``,
          rangeLine,
        ];

        await sendMessage(chatId, lines.join("\n"), {}, `task:${taskId}:metrics`);
        await supabase.from("tasks").update({
          status: "succeeded",
          result_json: { progress_step: "shortcut_metrics", health, task_count: safeTasks.length, requested_limit: requestedLimit, effective_limit: metricsLimit, status_counts: statusCounts, range: { oldest: oldestTs || null, newest: newestTs || null } },
        }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      } catch (metricsErr) {
        const errMsg = metricsErr instanceof Error ? metricsErr.message : String(metricsErr);
        const failResult = buildFailureResultJson({ execution_lane: "shortcut", progress_step: "shortcut_metrics_failed" }, errMsg);
        await supabase.from("tasks").update({ status: "failed", error: errMsg.slice(0, 300), result_json: failResult }).eq("id", taskId);
        await sendMessage(chatId, `❌ Failed: \`${taskId}\` — ${errMsg.slice(0, 200)}`);
      }
      _currentTaskId = null;
      return new Response("ok");
    }

    // ── /triage — failure root-cause summary ──
    if (text.toLowerCase() === "/triage") {
      await setShortcutAttribution(taskId, "triage");
      try {
        const { data: triageTasks, error: triageErr } = await supabase
          .from("tasks")
          .select("id, status, selected_workflow, result_json, created_at, error")
          .order("created_at", { ascending: false })
          .limit(100);

        const safe = (triageErr || !triageTasks) ? [] : triageTasks;
        const failedTasks = safe.filter((t: any) => t.status === "failed");

        // Group by error_code
        const countsByCode: Record<string, number> = {};
        const workflowsByCode: Record<string, Record<string, number>> = {};
        for (const t of failedTasks) {
          const code = (t as any).result_json?.error_code || "UNKNOWN";
          countsByCode[code] = (countsByCode[code] || 0) + 1;
          const wf = (t as any).selected_workflow || "unknown";
          if (!workflowsByCode[code]) workflowsByCode[code] = {};
          workflowsByCode[code][wf] = (workflowsByCode[code][wf] || 0) + 1;
        }

        // Top 3 workflows per code
        const topWorkflowsByCode: Record<string, Array<{ workflow: string; count: number }>> = {};
        for (const [code, wfs] of Object.entries(workflowsByCode)) {
          topWorkflowsByCode[code] = Object.entries(wfs)
            .map(([workflow, count]) => ({ workflow, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 3);
        }

        function fmtTs(ts?: string): string {
          if (!ts) return "";
          return ts.replace("T", " ").slice(0, 16);
        }

        const newestTs = safe[0]?.created_at ? fmtTs(safe[0].created_at) : "";
        const oldestTs = safe[safe.length - 1]?.created_at ? fmtTs(safe[safe.length - 1].created_at) : "";
        const rangeLine = newestTs && oldestTs
          ? `🕰️ *Range:* ${oldestTs} → ${newestTs}`
          : `🕰️ *Range:* —`;

        const codeLines = Object.entries(countsByCode)
          .sort(([, a], [, b]) => b - a)
          .map(([code, count]) => {
            const topWfs = (topWorkflowsByCode[code] || [])
              .map(w => `\`${w.workflow}\` (${w.count})`)
              .join(", ");
            return `*${code}*: ${count} failures\n  Top: ${topWfs || "—"}`;
          });

        const lines = [
          `🔍 *${SYSTEM_IDENTITY} — Triage*`,
          ``,
          `📊 *${failedTasks.length} failures* in last ${safe.length} tasks`,
          ``,
          ...(codeLines.length > 0 ? codeLines : ["_No failures found._"]),
          ``,
          rangeLine,
        ];

        await sendMessage(chatId, lines.join("\n"), {}, `task:${taskId}:triage`);
        await supabase.from("tasks").update({
          status: "succeeded",
          result_json: { execution_lane: "shortcut", progress_step: "shortcut_triage", summary: { countsByCode, topWorkflowsByCode, range: { oldest: oldestTs || null, newest: newestTs || null } } },
        }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      } catch (triageErr) {
        const errMsg = triageErr instanceof Error ? triageErr.message : String(triageErr);
        const failResult = buildFailureResultJson({ execution_lane: "shortcut", progress_step: "shortcut_triage_failed" }, errMsg);
        await supabase.from("tasks").update({ status: "failed", error: errMsg.slice(0, 300), result_json: failResult }).eq("id", taskId);
        await sendMessage(chatId, `❌ Failed: \`${taskId}\` — ${errMsg.slice(0, 200)}`);
      }
      _currentTaskId = null;
      return new Response("ok");
    }

    // ══════════════════════════════════════════════════════════
    // LANE 1 — EXECUTION MODE (triggered by /do <workflow>)
    // ══════════════════════════════════════════════════════════

    if (text.toLowerCase().startsWith("/do")) {
      const doArg = text.slice(3).trim(); // everything after "/do"
      if (!doArg) {
        await sendMessage(chatId, `⚠️ Usage: \`/do <workflow>\`\nRun /workflows to see available commands.`, {}, `task:${taskId}:do-usage`);
        await supabase.from("tasks").update({ status: "succeeded", result_json: { action: "do_usage" } }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      }

      await supabase.from("tasks").update({ status: "running", selected_workflow: null, result_json: { execution_lane: "lane1_do", progress_step: "lane1_routing" } }).eq("id", taskId);
      const workflows = await fetchWorkflowRegistry();

      if (workflows.length === 0) {
        await sendMessage(chatId, `⚠️ Workflow registry unavailable right now. Try /status or try again.`, {}, `task:${taskId}:registry-down`);
        const failResult = buildFailureResultJson({ execution_lane: "lane1_do", progress_step: "lane1_registry_unavailable" }, "registry_unavailable");
        await supabase.from("tasks").update({ status: "failed", error: "registry_unavailable", result_json: failResult }).eq("id", taskId);
        _currentTaskId = null;
        return new Response("ok");
      }

      const { matches, chosen } = _matchWorkflows(doArg, workflows);

      if (matches.length === 0) {
        const noMatch = _formatNoMatch(workflows);
        await sendMessage(chatId, `🚫 No executable workflow found for: \`${doArg}\`\n\n${noMatch}`, {}, `task:${taskId}:no-match`);
        await supabase.from("tasks").update({ status: "succeeded", result_json: { action: "do_no_match", input: doArg } }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      }

      if (matches.length > 1) {
        const ambiguous = matches.map((m, i) => `${i + 1}. *${m.name}* (\`${m.key}\`) — try: \`/do ${m.trigger_phrases[0] || m.key}\``).join("\n");
        await sendMessage(chatId, `🔀 Multiple workflows match. Be more specific:\n\n${ambiguous}`, {}, `task:${taskId}:ambiguous`);
        await supabase.from("tasks").update({ status: "succeeded", result_json: { action: "do_ambiguous", matches: matches.map(m => m.key) } }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      }

      // Exactly 1 match
      if (!IMPLEMENTED_WORKFLOW_KEYS.has(chosen!.key)) {
        const notImpl = [
          `✅ Registered in workflow registry, but not implemented in this bot yet.`,
          ``,
          `*Workflow:* \`${chosen!.key}\``,
          `*Tools:* ${(chosen!.tools || []).join(", ") || "—"}`,
          `*Try:* ${(chosen!.trigger_phrases || []).slice(0, 2).map(t => `\`/do ${t}\``).join(", ")}`,
        ].join("\n");
        await sendMessage(chatId, notImpl, {}, `task:${taskId}:not-impl`);
        await supabase.from("tasks").update({ status: "succeeded", result_json: { action: "not_implemented", workflow: chosen!.key } }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      }

      // Implemented — execute via agentic loop with tools
      // Set workflow attribution BEFORE the loop (so it's always stored even if loop fails)
      await supabase.from("tasks").update({
        selected_workflow: chosen!.key,
        result_json: { execution_lane: "lane1_do", progress_step: "lane1_selected_workflow", selected_workflow: chosen!.key },
      }).eq("id", taskId);

      console.log(`[LANE1] Executing workflow '${chosen!.key}' via agentic loop taskId=${taskId}`);
      const LOOP_TIMEOUT_MS = 35_000;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("TIMEOUT")), LOOP_TIMEOUT_MS)
      );
      try {
        await Promise.race([
          executeAgenticLoop(chatId, doArg, { taskId, lane: "lane1_do", allowTools: true, workflowKey: chosen!.key, sessionModel: session.active_model as "grok" | "gemini" | "chatgpt" }),
          timeoutPromise,
        ]);
      } catch (loopErr) {
        const errMsg = loopErr instanceof Error ? loopErr.message : String(loopErr);
        console.error(`[LANE1] Execution error taskId=${taskId}: ${errMsg}`);
        const failResult = buildFailureResultJson({ execution_lane: "lane1_do", progress_step: "lane1_failed", model_used: session.active_model, selected_workflow: chosen!.key }, errMsg);
        await supabase.from("tasks").update({ status: "failed", error: errMsg.slice(0, 300), result_json: failResult }).eq("id", taskId);
        await sendMessage(chatId, `❌ Failed: \`${taskId}\` — ${errMsg.slice(0, 200)}`, {}, `task:${taskId}:failed`);
      }
      _currentTaskId = null;
      return new Response("ok");
    }

    // ════════════════════════════════════════════════════════════
    // LANE 3 — AUTONOMOUS AGENT MODE
    // Open-ended requests → bot reasons, plans, awaits approval, acts
    // ════════════════════════════════════════════════════════════
    const AUTONOMOUS_TRIGGERS = [
      "figure out", "figure this out", "handle ",
      "take care of", "what should i do",
      "check everything", "review everything",
      "what's going on with", "deal with", "sort out",
      "agent mode", "autonomous", "free agent",
      "look into", "investigate", "assess", "audit",
      "think about this", "what do you recommend",
      "what's the best way", "how should i handle",
    ];
    const isAutonomousRequest =
      !hasExecutionIntent &&
      !text.toLowerCase().startsWith("/do") &&
      !text.toLowerCase().startsWith("/") &&
      AUTONOMOUS_TRIGGERS.some(t => lowerText.includes(t));

    if (isAutonomousRequest) {
      const autonomousTaskId = taskId;
      await supabase
        .from("tasks")
        .update({
          status: "running",
          selected_workflow: "free_agent",
          result_json: {
            execution_lane: "lane3_autonomous",
            selected_workflow: "free_agent",
            model_used: session.active_model,
          },
        })
        .eq("id", autonomousTaskId);

      try {
        await Promise.race([
          executeAgenticLoop(chatId, text, {
            taskId: autonomousTaskId,
            sessionModel: session.active_model as "grok" | "gemini" | "chatgpt",
            lane: "lane3_autonomous",
            allowTools: true,
            workflowKey: "free_agent",
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("TIMEOUT")), 110000)
          ),
        ]);
        await supabase
          .from("tasks")
          .update({ status: "succeeded", result_json: { execution_lane: "lane3_autonomous", progress_step: "complete" } })
          .eq("id", autonomousTaskId);
      } catch (autonomousErr) {
        const errMsg = autonomousErr instanceof Error ? autonomousErr.message : String(autonomousErr);
        const failResult = buildFailureResultJson(
          { execution_lane: "lane3_autonomous", progress_step: "autonomous_failed" },
          errMsg
        );
        await supabase
          .from("tasks")
          .update({ status: "failed", error: errMsg.slice(0, 300), result_json: failResult })
          .eq("id", autonomousTaskId);
        await sendMessage(chatId, `❌ Autonomous error: ${errMsg.slice(0, 200)}`);
      }
      _currentTaskId = null;
      return new Response("ok");
    }

    // ══════════════════════════════════════════════════════════
    // LANE 2 — ASSISTANT MODE (default, no tool execution)
    // ══════════════════════════════════════════════════════════
    console.log(`[LANE2] Assistant mode taskId=${taskId} ts=${Date.now()}`);
    const lane2Start = Date.now();
    await supabase.from("tasks").update({ status: "running", selected_workflow: "lane2_assistant", result_json: { execution_lane: "lane2_assistant", progress_step: "lane2_start" } }).eq("id", taskId);

    const model: "grok" | "gemini" = (session.active_model === "chatgpt" ? "grok" : session.active_model) as "grok" | "gemini";
    let lane2Status: "succeeded" | "failed" = "succeeded";
    let lane2Error: string | null = null;
    let assistantReply: string = "";

    try {
      const conversationContext = await buildConversationContext(chatId);

      await appendConversationTurn(chatId, {
        role: "user",
        content: text,
        model,
        at: new Date().toISOString(),
      });

      // Fetch workflow registry for context (so assistant can suggest /do commands)
      const workflows = await fetchWorkflowRegistry();
      const workflowContext = workflows.length > 0
        ? `\n\nAvailable workflows (user must run \`/do <workflow>\` to execute):\n${workflows.map(w => `- ${w.name} (\`${w.key}\`): ${w.trigger_phrases.slice(0, 2).join(", ")}`).join("\n")}`
        : "";

      const assistantSystemPrompt = `You are the ${SYSTEM_IDENTITY}. You serve Fendi Frost as a personal command center assistant.

TWO-LANE RULE — You are in ASSISTANT MODE (Lane 2).
- Answer questions, explain, draft, brainstorm, plan.
- Suggest workflows when useful.
- DO NOT output tool calls. DO NOT claim a tool was used. DO NOT simulate execution.
- When the user asks to DO something (execute, run, trigger), respond:
  "This can be executed. Reply with \`/do <workflow>\` to run it."
  and suggest the matching workflow key.

Available commands:
- /do <workflow> — Execute a workflow (Lane 1)
- /status — System status
- /ping — Connectivity test
- /workflows — See all registered workflows
- /help — Quick help
${workflowContext}

Conversation Context:
${conversationContext}

Be concise, professional, and use emoji sparingly.`;

      const ASSISTANT_TIMEOUT_MS = 20_000;
      const assistantTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("TIMEOUT")), ASSISTANT_TIMEOUT_MS)
      );

      let aiResponse: string;
      if (model === "grok") {
        const resp = await Promise.race([fetch("https://api.x.ai/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${GROK_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "grok-3-mini-fast",
            messages: [
              { role: "system", content: assistantSystemPrompt },
              { role: "user", content: text },
            ],
            max_tokens: 1024,
          }),
        }), assistantTimeout]);
        const data = await resp.json();
        aiResponse = data.choices?.[0]?.message?.content || "I'm not sure how to help with that. Try /workflows.";
      } else {
        const resp = await Promise.race([fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text }] }],
              systemInstruction: { parts: [{ text: assistantSystemPrompt }] },
              generationConfig: { maxOutputTokens: 1024 },
            }),
          }
        ), assistantTimeout]);
        const data = await resp.json();
        aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "I'm not sure how to help with that. Try /workflows.";
      }

      assistantReply = formatAssistantMessage(model, aiResponse);

      await sendMessage(chatId, assistantReply, {}, `task:${taskId}:assistant`);
      await appendConversationTurn(chatId, {
        role: "assistant",
        content: assistantReply,
        model,
        at: new Date().toISOString(),
      });
    } catch (aiErr) {
      const errMsg = aiErr instanceof Error ? aiErr.message : String(aiErr);
      console.error(`[LANE2] AI error taskId=${taskId}: ${errMsg}`);
      lane2Status = "failed";
      lane2Error = errMsg;
      assistantReply = formatAssistantMessage(model, "⚠️ AI unavailable right now. Try /status or /workflows.");
      await sendMessage(chatId, assistantReply, {}, `task:${taskId}:assistant`);
    } finally {
      // HARD GUARANTEE: Lane 2 task always reaches terminal state
      const lane2Duration = Date.now() - lane2Start;
      if (lane2Status === "succeeded") {
        await supabase.from("tasks").update({
          status: "succeeded",
          result_json: { execution_lane: "lane2_assistant", progress_step: "lane2_done", model_used: model, text_response: assistantReply.slice(0, 2000), execution_duration_ms: lane2Duration },
        }).eq("id", taskId);
        await sendMessage(chatId, `✅ Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      } else {
        const failResult = buildFailureResultJson({ execution_lane: "lane2_assistant", progress_step: "lane2_failed", model_used: model }, lane2Error || "unknown", lane2Start);
        await supabase.from("tasks").update({
          status: "failed",
          error: (lane2Error || "unknown").slice(0, 300),
          result_json: failResult,
        }).eq("id", taskId);
        await sendMessage(chatId, `❌ Failed: \`${taskId}\` — ${(lane2Error || "unknown").slice(0, 200)}`, {}, `task:${taskId}:failed`);
      }
      _currentTaskId = null;
    }
    return new Response("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response("ok");
  }
});

async function callFanFuelHub(functionName: string, body: any) {
  const url = Deno.env.get("FANFUEL_HUB_URL");
  const key = Deno.env.get("FANFUEL_HUB_KEY");
  if (!url || !key) throw new Error("FANFUEL_HUB_URL or FANFUEL_HUB_KEY not configured");
  const resp = await fetch(`${url}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // FanFuel Hub's `control-center-api` authenticates using `x-api-key`.
      "x-api-key": key,
      // Keep these for compatibility with other deployments/endpoints.
      "Authorization": `Bearer ${key}`,
      "apikey": key,
    },
    body: JSON.stringify(body),
  });
  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`FanFuel Hub error ${resp.status}: ${raw.slice(0, 500)}`);
  }
  // Avoid opaque JSON parse errors: Hub must return JSON; if not, surface first bytes for debugging.
  try {
    return raw.length ? JSON.parse(raw) : {};
  } catch (e) {
    const preview = raw.slice(0, 120).replace(/\s+/g, " ");
    throw new Error(
      `FanFuel Hub returned non-JSON (HTTP ${resp.status}): ${preview}${raw.length > 120 ? "…" : ""}`
    );
  }
}

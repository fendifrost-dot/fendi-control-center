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
  "analyze_credit_strategy",
  "generate_dispute_letter",
  "send_dispute_letter",
  "research_playlists",
  "generate_pitch",
  "send_pitch",
  "credit_analysis_and_disputes",
  "playlist_pitch_workflow",
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

const SYNTHETIC_ANALYZE_CREDIT_STRATEGY: WorkflowEntry = {
  key: "analyze_credit_strategy",
  name: "Analyze Credit Strategy",
  description: "Analyze a client's credit profile and return prioritized dispute strategy.",
  trigger_phrases: ["analyze credit strategy", "analyze client credit", "credit strategy"],
  tools: ["analyze_credit_strategy"],
};

const SYNTHETIC_PLAYLIST_PITCH_WORKFLOW: WorkflowEntry = {
  key: "playlist_pitch_workflow",
  name: "Playlist Pitch Workflow",
  description: "Research playlist opportunities, draft a pitch, and send after approval.",
  trigger_phrases: ["research playlists", "playlist pitch workflow", "generate pitch"],
  tools: ["research_playlists", "generate_pitch", "send_pitch"],
};

const SYNTHETIC_QUERY_CREDIT_COMPASS: WorkflowEntry = {
  key: "query_credit_compass",
  name: "Query Credit Compass",
  description: "Create/review new-client credit assessment files and dispute strategy context.",
  trigger_phrases: ["credit compass", "new client credit file", "blank client credit report"],
  tools: ["query_credit_compass", "query_credit_guardian"],
};

const SYNTHETIC_QUERY_CC_TAX: WorkflowEntry = {
  key: "query_cc_tax",
  name: "Query CC Tax",
  description: "Run CC Tax status, transactions, documents, and discrepancy checks.",
  trigger_phrases: ["tax status", "tax generator", "tax discrepancies", "tax documents", "tax transactions"],
  tools: ["query_cc_tax"],
};

// ─── Workflow key aliases (deprecated → canonical) ──────────
// Routes old keys to new canonical handlers. "/do analyze_client_credit" → analyze_credit_strategy
const WORKFLOW_KEY_ALIASES: Record<string, string> = {
  analyze_client_credit: "analyze_credit_strategy",
};

function _resolveWorkflowKey(key: string): string {
  return WORKFLOW_KEY_ALIASES[key] || key;
}


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
    const status = IMPLEMENTED_WORKFLOW_KEYS.has(wf.key) ? "â Implemented" : "â ï¸ Not Implemented";
    const triggers = (wf.trigger_phrases || []).slice(0, 4).join(", ");
    const tools = (wf.tools || []).join(", ") || "â";
    return `*${wf.name}* â \`${wf.key}\`\n  ${wf.description}\n  Triggers: ${triggers}\n  Tools: ${tools}\n  Status: ${status}`;
  });
  return `ð *Workflow Registry*\n\n${lines.join("\n\n")}`;
}

function _formatNoMatch(workflows: WorkflowEntry[]): string {
  const suggestions = workflows.slice(0, 6)
    .map((wf) => `â¢ *${wf.name}* â try: \`${wf.trigger_phrases[0] || wf.key}\``)
    .join("\n");
  return `â No matching workflow for that request.\n\nRun /workflows to see everything available.\n\nSuggestions:\n${suggestions}`;
}

async function classifyNaturalLanguageIntent(
  userMessage: string,
  workflows: WorkflowEntry[]
): Promise<WorkflowEntry | null> {
  try {
    const implemented = workflows
      .filter((w) => IMPLEMENTED_WORKFLOW_KEYS.has(w.key))
      .map((w) => ({
        key: w.key,
        name: w.name,
        triggers: w.trigger_phrases.slice(0, 4).join(", "),
        description: w.description,
      }));

    if (implemented.length === 0) return null;

    const workflowList = implemented
      .map((w) => `- ${w.key}: ${w.name} (triggers: ${w.triggers}) — ${w.description}`)
      .join("\n");

    const prompt = `You are an intent classifier. Given the user message, determine if they want to EXECUTE an action.
If yes, respond with ONLY the matching workflow key. If it is just a question or conversation, respond NONE.

Rules:
- "pitch X to playlists" or "pitch X" → playlist_pitch_workflow
- "analyze credit" or "run credit analysis" → analyze_credit_strategy
- "generate dispute" or "send dispute" → credit_analysis_and_disputes
- "check system status" or "system status" → system_status
- "retry failed" or "resend failed" → resend_failed
- "sync drive" or "pull from drive" → drive_sync
- "show clients" or "list clients" → client_overview
- Greetings, questions, "what is", "how does", "explain" → NONE

Available workflows:
${workflowList}

User message: "${userMessage}"

Respond with ONLY the workflow key or NONE.`;

    const callClassifier = async () =>
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 50 },
          }),
        }
      );

    let res = await callClassifier();
    if (res.status === 429) {
      console.log("[NL_CLASSIFY] 429 received, retrying in 1s...");
      await new Promise((r) => setTimeout(r, 1000));
      res = await callClassifier();
    }

    if (!res.ok) {
      console.error("[NL_CLASSIFY] Gemini call failed:", res.status);
      return null;
    }

    const json = await res.json();
    const rawText =
      json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    const cleaned = rawText.replace(/[^a-zA-Z0-9_]/g, "");

    if (!cleaned || cleaned.toUpperCase() === "NONE") return null;

    const match = workflows.find(
      (w) => w.key.toLowerCase() === cleaned.toLowerCase()
    );
    if (match && IMPLEMENTED_WORKFLOW_KEYS.has(match.key)) return match;

    return null;
  } catch (e) {
    console.error("[NL_CLASSIFY] Error:", e);
    return null;
  }
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
  const headerText = `ð¤ *${SYSTEM_IDENTITY}* _(Model: ${getModelLabel(model)})_`;
  await enqueueTelegram(taskId, chatId, "sendMessage", {
    chat_id: chatId, text: headerText, parse_mode: "Markdown",
  }, `task:${taskId}:header`);
  await flushTelegramOutbox(chatId, 1);
}

// âââ Outbox-aware Telegram delivery âââââââââââââââââââââââââââââ
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
        } else if (result.description?.includes("can't parse entities") && (row.payload as any)?.parse_mode) {
          console.warn("[OUTBOX] Parse error, retrying without parse_mode:", result.description);
          const plainPayload = { ...(row.payload as Record<string, any>) };
          delete plainPayload.parse_mode;
          const retry = await _rawTelegramSend(row.kind || "sendMessage", plainPayload);
          if (retry.ok) {
            await supabase.from("telegram_outbox").update({ status: "sent", sent_at: new Date().toISOString(), last_error: "parse_mode_fallback" }).eq("id", row.id);
            sent++;
          } else {
            const backoff = Math.min(Math.pow(row.attempt_count + 1, 2) * 5, 120);
            await supabase.from("telegram_outbox").update({
              status: "failed", last_error: retry.description || JSON.stringify(retry).slice(0, 500),
              next_attempt_at: new Date(Date.now() + backoff * 1000).toISOString(),
            }).eq("id", row.id);
            failed++;
          }
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

// âââ Model & conversation state helpers âââââââââââââââââââââââââ
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

  // No session exists â default to grok
  return { model: "grok", session_created: true };
}

function getModelLabel(model: "gemini" | "grok"): string {
  return model === "grok" ? "Grok" : "Gemini";
}

function formatAssistantMessage(model: "gemini" | "grok", text: string): string {
  return `ð¤ *${SYSTEM_IDENTITY}* _(Model: ${getModelLabel(model)})_\n\n${text}`;
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

// âââ Fetch last 3 processed documents for context âââââââââââââââ
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

// âââ Session & Task helpers (deterministic spine) âââââââââââââââ

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

// âââ Error code classifier âââââââââââââââââââââââââââââââââââââ
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

// âââ Cross-project helpers ââââââââââââââââââââââââââââââââââââââ
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

// âââ System health check ââââââââââââââââââââââââââââââââââââââââ
function systemHealthCheck() {
  return {
    timestamp_ms: Date.now(),
    uptime_ms: Math.round(performance.now()),
    tool_count: AGENT_TOOLS.length,
    implemented_workflow_count: IMPLEMENTED_WORKFLOW_KEYS.size,
  };
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// âââ AGENTIC TOOL DEFINITIONS âââââââââââââââââââââââââââââââââ
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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





    // /start still shows the help menu
    if (text === "/start") {
      await setShortcutAttribution(taskId, "start");
      await sendMessage(chatId, [
        `ð¯ *${SYSTEM_IDENTITY} â Online (Two-Lane Mode)*`,
        ``,
        `ð¬ *Lane 2 (Default):* Just talk to me â I'll answer, explain, draft, plan.`,
        `â¡ *Lane 1 (Execute):* Prefix with \`/do\` to run a workflow.`,
        ``,
        `*Examples:*`,
        `â¢ "What's broken today?" â I'll explain (Lane 2)`,
        `â¢ \`/do status\` â Executes system status check (Lane 1)`,
        `â¢ \`/do retry failed jobs\` â Executes retry workflow (Lane 1)`,
        `â¢ "How are my projects doing?" â I'll discuss (Lane 2)`,
        ``,
        `*Commands:*`,
        `â¢ /status â System status`,
        `â¢ /metrics â Metrics + recent tasks`,
        `â¢ /ping â Connectivity test`,
        `â¢ /workflows â See all registered workflows`,
        `â¢ /help â Quick help`,
        `â¢ /do <workflow> â Execute a workflow`,
        `â¢ /model â Check or switch AI model`,
        ``,
        `ð *Observability:*`,
        `â¢ /status â health snapshot`,
        `â¢ /metrics â last 20 tasks + durations`,
        ``,
        `ð I will NEVER execute tools unless you use \`/do\` or a direct command.`,
      ].join("\n"));
      await supabase.from("tasks").update({ status: "succeeded", result_json: { execution_lane: "shortcut", progress_step: "shortcut_start", action: "start_help" } }).eq("id", taskId);
      await sendMessage(chatId, `â Done: \`${taskId}\``);
      return new Response("ok");
    }

    if (text.toLowerCase() === "/model") {
      await setShortcutAttribution(taskId, "model");
      await sendMessage(chatId, `ð¤ *${SYSTEM_IDENTITY}*\n\nActive model: *${getModelLabel(session.active_model as any)}*\nð Model switching is locked until you explicitly run /model grok or /model gemini.`);
      await supabase.from("tasks").update({ status: "succeeded", result_json: { execution_lane: "shortcut", progress_step: "shortcut_model", action: "model_check", active_model: session.active_model } }).eq("id", taskId);
      await sendMessage(chatId, `â Done: \`${taskId}\``);
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
      await sendMessage(chatId, `â *${SYSTEM_IDENTITY}* switched to *${getModelLabel(reqModel as any)}*.\n\nI'll stay on this model until you switch again.`);
      await supabase.from("tasks").update({ status: "succeeded", result_json: { execution_lane: "shortcut", progress_step: "shortcut_model_switch", action: "model_switch", new_model: reqModel } }).eq("id", taskId);
      await sendMessage(chatId, `â Done: \`${taskId}\``);
      return new Response("ok");
    }

    // ââ /ping â outbox dogfood test ââ
    if (text.toLowerCase() === "/ping") {
      await setShortcutAttribution(taskId, "ping");
      await sendMessage(chatId, `ð pong`, {}, `task:${taskId}:pong`);
      await supabase.from("tasks").update({ status: "succeeded", result_json: { execution_lane: "shortcut", progress_step: "shortcut_ping", action: "ping" } }).eq("id", taskId);
      await sendMessage(chatId, `â Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      _currentTaskId = null;
      return new Response("ok");
    }

    // ââ /resend_failed â flush failed outbox items ââ
    if (text.toLowerCase() === "/resend_failed") {
      await setShortcutAttribution(taskId, "resend_failed");
      const { sent, failed } = await flushTelegramOutbox(chatId, 10);
      await sendMessage(chatId, `ð¤ *Outbox flush:* ${sent} sent, ${failed} failed`, {}, `task:${taskId}:resend`);
      await supabase.from("tasks").update({ status: "succeeded", result_json: { execution_lane: "shortcut", progress_step: "shortcut_resend_failed", action: "resend_failed", sent, failed } }).eq("id", taskId);
      await sendMessage(chatId, `â Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      _currentTaskId = null;
      return new Response("ok");
    }

    // ââ Direct "status" shortcut â bypasses AI entirely ââ
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
            `ð *Documents Processed:* ${parsed.documents_processed ?? 0}`,
            `â³ *Pending Approvals:* ${parsed.pending_approvals ?? 0}`,
            `â¡ *Active Jobs:* ${parsed.active_jobs ?? 0}`,
            `â *Failed Jobs:* ${parsed.failed_jobs ?? 0}`,
            `ð§ *Tool Calls (1h):* ${parsed.recent_tool_calls_1h ?? 0}`,
            `ð¤ *Active Model:* ${parsed.active_model ?? "unknown"}`,
          ];
          if (parsed.errors?.length) {
            lines.push(``, `â ï¸ *Errors:* ${parsed.errors.length} query failures`);
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
            const projectLines: string[] = [``, `ð *Connected Projects (${projects.length})*`];
            for (const p of projects) {
              const stats = await fetchProjectStats(p);
              if (stats?.tables) {
                const tableCount = Object.keys(stats.tables).length;
                const totalRows = Object.values(stats.tables).reduce((a: number, b: any) => a + (Number(b) || 0), 0);
                projectLines.push(`  â *${p.name}* â ${tableCount} tables, ${totalRows} rows`);
              } else {
                projectLines.push(`  â *${p.name}* â unreachable`);
              }
            }
            projectSection = projectLines.join("\n");
          }
        } catch (projErr) {
          console.error("Status: project stats error:", projErr);
          projectSection = `\n\nâ ï¸ Could not fetch project stats`;
        }

        const reply = formatAssistantMessage(model, `ð *System Status*\n\n${formattedStatus}${projectSection}\n\nð¥ *Health:* uptime=${Math.round(health.uptime_ms / 1000)}s tools=${health.tool_count} workflows=${health.implemented_workflow_count}`);
        await sendMessage(chatId, reply);
        await supabase.from("tasks").update({
          status: "succeeded",
          selected_tools: ["get_system_status"],
          result_json: { execution_lane: "shortcut", progress_step: "shortcut_status", result: statusResult, health, model_used: session.active_model },
        }).eq("id", taskId);
        await sendMessage(chatId, `â Done: \`${taskId}\``);
      } catch (statusErr) {
        const errMsg = statusErr instanceof Error ? statusErr.message : String(statusErr);
        console.error("Status shortcut error:", statusErr);
        const failResult = buildFailureResultJson({ execution_lane: "shortcut", progress_step: "shortcut_status_failed", model_used: session.active_model }, errMsg);
        await supabase.from("tasks").update({ status: "failed", error: errMsg.slice(0, 300), result_json: failResult }).eq("id", taskId);
        await sendMessage(chatId, `â Failed: \`${taskId}\` â ${errMsg.slice(0, 200)}`);
      }
      return new Response("ok");
    }

    // ââ /workflows â list from DB registry ââ
    if (text.toLowerCase() === "/workflows") {
      await setShortcutAttribution(taskId, "workflows");
      const workflows = await fetchWorkflowRegistry();
      const listText = workflows.length > 0
        ? _formatWorkflowList(workflows)
        : "â ï¸ Workflow registry unavailable right now. Try /status or try again.";
      await sendMessage(chatId, listText, {}, `task:${taskId}:workflows`);
      await supabase.from("tasks").update({ status: "succeeded", result_json: { execution_lane: "shortcut", progress_step: "shortcut_workflows", action: "list_workflows" } }).eq("id", taskId);
      await sendMessage(chatId, `â Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      _currentTaskId = null;
      return new Response("ok");
    }

    // ââ /help â short help ââ
    if (text.toLowerCase() === "/help") {
      await setShortcutAttribution(taskId, "help");
      const helpText = [
        `ð¯ *${SYSTEM_IDENTITY} â Quick Help*`,
        ``,
        `*Two-Lane System:*`,
        `ð¬ Just type normally â Assistant mode (Lane 2)`,
        `â¡ \`/do <workflow>\` â Execution mode (Lane 1)`,
        ``,
        `*Commands:*`,
        `â¢ /status â System status`,
        `â¢ /metrics â Metrics + recent tasks`,
        `â¢ /ping â Connectivity test`,
        `â¢ /resend\\_failed â Retry failed outbox items`,
        `â¢ /workflows â See all available workflows`,
        `â¢ /do <workflow> â Execute a specific workflow`,
        `â¢ /model â Check or switch AI model`,
        ``,
        `ð¡ Tip: run \`/metrics\` to inspect recent task runs and durations.`,
      ].join("\n");
      await sendMessage(chatId, helpText, {}, `task:${taskId}:help`);
      await supabase.from("tasks").update({ status: "succeeded", result_json: { execution_lane: "shortcut", progress_step: "shortcut_help", action: "help" } }).eq("id", taskId);
      await sendMessage(chatId, `â Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      _currentTaskId = null;
      return new Response("ok");
    }

    // ââ /metrics â execution metrics ââ
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
            case "succeeded": return "â";
            case "running": return "â³";
            case "failed": return "â";
            case "queued": return "ð";
            default: return "â¢";
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
          return `ð *Summary:* â ${s("succeeded")}  â³ ${s("running")}  â ${s("failed")}  ð ${s("queued")}`;
        }

        const taskSummaries = safeTasks.map((t: any) => {
          const shortId = (t.id || "").slice(0, 8) || "unknown";
          const lockHeld = t.status === "running" && Boolean(t.result_json?.execution_lock) ? "on" : "off";
          const dur = fmtDuration(t.result_json?.execution_duration_ms);
          const ts = fmtTs(t.created_at);
          const icon = statusIcon(t.status);
          const wf = t.selected_workflow || "â";
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
          ? `ð°ï¸ *Range:* ${oldestTs} â ${newestTs}`
          : `ð°ï¸ *Range:* â`;

        const lines = [
          `ð *${SYSTEM_IDENTITY} â Metrics*`,
          ``,
          `ð¥ *Health:* uptime=${Math.round(health.uptime_ms / 1000)}s tools=${health.tool_count} workflows=${health.implemented_workflow_count}`,
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
        await sendMessage(chatId, `â Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      } catch (metricsErr) {
        const errMsg = metricsErr instanceof Error ? metricsErr.message : String(metricsErr);
        const failResult = buildFailureResultJson({ execution_lane: "shortcut", progress_step: "shortcut_metrics_failed" }, errMsg);
        await supabase.from("tasks").update({ status: "failed", error: errMsg.slice(0, 300), result_json: failResult }).eq("id", taskId);
        await sendMessage(chatId, `â Failed: \`${taskId}\` â ${errMsg.slice(0, 200)}`);
      }
      _currentTaskId = null;
      return new Response("ok");
    }

    // ââ /triage â failure root-cause summary ââ
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
          ? `ð°ï¸ *Range:* ${oldestTs} â ${newestTs}`
          : `ð°ï¸ *Range:* â`;

        const codeLines = Object.entries(countsByCode)
          .sort(([, a], [, b]) => b - a)
          .map(([code, count]) => {
            const topWfs = (topWorkflowsByCode[code] || [])
              .map(w => `\`${w.workflow}\` (${w.count})`)
              .join(", ");
            return `*${code}*: ${count} failures\n  Top: ${topWfs || "â"}`;
          });

        const lines = [
          `ð *${SYSTEM_IDENTITY} â Triage*`,
          ``,
          `ð *${failedTasks.length} failures* in last ${safe.length} tasks`,
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
        await sendMessage(chatId, `â Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      } catch (triageErr) {
        const errMsg = triageErr instanceof Error ? triageErr.message : String(triageErr);
        const failResult = buildFailureResultJson({ execution_lane: "shortcut", progress_step: "shortcut_triage_failed" }, errMsg);
        await supabase.from("tasks").update({ status: "failed", error: errMsg.slice(0, 300), result_json: failResult }).eq("id", taskId);
        await sendMessage(chatId, `â Failed: \`${taskId}\` â ${errMsg.slice(0, 200)}`);
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
        await sendMessage(chatId, `â ï¸ Usage: \`/do <workflow>\`\nRun /workflows to see available commands.`, {}, `task:${taskId}:do-usage`);
        await supabase.from("tasks").update({ status: "succeeded", result_json: { action: "do_usage" } }).eq("id", taskId);
        await sendMessage(chatId, `â Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      }

      await supabase.from("tasks").update({ status: "running", selected_workflow: null, result_json: { execution_lane: "lane1_do", progress_step: "lane1_routing" } }).eq("id", taskId);
      const workflows = await fetchWorkflowRegistry();

      if (workflows.length === 0) {
        await sendMessage(chatId, `â ï¸ Workflow registry unavailable right now. Try /status or try again.`, {}, `task:${taskId}:registry-down`);
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
        const ambiguous = matches.map((m, i) => `${i + 1}. *${m.name}* (\`${m.key}\`) â try: \`/do ${m.trigger_phrases[0] || m.key}\``).join("\n");
        await sendMessage(chatId, `ð Multiple workflows match. Be more specific:\n\n${ambiguous}`, {}, `task:${taskId}:ambiguous`);
        await supabase.from("tasks").update({ status: "succeeded", result_json: { action: "do_ambiguous", matches: matches.map(m => m.key) } }).eq("id", taskId);
        await sendMessage(chatId, `â Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      }

      // Exactly 1 match
      if (!IMPLEMENTED_WORKFLOW_KEYS.has(chosen!.key)) {
        const notImpl = [
          `â Registered in workflow registry, but not implemented in this bot yet.`,
          ``,
          `*Workflow:* \`${chosen!.key}\``,
          `*Tools:* ${(chosen!.tools || []).join(", ") || "â"}`,
          `*Try:* ${(chosen!.trigger_phrases || []).slice(0, 2).map(t => `\`/do ${t}\``).join(", ")}`,
        ].join("\n");
        await sendMessage(chatId, notImpl, {}, `task:${taskId}:not-impl`);
        await supabase.from("tasks").update({ status: "succeeded", result_json: { action: "not_implemented", workflow: chosen!.key } }).eq("id", taskId);
        await sendMessage(chatId, `â Done: \`${taskId}\``, {}, `task:${taskId}:done`);
        _currentTaskId = null;
        return new Response("ok");
      }

      // Implemented â execute via agentic loop with tools
      // Set workflow attribution BEFORE the loop (so it's always stored even if loop fails)
      await supabase.from("tasks").update({
        selected_workflow: chosen!.key,
        result_json: { execution_lane: "lane1_do", progress_step: "lane1_selected_workflow", selected_workflow: chosen!.key },
      }).eq("id", taskId);

      console.log(`[LANE1] Executing workflow '${chosen!.key}' via agentic loop taskId=${taskId}`);
      const LOOP_TIMEOUT_MS = 50_000;
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
        await sendMessage(chatId, `â Failed: \`${taskId}\` â ${errMsg.slice(0, 200)}`, {}, `task:${taskId}:failed`);
      }
    await flushTelegramOutbox(chatId, 10);
      _currentTaskId = null;
      return new Response("ok");
    }

    // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    // LANE 3 â AUTONOMOUS AGENT MODE
    // Open-ended requests â bot reasons, plans, awaits approval, acts
    // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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
        await sendMessage(chatId, `â Autonomous error: ${errMsg.slice(0, 200)}`);
      }
      _currentTaskId = null;
      return new Response("ok");
    }

    // ══════════════════════════════════════════════════════════
    // NL INTENT CLASSIFICATION — auto-promote to Lane 1 if Gemini detects execution intent
    // ══════════════════════════════════════════════════════════
    if (!text.startsWith("/") && !hasExecutionIntent && !isAutonomousRequest) {
      const nlWorkflows = await fetchWorkflowRegistry();
      const nlMatch = await classifyNaturalLanguageIntent(text, nlWorkflows);
      if (nlMatch) {
        console.log(`[NL_CLASSIFY] Auto-promoting to Lane 1: workflow=${nlMatch.key} taskId=${taskId}`);
        await supabase.from("tasks").update({
          status: "running",
          selected_workflow: nlMatch.key,
          result_json: {
            execution_lane: "lane1_do",
            nl_classified: true,
            selected_workflow: nlMatch.key,
          },
        }).eq("id", taskId);

        try {
          await Promise.race([
            executeAgenticLoop(chatId, text, {
              taskId,
              lane: "lane1_do",
              allowTools: true,
              workflowKey: nlMatch.key,
              sessionModel: session.active_model as "grok" | "gemini" | "chatgpt",
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("TIMEOUT")), 55000)
            ),
          ]);
        } catch (nlErr) {
          const errMsg = nlErr instanceof Error ? nlErr.message : String(nlErr);
          const failResult = buildFailureResultJson(
            { execution_lane: "lane1_do", nl_classified: true },
            errMsg
          );
          await supabase.from("tasks").update({
            status: "failed",
            error: errMsg.slice(0, 300),
            result_json: failResult,
          }).eq("id", taskId);
          await sendMessage(chatId, `\u274c Failed: \`${taskId}\` \u2014 ${errMsg.slice(0, 200)}`, {}, `task:${taskId}:failed`);
        }
        _currentTaskId = null;
        return new Response("ok");
      }
    }

    // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
    // LANE 2 â ASSISTANT MODE (default, no tool execution)
    // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

TWO-LANE RULE â You are in ASSISTANT MODE (Lane 2).
- Answer questions, explain, draft, brainstorm, plan.
- Suggest workflows when useful.
- DO NOT output tool calls. DO NOT claim a tool was used. DO NOT simulate execution.
- When the user asks to DO something (execute, run, trigger), respond:
  "This can be executed. Reply with \`/do <workflow>\` to run it."
  and suggest the matching workflow key.

CREDIT ANALYSIS ROUTING: When the user asks about credit reports, credit analysis, credit disputes, or anything related to analyzing a client's credit â suggest /do analyze_client_credit. This is the full pipeline that syncs Drive, ingests documents, and runs Credit Guardian analysis. Do NOT suggest /do client_overview for credit analysis requests..

Available commands:
- /do <workflow> â Execute a workflow (Lane 1)
- /status â System status
- /ping â Connectivity test
- /workflows â See all registered workflows
- /help â Quick help
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
      assistantReply = formatAssistantMessage(model, "â ï¸ AI unavailable right now. Try /status or /workflows.");
      await sendMessage(chatId, assistantReply, {}, `task:${taskId}:assistant`);
    } finally {
      // HARD GUARANTEE: Lane 2 task always reaches terminal state
      const lane2Duration = Date.now() - lane2Start;
      if (lane2Status === "succeeded") {
        await supabase.from("tasks").update({
          status: "succeeded",
          result_json: { execution_lane: "lane2_assistant", progress_step: "lane2_done", model_used: model, text_response: assistantReply.slice(0, 2000), execution_duration_ms: lane2Duration },
        }).eq("id", taskId);
        await sendMessage(chatId, `â Done: \`${taskId}\``, {}, `task:${taskId}:done`);
      } else {
        const failResult = buildFailureResultJson({ execution_lane: "lane2_assistant", progress_step: "lane2_failed", model_used: model }, lane2Error || "unknown", lane2Start);
        await supabase.from("tasks").update({
          status: "failed",
          error: (lane2Error || "unknown").slice(0, 300),
          result_json: failResult,
        }).eq("id", taskId);
        await sendMessage(chatId, `â Failed: \`${taskId}\` â ${(lane2Error || "unknown").slice(0, 200)}`, {}, `task:${taskId}:failed`);
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
        "x-api-key": key,
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

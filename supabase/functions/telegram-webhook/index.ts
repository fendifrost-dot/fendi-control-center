import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const BOT_TOKEN = Deno.env.get("FendiAIbot")!;
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_KEY = Deno.env.get("Frost_Gemini")!;
const GROK_KEY = Deno.env.get("Frost_Grok")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const SYSTEM_IDENTITY = "Fendi Control Center AI";

// ─── Telegram helpers ───────────────────────────────────────────
async function sendMessage(chatId: string, text: string, options: any = {}) {
  const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", ...options }),
  });
  return resp.json();
}

async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

async function editMessageReplyMarkup(chatId: string, messageId: number) {
  await fetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  });
}

// ─── Get active AI model ────────────────────────────────────────
async function getActiveModel(): Promise<string> {
  const { data } = await supabase
    .from("bot_settings")
    .select("setting_value")
    .eq("setting_key", "ai_model")
    .single();
  return data?.setting_value || "gemini";
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

// ─── Cross-project helpers ──────────────────────────────────────
async function getConnectedProjects() {
  const { data } = await supabase
    .from("connected_projects")
    .select("*")
    .eq("is_active", true)
    .order("name");
  return data || [];
}

async function fetchProjectStats(project: any): Promise<{ name: string; tables: Record<string, number> } | null> {
  try {
    const resp = await fetch(`${project.supabase_url}/functions/v1/project-stats`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// ─── AGENTIC TOOL DEFINITIONS ─────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// Each tool: { name, description, parameters, destructive, execute }
// destructive tools require confirmation before execution

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, any>;
  destructive: boolean;
  execute: (args: any) => Promise<string>;
}

const AGENT_TOOLS: ToolDef[] = [
  {
    name: "get_system_status",
    description: "Get overall system status: document counts, pending approvals, active/failed jobs, and current AI model.",
    parameters: { type: "object", properties: {}, required: [] },
    destructive: false,
    execute: async () => {
      const { data: pending } = await supabase.from("telegram_approval_queue").select("id").eq("status", "pending");
      const { data: jobs } = await supabase.from("ingestion_jobs").select("id, status").in("status", ["queued", "processing", "retrying"]);
      const { data: failedJobs } = await supabase.from("ingestion_jobs").select("id").eq("status", "failed");
      const { data: docs } = await supabase.from("documents").select("id").eq("status", "completed");
      const model = await getActiveModel();
      return JSON.stringify({
        documents_processed: docs?.length || 0,
        pending_approvals: pending?.length || 0,
        active_jobs: jobs?.length || 0,
        failed_jobs: failedJobs?.length || 0,
        active_model: model,
      });
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
    description: "Switch the active AI model between 'gemini' and 'grok'.",
    parameters: { type: "object", properties: { model: { type: "string", enum: ["gemini", "grok"], description: "The model to switch to" } }, required: ["model"] },
    destructive: false,
    execute: async (args: any) => {
      await supabase.from("bot_settings").upsert({ setting_key: "ai_model", setting_value: args.model, updated_at: new Date().toISOString() }, { onConflict: "setting_key" });
      return `Switched to ${args.model}.`;
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
];

// ─── Build tool schemas for AI models ───────────────────────────

function getGeminiToolDeclarations() {
  return AGENT_TOOLS.map(t => ({
    name: t.name,
    description: t.description + (t.destructive ? " [DESTRUCTIVE - requires user confirmation]" : ""),
    parameters: t.parameters,
  }));
}

function getGrokToolSchemas() {
  return AGENT_TOOLS.map(t => ({
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

// ─── Agentic AI call with tool use ─────────────────────────────

async function agenticGeminiCall(userMessage: string, docContext: string): Promise<{ text: string; toolCalls: Array<{ name: string; args: any }> }> {
  const systemPrompt = `You are the ${SYSTEM_IDENTITY}. You serve Fendi Frost as a personal command center assistant.
You have access to tools to check system status, manage jobs, approvals, projects, and more.
Use tools when the user's request requires data or actions. You can call multiple tools in sequence.
For destructive actions (retry, archive, approve, reject), ALWAYS call the tool — the system will handle confirmation.
Be concise, professional, and use emoji sparingly.

Recent Documents Context:
${docContext}`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        tools: [{ functionDeclarations: getGeminiToolDeclarations() }],
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

async function agenticGrokCall(userMessage: string, docContext: string): Promise<{ text: string; toolCalls: Array<{ name: string; args: any }> }> {
  const systemPrompt = `You are the ${SYSTEM_IDENTITY}. You serve Fendi Frost as a personal command center assistant.
You have access to tools to check system status, manage jobs, approvals, projects, and more.
Use tools when the user's request requires data or actions. You can call multiple tools.
For destructive actions (retry, archive, approve, reject), ALWAYS call the tool — the system will handle confirmation.
Be witty, direct, and concise. Use emoji sparingly.

Recent Documents Context:
${docContext}`;

  const resp = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROK_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "grok-3-mini-fast",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      tools: getGrokToolSchemas(),
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

// ─── Execute agentic loop ──────────────────────────────────────

async function executeAgenticLoop(chatId: string, userMessage: string): Promise<void> {
  const model = await getActiveModel();
  const docContext = await getRecentDocContext();

  // Step 1: Get AI response with tool calls
  const result = model === "grok"
    ? await agenticGrokCall(userMessage, docContext)
    : await agenticGeminiCall(userMessage, docContext);

  // Step 2: If no tool calls, just send the text response
  if (result.toolCalls.length === 0) {
    await sendMessage(chatId, result.text || "I'm not sure how to help with that. Try /start for available commands.");
    return;
  }

  // Step 3: Execute tool calls
  const toolResults: string[] = [];
  const confirmationButtons: Array<{ text: string; callback_data: string }> = [];

  for (const tc of result.toolCalls) {
    const tool = AGENT_TOOLS.find(t => t.name === tc.name);
    if (!tool) {
      toolResults.push(`❓ Unknown tool: ${tc.name}`);
      continue;
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
    } else {
      // Execute immediately
      try {
        const output = await tool.execute(tc.args);
        toolResults.push(output);
      } catch (e) {
        console.error(`Tool ${tc.name} error:`, e);
        toolResults.push(`❌ Error executing ${tc.name}.`);
      }
    }
  }

  // Step 4: If we have tool results, feed them back to AI for a final summary
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

    await sendMessage(chatId, summary);
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

    await sendMessage(chatId, message.trim(), {
      reply_markup: { inline_keyboard: keyboard },
    });
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
  const model = await getActiveModel();
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

    // ── Callback queries (inline button presses) ──
    if (update.callback_query) {
      const cb = update.callback_query;
      const cbChatId = String(cb.message.chat.id);
      if (cbChatId !== CHAT_ID) return new Response("ok");

      const [action, ...idParts] = cb.data.split(":");
      const targetId = idParts.join(":");
      await answerCallbackQuery(cb.id, "Processing...");

      let result: string;

      switch (action) {
        case "approve":
          result = await handleApproval(targetId, true);
          break;
        case "reject":
          result = await handleApproval(targetId, false);
          break;
        case "retry":
          result = await handleRetry(targetId);
          break;
        case "archive":
          result = await handleArchive(targetId);
          break;
        case "explain":
          result = await handleExplainMore(targetId);
          break;
        case "agent_confirm":
          result = await handleAgentConfirm(targetId);
          break;
        case "agent_cancel":
          result = await handleAgentCancel(targetId);
          break;
        default:
          result = "❓ Unknown action.";
      }

      await editMessageReplyMarkup(cbChatId, cb.message.message_id);
      await sendMessage(cbChatId, result);
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

    // /start still shows the help menu
    if (text === "/start") {
      await sendMessage(chatId, [
        `🎯 *${SYSTEM_IDENTITY} — Online (Agentic Mode)*`,
        ``,
        `🤖 Just tell me what you need — I'll figure out the best way to handle it.`,
        ``,
        `*Examples:*`,
        `• "What's broken today?"`,
        `• "Retry all failed jobs"`,
        `• "How are my projects doing?"`,
        `• "Approve all pending documents"`,
        `• "Switch to Grok and give me a status report"`,
        ``,
        `💡 I'll ask for confirmation before doing anything destructive.`,
        ``,
        `_Legacy commands still work: /status, /pending, /failed, /model, /projects, /stats_`,
      ].join("\n"));
      return new Response("ok");
    }

    // Everything else goes through the agentic loop
    await executeAgenticLoop(chatId, text);

    return new Response("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response("ok");
  }
});

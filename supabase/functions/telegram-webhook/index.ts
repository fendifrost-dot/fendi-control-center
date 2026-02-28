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

// ─── AI via Gemini ──────────────────────────────────────────────
async function callGemini(prompt: string, systemPrompt: string): Promise<string> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\n${prompt}` }] }],
        generationConfig: { maxOutputTokens: 1024 },
      }),
    }
  );
  if (!resp.ok) {
    console.error("Gemini error:", resp.status, await resp.text());
    return "⚠️ Gemini unavailable. Try again shortly.";
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";
}

// ─── AI via Grok ────────────────────────────────────────────────
async function callGrok(prompt: string, systemPrompt: string): Promise<string> {
  const resp = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROK_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-3-mini-fast",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      max_tokens: 1024,
    }),
  });
  if (!resp.ok) {
    console.error("Grok error:", resp.status, await resp.text());
    return "⚠️ Grok unavailable. Try again shortly.";
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "No response generated.";
}

// ─── Route to active model ──────────────────────────────────────
async function getAIResponse(prompt: string, model: string): Promise<string> {
  const docContext = await getRecentDocContext();
  const contextBlock = `\n\n--- Recent Documents ---\n${docContext}\n---`;
  const fullPrompt = `${prompt}${contextBlock}`;

  const baseSystem = `You are the ${SYSTEM_IDENTITY}. You serve Fendi Frost as a personal command center assistant.`;

  if (model === "grok") {
    return callGrok(fullPrompt, `${baseSystem} You have Grok's personality — witty, direct, and concise. Use emoji sparingly. Reference recent documents when relevant.`);
  }
  return callGemini(fullPrompt, `${baseSystem} You have Gemini's personality — precise, analytical, and thorough but concise. Structure answers clearly. Reference recent documents when relevant.`);
}

// ─── Handle approval callback ───────────────────────────────────
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

    if (obsErr) {
      console.error("Observation verify error:", obsErr);
      return "❌ Failed to verify observations.";
    }

    await supabase
      .from("telegram_approval_queue")
      .update({ status: "approved", resolved_at: now })
      .eq("id", queueId);

    return `✅ *${SYSTEM_IDENTITY} — Verified and locked in database.* ${queue.observation_count} observations confirmed.`;
  } else {
    await supabase
      .from("telegram_approval_queue")
      .update({ status: "rejected", resolved_at: now })
      .eq("id", queueId);

    return `❌ *${SYSTEM_IDENTITY} — Rejected.* Observations remain unverified for manual review.`;
  }
}

// ─── Handle retry callback ──────────────────────────────────────
async function handleRetry(jobId: string): Promise<string> {
  const { data: job, error } = await supabase
    .from("ingestion_jobs")
    .select("*, documents(file_name)")
    .eq("id", jobId)
    .single();

  if (error || !job) return "❌ Job not found.";
  if (job.status !== "failed") return `⏳ Job is currently *${job.status}*. Can only retry failed jobs.`;

  // Reset job to queued
  await supabase
    .from("ingestion_jobs")
    .update({ status: "queued", last_error: null, started_at: null, completed_at: null })
    .eq("id", jobId);

  // Reset document status
  if (job.document_id) {
    await supabase.from("documents").update({ status: "pending" }).eq("id", job.document_id);
  }

  // Trigger processing
  try {
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || SUPABASE_SERVICE_ROLE_KEY;
    await fetch(`${SUPABASE_URL}/functions/v1/process-document`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ job_id: jobId }),
    });
  } catch (e) {
    console.error("Retry trigger failed:", e);
  }

  const doc = job.documents as any;
  return `🔄 *${SYSTEM_IDENTITY} — Manual Retry Initiated*\n\nJob for "${doc?.file_name || "Unknown"}" has been re-queued and processing is starting now.`;
}

// ─── Handle archive callback ────────────────────────────────────
async function handleArchive(jobId: string): Promise<string> {
  const { data: job, error } = await supabase
    .from("ingestion_jobs")
    .select("*, documents(file_name)")
    .eq("id", jobId)
    .single();

  if (error || !job) return "❌ Job not found.";

  await supabase
    .from("ingestion_jobs")
    .update({ status: "archived", completed_at: new Date().toISOString() })
    .eq("id", jobId);

  const doc = job.documents as any;
  return `🗑️ *${SYSTEM_IDENTITY} — Job Archived*\n\n"${doc?.file_name || "Unknown"}" has been archived. It won't be retried unless you manually re-queue it.`;
}

// ─── Handle explain more callback ───────────────────────────────
async function handleExplainMore(jobId: string): Promise<string> {
  const { data: job, error } = await supabase
    .from("ingestion_jobs")
    .select("*, documents(file_name, mime_type, file_name)")
    .eq("id", jobId)
    .single();

  if (error || !job) return "❌ Job not found.";

  const model = await getActiveModel();
  const doc = job.documents as any;

  const prompt = `You are the ${SYSTEM_IDENTITY}. A document processing job failed and the boss wants a detailed troubleshooting session.

Job Details:
- File: ${doc?.file_name || "Unknown"}
- MIME Type: ${doc?.mime_type || "Unknown"}
- Attempts: ${job.attempt_count}
- Last Error: ${job.last_error || "No error recorded"}

Provide a detailed but plain-English explanation of:
1. What likely went wrong
2. The most probable root cause
3. Exactly what steps to take to fix it
4. Whether this is likely a one-time issue or recurring

Be specific, actionable, and friendly. No jargon.`;

  const response = await getAIResponse(prompt, model);
  return `💬 *${SYSTEM_IDENTITY} — Troubleshooting Session*\n\n📁 *File:* ${doc?.file_name || "Unknown"}\n\n${response}`;
}

// ─── /status ────────────────────────────────────────────────────
async function handleStatusCommand(): Promise<string> {
  const { data: pending } = await supabase.from("telegram_approval_queue").select("id").eq("status", "pending");
  const { data: jobs } = await supabase.from("ingestion_jobs").select("id, status").in("status", ["queued", "processing", "retrying"]);
  const { data: failedJobs } = await supabase.from("ingestion_jobs").select("id").eq("status", "failed");
  const { data: docs } = await supabase.from("documents").select("id").eq("status", "completed");
  const model = await getActiveModel();

  return [
    `🎯 *${SYSTEM_IDENTITY} — Status Report*`,
    ``,
    `📄 Documents processed: ${docs?.length || 0}`,
    `⏳ Pending approvals: ${pending?.length || 0}`,
    `🔄 Active jobs: ${jobs?.length || 0}`,
    `❌ Failed jobs: ${failedJobs?.length || 0}`,
    `🧠 Active model: *${model}* (${model === "grok" ? "Frost\\_Grok" : "Frost\\_Gemini"})`,
  ].join("\n");
}

// ─── /model ─────────────────────────────────────────────────────
async function handleModelCommand(newModel: string): Promise<string> {
  const valid = ["gemini", "grok"];
  const model = newModel.toLowerCase().trim();
  if (!valid.includes(model)) return `❌ Unknown model. Use: /model gemini or /model grok`;

  const { error } = await supabase
    .from("bot_settings")
    .upsert({ setting_key: "ai_model", setting_value: model, updated_at: new Date().toISOString() }, { onConflict: "setting_key" });

  if (error) {
    console.error("Model switch error:", error);
    return "❌ Failed to switch model.";
  }

  const emoji = model === "grok" ? "⚡" : "💎";
  const key = model === "grok" ? "Frost\\_Grok" : "Frost\\_Gemini";
  return `${emoji} *${SYSTEM_IDENTITY}* — Switched to *${model.charAt(0).toUpperCase() + model.slice(1)}* using ${key}.`;
}

// ─── /pending ───────────────────────────────────────────────────
async function handlePendingCommand(): Promise<string> {
  const { data: pending } = await supabase
    .from("telegram_approval_queue")
    .select("*, documents(file_name), clients(name)")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(5);

  if (!pending || pending.length === 0) return `✅ *${SYSTEM_IDENTITY}* — No pending approvals!`;

  const lines = pending.map((p: any, i: number) => {
    const doc = p.documents as any;
    const client = p.clients as any;
    return `${i + 1}. 📄 ${doc?.file_name || "Unknown"} (${client?.name || "Unknown"}) — ${p.observation_count} obs`;
  });

  return [`📋 *${SYSTEM_IDENTITY} — Pending Approvals:*`, ``, ...lines].join("\n");
}

// ─── /failed ────────────────────────────────────────────────────
async function handleFailedCommand(): Promise<string> {
  const { data: failed } = await supabase
    .from("ingestion_jobs")
    .select("*, documents(file_name), clients(name)")
    .eq("status", "failed")
    .order("completed_at", { ascending: false })
    .limit(5);

  if (!failed || failed.length === 0) return `✅ *${SYSTEM_IDENTITY}* — No failed jobs!`;

  const lines = failed.map((j: any, i: number) => {
    const doc = j.documents as any;
    const client = j.clients as any;
    const shortError = (j.last_error || "Unknown").slice(0, 80);
    return `${i + 1}. ❌ ${doc?.file_name || "Unknown"} (${client?.name || "Unknown"})\n   Attempts: ${j.attempt_count} | ${shortError}`;
  });

  return [`🚨 *${SYSTEM_IDENTITY} — Failed Jobs:*`, ``, ...lines].join("\n");
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
  const statsUrl = `${project.supabase_url}/functions/v1/project-stats`;
  try {
    const resp = await fetch(statsUrl, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!resp.ok) {
      console.error(`Stats fetch failed for ${project.name}:`, resp.status, await resp.text());
      return null;
    }
    return await resp.json();
  } catch (e) {
    console.error(`Stats fetch error for ${project.name}:`, e);
    return null;
  }
}

async function handleProjectsCommand(): Promise<string> {
  const projects = await getConnectedProjects();
  if (projects.length === 0) return `📂 *${SYSTEM_IDENTITY}* — No projects connected yet.`;

  const lines = projects.map((p: any, i: number) => {
    return `${i + 1}. ${p.is_active ? "🟢" : "🔴"} *${p.name}*\n   ${p.description || "No description"}`;
  });

  return [`📂 *${SYSTEM_IDENTITY} — Connected Projects (${projects.length}):*`, ``, ...lines].join("\n");
}

async function handleStatsCommand(projectName: string): Promise<string> {
  const projects = await getConnectedProjects();
  if (projects.length === 0) return `📂 *${SYSTEM_IDENTITY}* — No projects connected.`;

  if (!projectName) {
    const results: string[] = [`📊 *${SYSTEM_IDENTITY} — Cross-Project Stats:*`, ``];
    for (const project of projects) {
      const stats = await fetchProjectStats(project);
      if (!stats) { results.push(`🔴 *${project.name}*: Endpoint unreachable`); continue; }
      const entries = Object.entries(stats.tables || {}).filter(([, v]) => v > 0);
      if (entries.length > 0) {
        results.push(`🟢 *${project.name}*`);
        entries.forEach(([table, count]) => results.push(`   • ${table}: ${count}`));
      } else {
        results.push(`🟡 *${project.name}*: Connected (no data yet)`);
      }
    }
    return results.join("\n");
  }

  const project = projects.find((p: any) => p.name.toLowerCase().includes(projectName.toLowerCase()));
  if (!project) return `❌ Project "${projectName}" not found.`;

  const stats = await fetchProjectStats(project);
  if (!stats) return `⚠️ Could not reach *${project.name}*'s stats endpoint.`;

  const entries = Object.entries(stats.tables || {}).filter(([, v]) => v > 0);
  if (entries.length === 0) return `🟡 *${project.name}*: Connected but no data yet.`;
  const counts = entries.map(([table, count]) => `• ${table}: ${count}`);
  return [`📊 *${SYSTEM_IDENTITY} — ${project.name} Stats:*`, ``, ...counts].join("\n");
}

async function handleQueryCommand(args: string): Promise<string> {
  const firstSpace = args.indexOf(" ");
  if (firstSpace === -1) return "❌ Usage: /query <project\\_name> <question>";

  const projectName = args.slice(0, firstSpace).trim().toLowerCase();
  const question = args.slice(firstSpace + 1).trim();

  const projects = await getConnectedProjects();
  const project = projects.find((p: any) => p.name.toLowerCase().includes(projectName));
  if (!project) return `❌ Project not found. Available: ${projects.map((p: any) => p.name).join(", ") || "none"}`;

  // Fetch stats for context
  const stats = await fetchProjectStats(project);
  const statsContext = stats ? `Tables: ${JSON.stringify(stats.tables)}` : "Stats unavailable";

  const model = await getActiveModel();
  const contextPrompt = `You are the ${SYSTEM_IDENTITY}. The boss is asking about the "${project.name}" project: "${question}". Project description: "${project.description || 'N/A'}". ${statsContext}. Provide a helpful response.`;
  return await getAIResponse(contextPrompt, model);
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

    // Command routing
    if (text === "/start") {
      await sendMessage(chatId, [
        `🎯 *${SYSTEM_IDENTITY} — Online*`,
        ``,
        `📊 /status — Pipeline overview`,
        `📋 /pending — Pending approvals`,
        `🚨 /failed — Failed jobs`,
        `🧠 /model gemini|grok — Switch AI engine`,
        `📂 /projects — Connected projects`,
        `📊 /stats — Cross-project statistics`,
        `🔍 /query <name> <question> — Query a project`,
        `💬 Any message — AI chat with context`,
      ].join("\n"));
    } else if (text === "/status") {
      await sendMessage(chatId, await handleStatusCommand());
    } else if (text.startsWith("/model")) {
      const model = text.replace("/model", "").trim().split(/\s+/)[0];
      if (!model) {
        const current = await getActiveModel();
        const key = current === "grok" ? "Frost\\_Grok" : "Frost\\_Gemini";
        await sendMessage(chatId, `🧠 *${SYSTEM_IDENTITY}* — Active: *${current}* (${key})\n\nSwitch: /model gemini or /model grok`);
      } else {
        await sendMessage(chatId, await handleModelCommand(model));
      }
    } else if (text === "/pending") {
      await sendMessage(chatId, await handlePendingCommand());
    } else if (text === "/failed") {
      await sendMessage(chatId, await handleFailedCommand());
    } else if (text === "/projects") {
      await sendMessage(chatId, await handleProjectsCommand());
    } else if (text.startsWith("/stats")) {
      const projectName = text.replace("/stats", "").trim();
      await sendMessage(chatId, await handleStatsCommand(projectName));
    } else if (text.startsWith("/query")) {
      const args = text.replace("/query", "").trim();
      if (!args) {
        await sendMessage(chatId, "❌ Usage: /query <project\\_name> <question>");
      } else {
        await sendMessage(chatId, await handleQueryCommand(args));
      }
    } else {
      // AI relay with document context
      const model = await getActiveModel();
      const response = await getAIResponse(text, model);
      await sendMessage(chatId, response);
    }

    return new Response("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response("ok");
  }
});

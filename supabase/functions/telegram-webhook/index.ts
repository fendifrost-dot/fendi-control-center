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

// ─── AI via Gemini (direct) ─────────────────────────────────────
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

// ─── AI via Grok (xAI direct) ───────────────────────────────────
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

  if (model === "grok") {
    return callGrok(fullPrompt, "You are Grok, a witty and direct AI assistant for Fendi Frost's credit repair command center. Keep responses concise and punchy. Use emoji sparingly. Reference recent documents when relevant.");
  }
  return callGemini(fullPrompt, "You are Gemini, a precise and analytical AI assistant for Fendi Frost's credit repair command center. Be thorough but concise. Structure your answers clearly. Reference recent documents when relevant.");
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

    return `✅ *Verified and locked in database.* ${queue.observation_count} observations confirmed.`;
  } else {
    await supabase
      .from("telegram_approval_queue")
      .update({ status: "rejected", resolved_at: now })
      .eq("id", queueId);

    return `❌ *Rejected.* Observations remain unverified for manual review.`;
  }
}

// ─── /status ────────────────────────────────────────────────────
async function handleStatusCommand(): Promise<string> {
  const { data: pending } = await supabase.from("telegram_approval_queue").select("id").eq("status", "pending");
  const { data: jobs } = await supabase.from("ingestion_jobs").select("id, status").in("status", ["queued", "running"]);
  const { data: docs } = await supabase.from("documents").select("id").eq("status", "completed");
  const model = await getActiveModel();

  return [
    `📊 *Frost Command Center*`,
    ``,
    `📄 Documents processed: ${docs?.length || 0}`,
    `⏳ Pending approvals: ${pending?.length || 0}`,
    `🔄 Active jobs: ${jobs?.length || 0}`,
    `🧠 Active model: *${model}* (${model === "grok" ? "Frost\\_Grok" : "Frost\\_Gemini"})`,
  ].join("\n");
}

// ─── /model ─────────────────────────────────────────────────────
async function handleModelCommand(newModel: string): Promise<string> {
  const valid = ["gemini", "grok"];
  const model = newModel.toLowerCase().trim();
  if (!valid.includes(model)) return `❌ Unknown model. Use: /model gemini or /model grok`;

  // Upsert to handle both insert and update
  const { error } = await supabase
    .from("bot_settings")
    .upsert({ setting_key: "ai_model", setting_value: model, updated_at: new Date().toISOString() }, { onConflict: "setting_key" });

  if (error) {
    console.error("Model switch error:", error);
    return "❌ Failed to switch model.";
  }

  const emoji = model === "grok" ? "⚡" : "💎";
  const key = model === "grok" ? "Frost\\_Grok" : "Frost\\_Gemini";
  return `${emoji} Switched to *${model.charAt(0).toUpperCase() + model.slice(1)}* using ${key}. All responses now route through this engine.`;
}

// ─── /pending ───────────────────────────────────────────────────
async function handlePendingCommand(): Promise<string> {
  const { data: pending } = await supabase
    .from("telegram_approval_queue")
    .select("*, documents(file_name), clients(name)")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(5);

  if (!pending || pending.length === 0) return "✅ No pending approvals!";

  const lines = pending.map((p: any, i: number) => {
    const doc = p.documents as any;
    const client = p.clients as any;
    return `${i + 1}. 📄 ${doc?.file_name || "Unknown"} (${client?.name || "Unknown"}) — ${p.observation_count} obs`;
  });

  return [`📋 *Pending Approvals:*`, ``, ...lines].join("\n");
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

      const [action, queueId] = cb.data.split(":");
      await answerCallbackQuery(cb.id, "Processing...");

      const result = await handleApproval(queueId, action === "approve");
      await editMessageReplyMarkup(cbChatId, cb.message.message_id);
      await sendMessage(cbChatId, result);

      return new Response("ok");
    }

    // ── Text messages ──
    const message = update.message;
    if (!message?.text) return new Response("ok");

    const chatId = String(message.chat.id);
    const text = message.text.trim();

    // Gate: only respond to authorized chat
    if (chatId !== CHAT_ID) {
      console.log(`🚫 Blocked message from unauthorized chat: ${chatId}`);
      return new Response("ok");
    }

    // Command routing
    if (text === "/start") {
      await sendMessage(chatId, [
        `🎯 *Frost Command Center* — Online`,
        ``,
        `📊 /status — Pipeline overview`,
        `📋 /pending — Pending approvals`,
        `🧠 /model gemini|grok — Switch AI engine`,
        `💬 Any message — AI chat with document context`,
      ].join("\n"));
    } else if (text === "/status") {
      await sendMessage(chatId, await handleStatusCommand());
    } else if (text.startsWith("/model")) {
      const model = text.replace("/model", "").trim().split(/\s+/)[0];
      if (!model) {
        const current = await getActiveModel();
        const key = current === "grok" ? "Frost\\_Grok" : "Frost\\_Gemini";
        await sendMessage(chatId, `🧠 Active: *${current}* (${key})\n\nSwitch: /model gemini or /model grok`);
      } else {
        await sendMessage(chatId, await handleModelCommand(model));
      }
    } else if (text === "/pending") {
      await sendMessage(chatId, await handlePendingCommand());
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

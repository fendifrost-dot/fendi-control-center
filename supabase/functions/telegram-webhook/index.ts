import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const BOT_TOKEN = Deno.env.get("FendiAIbot")!;
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_KEY = Deno.env.get("Frost_Gemini")!;
const GROK_KEY = Deno.env.get("Frost_Grok")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── Send message to Telegram ───────────────────────────────────
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

// ─── AI Response via active model ───────────────────────────────
async function getAIResponse(prompt: string, model: string): Promise<string> {
  try {
    let modelId: string;
    if (model === "grok") {
      modelId = "openai/gpt-5-mini"; // closest equivalent via gateway
    } else {
      modelId = "google/gemini-3-flash-preview";
    }

    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: "system",
            content: model === "grok"
              ? "You are Grok, a witty and direct AI assistant for Fendi Frost's credit repair command center. Keep responses concise and punchy. Use emoji sparingly."
              : "You are Gemini, a precise and analytical AI assistant for Fendi Frost's credit repair command center. Be thorough but concise. Structure your answers clearly.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!resp.ok) {
      console.error("AI gateway error:", resp.status);
      return "⚠️ AI is temporarily unavailable. Try again shortly.";
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content || "No response generated.";
  } catch (e) {
    console.error("AI error:", e);
    return "⚠️ AI error. Try again.";
  }
}

// ─── Handle approval callback ───────────────────────────────────
async function handleApproval(queueId: string, approved: boolean) {
  // Get the queue entry
  const { data: queue, error: qErr } = await supabase
    .from("telegram_approval_queue")
    .select("*")
    .eq("id", queueId)
    .single();

  if (qErr || !queue) return "❌ Approval record not found.";
  if (queue.status !== "pending") return "⏳ Already processed.";

  const now = new Date().toISOString();

  if (approved) {
    // Mark observations as verified
    const { error: obsErr } = await supabase
      .from("observations")
      .update({ is_verified: true, verified_at: now, verified_via: "telegram" })
      .eq("document_id", queue.document_id)
      .eq("client_id", queue.client_id);

    if (obsErr) {
      console.error("Observation verify error:", obsErr);
      return "❌ Failed to verify observations.";
    }

    // Update queue status
    await supabase
      .from("telegram_approval_queue")
      .update({ status: "approved", resolved_at: now })
      .eq("id", queueId);

    return `✅ *Approved!* ${queue.observation_count} observations verified.`;
  } else {
    // Mark as rejected — observations stay unverified
    await supabase
      .from("telegram_approval_queue")
      .update({ status: "rejected", resolved_at: now })
      .eq("id", queueId);

    return `❌ *Rejected.* Observations remain unverified for manual review.`;
  }
}

// ─── Handle /status command ─────────────────────────────────────
async function handleStatusCommand(): Promise<string> {
  const { data: pending } = await supabase
    .from("telegram_approval_queue")
    .select("id")
    .eq("status", "pending");

  const { data: jobs } = await supabase
    .from("ingestion_jobs")
    .select("id, status")
    .in("status", ["queued", "running"]);

  const { data: docs } = await supabase
    .from("documents")
    .select("id")
    .eq("status", "completed");

  const { data: modelSetting } = await supabase
    .from("bot_settings")
    .select("setting_value")
    .eq("setting_key", "ai_model")
    .single();

  return [
    `📊 *Command Center Status*`,
    ``,
    `📄 Documents processed: ${docs?.length || 0}`,
    `⏳ Pending approvals: ${pending?.length || 0}`,
    `🔄 Active jobs: ${jobs?.length || 0}`,
    `🧠 Active model: ${modelSetting?.setting_value || "gemini"}`,
  ].join("\n");
}

// ─── Handle /model command ──────────────────────────────────────
async function handleModelCommand(newModel: string): Promise<string> {
  const valid = ["gemini", "grok"];
  const model = newModel.toLowerCase().trim();

  if (!valid.includes(model)) {
    return `❌ Unknown model. Use: /model gemini or /model grok`;
  }

  await supabase
    .from("bot_settings")
    .update({ setting_value: model, updated_at: new Date().toISOString() })
    .eq("setting_key", "ai_model");

  const emoji = model === "grok" ? "⚡" : "💎";
  return `${emoji} Model switched to *${model.charAt(0).toUpperCase() + model.slice(1)}*. All AI responses will now use this personality.`;
}

// ─── Handle /pending command ────────────────────────────────────
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
    return `${i + 1}. 📄 ${doc?.file_name || "Unknown"} (${client?.name || "Unknown"}) — ${p.observation_count} observations`;
  });

  return [`📋 *Pending Approvals:*`, ``, ...lines].join("\n");
}

// ─── Main Webhook Handler ───────────────────────────────────────
serve(async (req) => {
  try {
    const update = await req.json();
    console.log("📨 Telegram update:", JSON.stringify(update).slice(0, 500));

    // Handle callback queries (inline button presses)
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data; // format: "approve:queue_id" or "reject:queue_id"
      const [action, queueId] = data.split(":");

      await answerCallbackQuery(cb.id, "Processing...");
      
      const result = await handleApproval(queueId, action === "approve");
      
      // Remove inline buttons
      await editMessageReplyMarkup(cb.message.chat.id, cb.message.message_id);
      
      // Send result
      await sendMessage(String(cb.message.chat.id), result);
      
      return new Response("ok");
    }

    // Handle text messages
    const message = update.message;
    if (!message?.text) return new Response("ok");

    const chatId = String(message.chat.id);
    const text = message.text.trim();

    // Only respond to our known chat
    if (chatId !== CHAT_ID) {
      console.log(`Ignoring message from unknown chat: ${chatId}`);
      return new Response("ok");
    }

    // Command routing
    if (text === "/start") {
      await sendMessage(chatId, [
        `🎯 *Frost Command Center* — Online`,
        ``,
        `Available commands:`,
        `📊 /status — Pipeline overview`,
        `📋 /pending — Pending approvals`,
        `🧠 /model gemini|grok — Switch AI personality`,
        `💬 Any other message — AI-powered chat`,
      ].join("\n"));
    } else if (text === "/status") {
      const status = await handleStatusCommand();
      await sendMessage(chatId, status);
    } else if (text.startsWith("/model")) {
      const model = text.replace("/model", "").trim();
      if (!model) {
        const current = await getActiveModel();
        await sendMessage(chatId, `🧠 Current model: *${current}*\n\nSwitch: /model gemini or /model grok`);
      } else {
        const result = await handleModelCommand(model);
        await sendMessage(chatId, result);
      }
    } else if (text === "/pending") {
      const result = await handlePendingCommand();
      await sendMessage(chatId, result);
    } else {
      // AI chat — use active model
      const model = await getActiveModel();
      const aiResponse = await getAIResponse(text, model);
      await sendMessage(chatId, aiResponse);
    }

    return new Response("ok");
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response("ok"); // Always return 200 to Telegram
  }
});

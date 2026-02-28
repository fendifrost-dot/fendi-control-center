import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const BOT_TOKEN = Deno.env.get("FendiAIbot")!;
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const payload = await req.json();

    // ── SOS Failure Alert ──
    if (payload.sos) {
      return await handleSOS(payload);
    }

    // ── Custom message (no approval) ──
    if (payload.custom_message) {
      return await sendDirect(payload.custom_message);
    }

    // ── Standard document processed notification ──
    return await handleDocumentNotification(payload);

  } catch (err) {
    console.error("Telegram notification error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ─── SOS Failure Alert ──────────────────────────────────────────
async function handleSOS(payload: any) {
  const { job_id, file_name, client_name, raw_error, explanation } = payload;

  const text = [
    `🚨 *Fendi Control Center AI — Task Failed*`,
    ``,
    `❌ *Status:* Task Failed`,
    `📁 *File:* ${escapeMarkdown(file_name || "Unknown")}`,
    `👤 *Client:* ${escapeMarkdown(client_name || "Unknown")}`,
    ``,
    `💬 *Explanation:*`,
    escapeMarkdown(explanation || "Unknown error occurred."),
    ``,
    `🔧 _Fendi Control Center AI has analyzed this failure and is standing by._`,
  ].join("\n");

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "🔄 Manual Retry", callback_data: `retry:${job_id}` },
        { text: "🗑️ Archive Job", callback_data: `archive:${job_id}` },
      ],
      [
        { text: "💬 Explain More", callback_data: `explain:${job_id}` },
      ],
    ],
  };

  const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "Markdown",
      reply_markup: replyMarkup,
    }),
  });

  const result = await resp.json();
  if (!result.ok) {
    console.error("SOS Telegram error:", result);
    return new Response(JSON.stringify({ error: result.description }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ success: true, type: "sos" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Direct message ─────────────────────────────────────────────
async function sendDirect(message: string) {
  const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "Markdown",
    }),
  });

  const result = await resp.json();
  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.description }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Document processed notification ────────────────────────────
async function handleDocumentNotification(payload: any) {
  const { document_name, doc_type, observation_count, client_name, document_id, client_id } = payload;

  // Create approval queue entry
  let queueId: string | null = null;
  if (document_id && client_id) {
    const { data: queue, error: qErr } = await supabase
      .from("telegram_approval_queue")
      .insert({
        document_id, client_id,
        observation_count: observation_count || 0,
        status: "pending",
      })
      .select("id")
      .single();

    if (qErr) console.error("Queue insert error:", qErr);
    else queueId = queue.id;
  }

  const emoji = doc_type === "credit_report" ? "📊" : "📄";
  const typeLabel = doc_type?.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()) || "Document";

  const text = [
    `${emoji} *Fendi Control Center AI — Document Processed*`,
    ``,
    `📁 *File:* ${escapeMarkdown(document_name || "Unknown")}`,
    `👤 *Client:* ${escapeMarkdown(client_name || "Unknown")}`,
    `📋 *Type:* ${escapeMarkdown(typeLabel)}`,
    `🔢 *Observations:* ${observation_count || 0}`,
    ``,
    `⚡ *Approve these observations?*`,
  ].join("\n");

  const replyMarkup = queueId
    ? {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `approve:${queueId}` },
            { text: "❌ Reject", callback_data: `reject:${queueId}` },
          ],
        ],
      }
    : undefined;

  const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID, text,
      parse_mode: "Markdown",
      reply_markup: replyMarkup,
    }),
  });

  const result = await resp.json();

  if (!result.ok) {
    console.error("Telegram API error:", result);
    return new Response(JSON.stringify({ error: result.description }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (queueId && result.result?.message_id) {
    await supabase
      .from("telegram_approval_queue")
      .update({ telegram_message_id: result.result.message_id })
      .eq("id", queueId);
  }

  return new Response(JSON.stringify({ success: true, queue_id: queueId }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

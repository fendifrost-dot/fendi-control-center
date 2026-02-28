import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const BOT_TOKEN = Deno.env.get("FendiAIbot")!;
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { document_name, doc_type, observation_count, client_name, custom_message } = await req.json();

    let text: string;

    if (custom_message) {
      text = custom_message;
    } else {
      const emoji = doc_type === "credit_report" ? "📊" : "📄";
      const typeLabel = doc_type?.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()) || "Document";

      text = [
        `${emoji} *Document Processed*`,
        ``,
        `📁 *File:* ${escapeMarkdown(document_name || "Unknown")}`,
        `👤 *Client:* ${escapeMarkdown(client_name || "Unknown")}`,
        `📋 *Type:* ${escapeMarkdown(typeLabel)}`,
        `🔢 *Observations:* ${observation_count || 0}`,
        ``,
        `✅ Ready for review`,
      ].join("\n");
    }

    const resp = await fetch(TELEGRAM_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "Markdown",
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

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Telegram notification error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

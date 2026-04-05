import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const BOT_TOKEN = Deno.env.get("FendiAIbot")!;
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const webhookSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET_TOKEN") ?? "";

  if (!webhookSecret) {
    return new Response(
      JSON.stringify({
        error: "TELEGRAM_WEBHOOK_SECRET_TOKEN must be set (high-entropy secret for X-Telegram-Bot-Api-Secret-Token).",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const webhookUrl = `${SUPABASE_URL}/functions/v1/telegram-webhook`;

  const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: webhookSecret,
      allowed_updates: ["message", "callback_query"],
    }),
  });

  const result = await resp.json();
  console.log("setWebhook result:", { ok: result?.ok, description: result?.description });

  return new Response(JSON.stringify({ webhook_url: webhookUrl, telegram_response: result }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

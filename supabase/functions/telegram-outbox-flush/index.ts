import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BOT_TOKEN = Deno.env.get("FendiAIbot")!;
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // Verify auth
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const supabaseAuth = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const max = Math.min(body.max || 10, 20);
    const chatId = body.chat_id || CHAT_ID;

    const { data: due } = await supabase
      .from("telegram_outbox")
      .select("id, kind, payload, attempt_count")
      .in("status", ["queued", "failed"])
      .eq("chat_id", chatId)
      .lte("next_attempt_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(max);

    if (!due || due.length === 0) {
      return new Response(JSON.stringify({ sent: 0, failed: 0, message: "No due items" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let sent = 0, failed = 0;
    for (const row of due) {
      await supabase.from("telegram_outbox").update({
        status: "sending", last_attempt_at: new Date().toISOString(),
        attempt_count: row.attempt_count + 1,
      }).eq("id", row.id);

      try {
        const resp = await fetch(`${TELEGRAM_API}/${row.kind || "sendMessage"}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(row.payload),
        });
        const result = await resp.json();

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

    return new Response(JSON.stringify({ sent, failed }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

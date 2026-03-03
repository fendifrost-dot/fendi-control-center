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

  const json = (body: any, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    // Auth check
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    const supabaseAuth = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const max = Math.min(body.max || 10, 20);
    const chatId = body.chat_id || CHAT_ID;
    const now = new Date().toISOString();

    // Atomic claim: update status to 'sending' and return claimed rows in one call
    // This prevents double-send on concurrent flush calls
    const { data: claimed, error: claimErr } = await supabase.rpc("claim_outbox_rows", {
      p_chat_id: chatId,
      p_limit: max,
      p_now: now,
    });

    // Fallback if RPC doesn't exist: use select-then-update (less safe but functional)
    let rows = claimed;
    if (claimErr) {
      console.warn("[FLUSH] RPC claim_outbox_rows not found, falling back to select+update:", claimErr.message);
      const { data: due } = await supabase
        .from("telegram_outbox")
        .select("id, kind, payload, attempt_count")
        .in("status", ["queued", "failed"])
        .eq("chat_id", chatId)
        .lte("next_attempt_at", now)
        .order("created_at", { ascending: true })
        .limit(max);

      if (!due || due.length === 0) return json({ sent: 0, failed: 0, message: "No due items" });

      // Claim them by setting status='sending' for these specific IDs
      const ids = due.map(r => r.id);
      await supabase
        .from("telegram_outbox")
        .update({ status: "sending", last_attempt_at: now })
        .in("id", ids)
        .in("status", ["queued", "failed"]); // double-check status to avoid racing

      // Re-increment attempt_count per row during send loop
      rows = due;
    }

    if (!rows || rows.length === 0) return json({ sent: 0, failed: 0, message: "No due items" });

    let sent = 0, failed = 0;
    for (const row of rows) {
      // Increment attempt_count for this row
      await supabase.from("telegram_outbox").update({
        attempt_count: (row.attempt_count ?? 0) + 1,
      }).eq("id", row.id);

      try {
        const resp = await fetch(`${TELEGRAM_API}/${row.kind || "sendMessage"}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(row.payload),
        });
        const result = await resp.json();
        const newAttempt = (row.attempt_count ?? 0) + 1;

        if (result.ok) {
          await supabase.from("telegram_outbox").update({
            status: "sent", sent_at: new Date().toISOString(), last_error: null,
          }).eq("id", row.id);
          sent++;
        } else {
          const backoff = Math.min(Math.pow(newAttempt, 2) * 5, 120);
          await supabase.from("telegram_outbox").update({
            status: "failed",
            last_error: result.description || JSON.stringify(result).slice(0, 500),
            next_attempt_at: new Date(Date.now() + backoff * 1000).toISOString(),
          }).eq("id", row.id);
          failed++;
        }
      } catch (e) {
        const newAttempt = (row.attempt_count ?? 0) + 1;
        const backoff = Math.min(Math.pow(newAttempt, 2) * 5, 120);
        await supabase.from("telegram_outbox").update({
          status: "failed",
          last_error: e instanceof Error ? e.message : String(e),
          next_attempt_at: new Date(Date.now() + backoff * 1000).toISOString(),
        }).eq("id", row.id);
        failed++;
      }
    }

    return json({ sent, failed });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

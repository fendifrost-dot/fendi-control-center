import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { callGPTJSON } from "../_shared/openai.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FANFUEL_HUB_URL = Deno.env.get("FANFUEL_HUB_URL");
const FANFUEL_HUB_KEY = Deno.env.get("FANFUEL_HUB_KEY");
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function callFanFuel(body: Record<string, unknown>): Promise<any> {
  if (!FANFUEL_HUB_URL || !FANFUEL_HUB_KEY) return null;
  const resp = await fetch(`${FANFUEL_HUB_URL}/functions/v1/control-center-api`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": FANFUEL_HUB_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return null;
  return resp.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "generate");

    if (action === "send") {
      const pitchId = body.pitch_id as string;
      if (!pitchId) throw new Error("pitch_id is required for send");
      const { error } = await supabase.from("pitch_drafts").update({ status: "approved_to_send" }).eq("id", pitchId);
      if (error) throw error;
      return new Response(JSON.stringify({ ok: true, sent: false, status: "approved_to_send", pitch_id: pitchId }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const playlistId = String(body.playlist_id || "").trim();
    const trackId = String(body.track_id || "").trim();
    if (!playlistId || !trackId) throw new Error("playlist_id and track_id are required");

    const context = await callFanFuel({
      action: "get_pitch_context",
      playlist_id: playlistId,
      track_id: trackId,
    });

    const systemPrompt = "You are an expert music pitching copywriter. Write concise, personalized email pitches. Return JSON only.";
    const userPrompt = [
      `Playlist ID: ${playlistId}`,
      `Track ID: ${trackId}`,
      "Context JSON:",
      JSON.stringify(context || {}).slice(0, 40_000),
      "",
      "Return JSON with keys: subject, body, tone, personalization_points.",
    ].join("\n");

    const draft = await callGPTJSON<Record<string, unknown>>(systemPrompt, userPrompt, {
      required: ["subject", "body"],
    });

    const { data: row, error } = await supabase
      .from("pitch_drafts")
      .insert({
        research_id: body.research_id ?? null,
        playlist_id: playlistId,
        email_subject: String(draft.subject || ""),
        email_body: String(draft.body || ""),
        status: "draft",
      })
      .select("id, created_at")
      .single();
    if (error) throw error;

    return new Response(JSON.stringify({
      ok: true,
      pitch_id: row.id,
      created_at: row.created_at,
      draft,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : (typeof err === "object" ? JSON.stringify(err) : String(err)) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

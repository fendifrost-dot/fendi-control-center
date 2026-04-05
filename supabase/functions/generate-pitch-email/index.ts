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

    const channel = String(body.channel || "email").trim();
    const playlistId = String(body.playlist_id || "").trim();
    const trackId = String(body.track_id || "").trim();
    const curatorName = String(body.curator_name || "").trim();
    const instagramHandle = String(body.instagram_handle || "").trim();
    if (!playlistId || !trackId) throw new Error("playlist_id and track_id are required");

    const context = await callFanFuel({
      action: "get_pitch_context",
      playlist_id: playlistId,
      track_id: trackId,
    });

    const isInstagram = channel === "instagram";

    const systemPrompt = isInstagram
      ? "You are a friendly music artist reaching out to a playlist curator via Instagram DM. Write casual, personalized, conversational messages — not formal emails. Keep it under 300 characters. Sound authentic and human, like you're messaging a friend who curates playlists. Return JSON only."
      : "You are an expert music pitching copywriter. Write concise, personalized email pitches. Return JSON only.";

    const userPrompt = isInstagram
      ? [
          `Playlist: ${playlistId}`,
          `Track: ${trackId}`,
          curatorName ? `Curator: ${curatorName}` : "",
          instagramHandle ? `Their IG: @${instagramHandle}` : "",
          "Context JSON:",
          JSON.stringify(context || {}).slice(0, 20_000),
          "",
          "Return JSON with keys: dm_text (the casual DM message), opening_hook (first line to grab attention), tone.",
        ].filter(Boolean).join("\n")
      : [
          `Playlist ID: ${playlistId}`,
          `Track ID: ${trackId}`,
          "Context JSON:",
          JSON.stringify(context || {}).slice(0, 40_000),
          "",
          "Return JSON with keys: subject, body, tone, personalization_points.",
        ].join("\n");

    const draft = await callGPTJSON<Record<string, unknown>>(systemPrompt, userPrompt, {
      required: isInstagram ? ["dm_text"] : ["subject", "body"],
    });

    const insertData: Record<string, unknown> = {
      playlist_id: playlistId,
      curator_name: curatorName || null,
      channel,
      status: "draft",
    };

    if (isInstagram) {
      insertData.dm_content = String(draft.dm_text || "");
      insertData.instagram_handle = instagramHandle || null;
    } else {
      insertData.pitch_content = JSON.stringify(draft);
    }

    const { data: row, error } = await supabase
      .from("pitch_drafts")
      .insert(insertData)
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
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

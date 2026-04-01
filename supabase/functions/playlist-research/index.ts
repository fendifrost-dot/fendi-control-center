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
    const trackName = String(body.track_name || "").trim();
    const genre = String(body.genre || "").trim();
    const mood = String(body.mood || "").trim();
    if (!trackName) throw new Error("track_name is required");

    const systemPrompt = "You are a music marketing strategist focused on playlist pitching. Return concise, actionable JSON recommendations only.";
    const userPrompt = [
      `Track: ${trackName}`,
      `Genre: ${genre || "unknown"}`,
      `Mood: ${mood || "unknown"}`,
      `BPM: ${body.bpm ?? "unknown"}`,
      `Similar artists: ${Array.isArray(body.similar_artists) ? body.similar_artists.join(", ") : "unknown"}`,
      "",
      "Return JSON with keys: recommended_playlist_types, curator_characteristics, pitch_angles, ranked_playlists.",
    ].join("\n");

    const research = await callGPTJSON<Record<string, unknown>>(systemPrompt, userPrompt, {
      required: ["recommended_playlist_types", "curator_characteristics", "pitch_angles"],
    });
    const fanfuelMatches = await callFanFuel({
      action: "research_playlists",
      track_name: trackName,
      genre,
      mood,
    });

    const merged = { ...research, fanfuel_matches: fanfuelMatches };
    const { data: row, error } = await supabase
      .from("playlist_research")
      .insert({
        track_name: trackName,
        genre: genre || null,
        results_json: merged,
      })
      .select("id, created_at")
      .single();
    if (error) throw error;

    return new Response(JSON.stringify({
      ok: true,
      research_id: row.id,
      created_at: row.created_at,
      results: merged,
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

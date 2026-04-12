import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getEmbedding(text: string): Promise<number[]> {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
    }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`OpenAI embedding error ${resp.status}: ${err}`);
  }
  const json = await resp.json();
  return json.data[0].embedding;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // Fetch all rows with null embeddings
    const { data: rows, error } = await supabase
      .from("credit_knowledge_base")
      .select("id, content")
      .is("embedding", null);

    if (error) throw error;
    if (!rows || rows.length === 0) {
      return new Response(JSON.stringify({ message: "No rows to backfill", count: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let updated = 0;
    for (const row of rows) {
      const embedding = await getEmbedding(row.content);
      const { error: updateError } = await supabase
        .from("credit_knowledge_base")
        .update({ embedding: JSON.stringify(embedding) })
        .eq("id", row.id);

      if (updateError) {
        console.error(`Failed to update ${row.id}:`, updateError);
      } else {
        updated++;
      }
    }

    return new Response(JSON.stringify({ message: "Backfill complete", updated, total: rows.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[backfill-embeddings] Error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

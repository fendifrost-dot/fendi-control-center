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

function buildEmbeddingInput(row: { type: string; case_type: string | null; trigger: string | null; content: string }): string {
  return `${row.type} ${row.case_type ?? ""} ${row.trigger ?? ""}\n\n${row.content}`.trim();
}

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
    const body = await req.json().catch(() => ({}));
    const force = body.force === true; // re-embed all rows if true

    let query = supabase
      .from("credit_knowledge_base")
      .select("id, type, case_type, trigger, content");

    if (!force) {
      query = query.is("embedding", null);
    }

    const { data: rows, error } = await query;
    if (error) throw error;
    if (!rows || rows.length === 0) {
      return new Response(JSON.stringify({ message: "No rows to backfill", count: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: { id: string; status: string; input_preview?: string }[] = [];

    for (const row of rows) {
      try {
        const input = buildEmbeddingInput(row);
        const embedding = await getEmbedding(input);
        const { error: updateError } = await supabase
          .from("credit_knowledge_base")
          .update({ embedding: JSON.stringify(embedding) })
          .eq("id", row.id);

        if (updateError) {
          console.error(`[backfill] FAIL ${row.id}:`, updateError.message);
          results.push({ id: row.id, status: "error", input_preview: input.slice(0, 80) });
        } else {
          console.log(`[backfill] OK ${row.id} (${row.type}/${row.trigger})`);
          results.push({ id: row.id, status: "ok", input_preview: input.slice(0, 80) });
        }
      } catch (rowErr: any) {
        console.error(`[backfill] FAIL ${row.id}:`, rowErr.message);
        results.push({ id: row.id, status: "error", input_preview: rowErr.message });
      }
    }

    const ok = results.filter(r => r.status === "ok").length;
    const failed = results.filter(r => r.status === "error").length;

    return new Response(JSON.stringify({ message: "Backfill complete", ok, failed, total: rows.length, results }), {
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

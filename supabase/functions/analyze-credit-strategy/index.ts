import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { fetchCreditGuardian } from "../_shared/creditGuardian.ts";
import { callClaudeJSON } from "../_shared/claude.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SYSTEM_PROMPT = "You are a credit repair analyst operating under FCRA, FDCPA, and CFPB guidelines. Analyze the client's credit timeline events and generate a prioritized dispute strategy. For each dispute item, specify: the bureau, account name, violation type, recommended dispute method, template letter type, and confidence score (0-1). Group strategies by bureau. Flag any patterns suggesting systemic violations.";

async function resolveClientId(clientName: string): Promise<string | null> {
  const resp = await fetchCreditGuardian({ action: "get_clients" });
  if (!resp.ok) return null;
  const payload = await resp.json();
  const rows = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
  const hit = rows.find((c: any) => String(c.name || "").toLowerCase().includes(clientName.toLowerCase()));
  return hit?.id || null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    let clientId = body.client_id as string | undefined;
    const clientName = body.client_name as string | undefined;
    if (!clientId && clientName) clientId = await resolveClientId(clientName) || undefined;
    if (!clientId) throw new Error("client_id or resolvable client_name is required");

    const [detailResp, docsResp] = await Promise.all([
      fetchCreditGuardian({ action: "get_client_detail", params: { client_id: clientId } }),
      fetchCreditGuardian({ action: "get_documents", params: { client_id: clientId } }),
    ]);
    if (!detailResp.ok) throw new Error(`get_client_detail failed: ${detailResp.status}`);
    if (!docsResp.ok) throw new Error(`get_documents failed: ${docsResp.status}`);

    const detail = await detailResp.json();
    const docs = await docsResp.json();
    const userPrompt = [
      "Client detail JSON:",
      JSON.stringify(detail).slice(0, 80_000),
      "",
      "Client documents JSON:",
      JSON.stringify(docs).slice(0, 30_000),
      "",
      "Return the required strategy object.",
    ].join("\n");

    const analysis = await callClaudeJSON<Record<string, unknown>>(SYSTEM_PROMPT, userPrompt, {
      required: ["priority_disputes", "bureau_strategies", "risk_flags", "next_steps"],
    });

    const { data: row, error } = await supabase
      .from("credit_analyses")
      .insert({
        client_id: clientId,
        analysis_json: analysis,
        status: "generated",
      })
      .select("id, created_at")
      .single();
    if (error) throw error;

    return new Response(JSON.stringify({
      ok: true,
      analysis_id: row.id,
      created_at: row.created_at,
      client_id: clientId,
      analysis,
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

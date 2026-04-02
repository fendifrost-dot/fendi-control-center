import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { fetchCreditGuardian } from "../_shared/creditGuardian.ts";
import { callClaudeJSON } from "../_shared/claude.ts";
import { fuzzyClientSearch } from "../_shared/fuzzyClientSearch.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SYSTEM_PROMPT = `You are a credit repair analyst operating under FCRA, FDCPA, and CFPB guidelines.
Analyze the client's credit timeline events and generate a prioritized dispute strategy.

You MUST return valid JSON with exactly these top-level keys:

{
  "priority_disputes": [
    {
      "bureau": "Equifax|Experian|TransUnion",
      "account_name": "string",
      "violation_type": "string (e.g. FCRA §611, FDCPA §807)",
      "dispute_method": "string (e.g. online, certified mail, CFPB complaint)",
      "template_letter_type": "string (e.g. validation_demand, method_of_verification)",
      "confidence": 0.0
    }
  ],
  "bureau_strategies": {
    "Equifax": { "approach": "string", "items": [] },
    "Experian": { "approach": "string", "items": [] },
    "TransUnion": { "approach": "string", "items": [] }
  },
  "risk_flags": [
    { "flag": "string", "severity": "high|medium|low", "detail": "string" }
  ],
  "next_steps": [
    { "step": "string", "priority": 1, "timeline": "string" }
  ]
}

Rules:
- If no data is available for a key, return an empty array or object — never omit the key.
- For each dispute item, specify the bureau, account name, violation type, recommended dispute method, template letter type, and confidence score (0-1).
- Group strategies by bureau.
- Flag any patterns suggesting systemic violations.
- Return ONLY the JSON object, no markdown fences or extra text.`;

// Levenshtein distance for fuzzy matching on CG client list
function levenshtein(a: string, b: string): number {
  const al = a.toLowerCase(), bl = b.toLowerCase();
  const matrix: number[][] = [];
  for (let i = 0; i <= al.length; i++) matrix[i] = [i];
  for (let j = 0; j <= bl.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= al.length; i++) {
    for (let j = 1; j <= bl.length; j++) {
      const cost = al[i - 1] === bl[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[al.length][bl.length];
}

function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function tokenMatch(query: string, target: string): number {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase().trim();
  if (q === t) return 1.0;
  if (t.includes(q)) return 0.85;
  if (q.includes(t)) return 0.75;
  const qTokens = q.split(/[\s\-_]+/).filter(Boolean);
  const tTokens = t.split(/[\s\-_]+/).filter(Boolean);
  let matched = 0;
  for (const qt of qTokens) {
    for (const tt of tTokens) {
      if (tt.includes(qt) || qt.includes(tt)) { matched++; break; }
      if (nameSimilarity(qt, tt) > 0.75) { matched += 0.7; break; }
    }
  }
  return qTokens.length > 0 ? (matched / qTokens.length) * 0.7 : 0;
}

async function resolveClientId(clientName: string): Promise<{
  clientId: string | null;
  needsVerification: boolean;
  message?: string;
  matchedName?: string;
}> {
  // Step 1: Try Credit Guardian client list with fuzzy matching
  try {
    const resp = await fetchCreditGuardian({ action: "get_clients" });
    if (resp.ok) {
      const payload = await resp.json();
      const rows = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);

      // Exact match
      const exact = rows.find((c: any) => String(c.name || "").toLowerCase() === clientName.toLowerCase());
      if (exact?.id) return { clientId: exact.id, needsVerification: false, matchedName: exact.name };

      // Substring match (both directions)
      const substring = rows.find((c: any) => {
        const name = String(c.name || "").toLowerCase();
        const query = clientName.toLowerCase();
        return name.includes(query) || query.includes(name);
      });
      if (substring?.id) return { clientId: substring.id, needsVerification: false, matchedName: substring.name };

      // Fuzzy match on CG clients
      const scored = rows
        .map((c: any) => ({
          id: c.id,
          name: String(c.name || ""),
          score: Math.max(tokenMatch(clientName, String(c.name || "")), nameSimilarity(clientName, String(c.name || ""))),
        }))
        .filter((c: any) => c.score >= 0.5)
        .sort((a: any, b: any) => b.score - a.score);

      if (scored.length > 0 && scored[0].score >= 0.7) {
        const queryTokens = clientName.toLowerCase().split(/[\s\-_,.']+/).filter((t: string) => t.length > 1);
        const matchTokens = scored[0].name.toLowerCase().split(/[\s\-_,.']+/).filter((t: string) => t.length > 1);
        const hasTokenOverlap = queryTokens.some((qt: string) =>
          matchTokens.some((mt: string) => mt.includes(qt) || qt.includes(mt) || nameSimilarity(qt, mt) > 0.8)
        );
        if (hasTokenOverlap) {
          return { clientId: scored[0].id, needsVerification: false, matchedName: scored[0].name };
        }
      }

      // Multiple possible matches - ask for verification
      if (scored.length > 0) {
        const opts = scored.slice(0, 4).map((c: any, i: number) => `${i + 1}. ${c.name}`).join("\n");
        return {
          clientId: null,
          needsVerification: true,
          message: `I found some possible matches for "${clientName}" but I'm not confident:\n\n${opts}\n\nCould you confirm which one, or let me know if the file might be listed under a different name?`,
        };
      }
    }
  } catch (err) {
    console.error("[RESOLVE] CG client lookup error:", err);
  }

  // Step 2: Try local fuzzy search (clients table, aliases, Drive folders)
  try {
    const localResult = await fuzzyClientSearch(clientName);
    if (localResult.exactMatch && !localResult.needsVerification) {
      return { clientId: localResult.exactMatch.id, needsVerification: false, matchedName: localResult.exactMatch.name };
    }
    if (localResult.fuzzyMatches.length > 0) {
      const opts = localResult.fuzzyMatches.slice(0, 4)
        .map((m, i) => `${i + 1}. ${m.name} (${m.source.replace("_", " ")})`).join("\n");
      return {
        clientId: null,
        needsVerification: true,
        message: `I found some possible matches for "${clientName}":\n\n${opts}\n\nCould you confirm which one? Or if none of these are right, the file might be listed under a different name (like a nickname or legal name).`,
      };
    }
  } catch (err) {
    console.error("[RESOLVE] Local fuzzy search error:", err);
  }

  // Step 3: No match anywhere - ask user if it could be under a different name
  return {
    clientId: null,
    needsVerification: true,
    message: `I couldn't find a client matching "${clientName}" in our system. Could the file be listed under a different name? Sometimes files are stored under a nickname, legal name, or folder name that's different from what you used.`,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    let clientId = body.client_id as string | undefined;
    const clientName = body.client_name as string | undefined;

    if (!clientId && clientName) {
      const resolution = await resolveClientId(clientName);
      if (resolution.needsVerification || !resolution.clientId) {
        return new Response(JSON.stringify({
          ok: false,
          needsVerification: true,
          message: resolution.message,
          searchedFor: clientName,
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      clientId = resolution.clientId;
      console.log(`[RESOLVE] "${clientName}" resolved to client ${clientId} (${resolution.matchedName})`);
    }

    if (!clientId) {
      return new Response(JSON.stringify({
        ok: false,
        needsVerification: true,
        message: "I need a client name to analyze. Who would you like me to look up?",
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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
        analysis: analysis,
        model: "claude-sonnet-4-20250514",
      })
      .select("id, created_at")
      .single();
    if (error) throw new Error(error.message || JSON.stringify(error));

    return new Response(JSON.stringify({
      ok: true,
      analysis_id: row.id,
      created_at: row.created_at,
      client_id: clientId,
      analysis,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[analyze-credit-strategy] Error:", err);
    return new Response(JSON.stringify({ ok: false, error: err?.message || JSON.stringify(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function parseCsvLoose(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.trim().split(/\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const split = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') q = !q;
      else if ((c === "," || c === "\t") && !q) {
        out.push(cur.trim());
        cur = "";
      } else cur += c;
    }
    out.push(cur.trim());
    return out;
  };
  const headers = split(lines[0]).map((h) => h.replace(/^"|"$/g, ""));
  const rows = lines.slice(1).map(split);
  return { headers, rows };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST only" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  try {
    const body = await req.json();
    const csv_text = body.csv_text as string | undefined;
    const pdf_base64 = body.pdf_base64 as string | undefined;

    if (csv_text && typeof csv_text === "string") {
      const { headers, rows } = parseCsvLoose(csv_text);
      let deposits = 0;
      let withdrawals = 0;
      const flagged: Array<{ date: string; amount: number; desc: string; flag: string }> = [];
      for (const row of rows) {
        const joined = row.join(" ").toLowerCase();
        const nums = row.map((c) => parseFloat(String(c).replace(/[$,]/g, ""))).filter((n) =>
          Number.isFinite(n)
        );
        const amt = nums.find((n) => Math.abs(n) > 0.009) ?? 0;
        if (joined.includes("deposit") || amt > 0) deposits += Math.abs(amt);
        if (joined.includes("withdraw") || joined.includes("debit") || amt < 0) {
          withdrawals += Math.abs(amt);
        }
        if (Math.abs(amt) > 500 && /venmo|zelle|cash app|paypal|transfer/i.test(joined)) {
          flagged.push({
            date: row[0] || "",
            amount: amt,
            desc: row.slice(0, 4).join(" "),
            flag: "Needs classification",
          });
        }
      }
      return new Response(
        JSON.stringify({
          ok: true,
          format: "csv",
          headers,
          row_count: rows.length,
          total_deposits: Math.round(deposits * 100) / 100,
          total_withdrawals: Math.round(withdrawals * 100) / 100,
          business_income: null,
          personal_income: null,
          business_expenses_by_category: {} as Record<string, number>,
          flagged_transactions: flagged.slice(0, 50),
          note:
            "Heuristic parse — review transactions before applying amounts to the tax return.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (pdf_base64) {
      return new Response(
        JSON.stringify({
          ok: false,
          error:
            "PDF extraction is not wired in this function yet. Export transactions to CSV or use document ingestion.",
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ ok: false, error: "Provide csv_text or pdf_base64" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

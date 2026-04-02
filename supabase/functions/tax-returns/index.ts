// supabase/functions/tax-returns/index.ts
// REST endpoint for querying tax returns and their form instances.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getTaxReturn, getTaxReturnById, listTaxReturns, getFormInstances } from "../_shared/taxReturns.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const params = url.searchParams;

    // GET with query params
    const clientId = params.get("client_id");
    const year = params.get("year") ? parseInt(params.get("year")!) : null;
    const returnId = params.get("id");

    // Also support POST body for Telegram webhook compatibility
    let bodyClientId: string | undefined;
    let bodyYear: number | undefined;
    let bodyReturnId: string | undefined;
    let bodyAction: string | undefined;

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      bodyClientId = body.client_id;
      bodyYear = body.year || body.tax_year;
      bodyReturnId = body.id || body.tax_return_id;
      bodyAction = body.action;
    }

    const effectiveClientId = clientId || bodyClientId;
    const effectiveYear = year || bodyYear;
    const effectiveReturnId = returnId || bodyReturnId;
    const action = bodyAction || (effectiveReturnId ? "get_by_id" : effectiveYear ? "get" : "list");

    let result: any;

    switch (action) {
      case "get_by_id": {
        if (!effectiveReturnId) throw new Error("id is required for get_by_id");
        result = await getTaxReturnById(supabase, effectiveReturnId);
        if (!result) {
          return new Response(JSON.stringify({ ok: false, error: "Tax return not found" }), {
            status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        break;
      }
      case "get": {
        if (!effectiveClientId || !effectiveYear) throw new Error("client_id and year are required");
        result = await getTaxReturn(supabase, effectiveClientId, effectiveYear);
        if (!result) {
          return new Response(JSON.stringify({ ok: false, error: "No tax return found for client " + effectiveClientId + " year " + effectiveYear }), {
            status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        break;
      }
      case "get_forms": {
        if (!effectiveReturnId) throw new Error("tax_return_id is required for get_forms");
        const forms = await getFormInstances(supabase, effectiveReturnId);
        result = { tax_return_id: effectiveReturnId, forms, count: forms.length };
        break;
      }
      case "list":
      default: {
        const returns = await listTaxReturns(supabase, effectiveClientId || undefined);
        result = { returns, count: returns.length };
        break;
      }
    }

    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("tax-returns error: " + msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

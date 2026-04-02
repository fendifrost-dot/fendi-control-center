// supabase/functions/regenerate-tax-pdfs/index.ts
// Re-generates filled IRS PDFs for an existing tax return.
// Used when computed_data is updated or corrections are needed.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getTaxReturnById, logAudit } from "../_shared/taxReturns.ts";

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
    const body = await req.json();
    const { tax_return_id, computed_data_overrides, draft_mode = true } = body;

    if (!tax_return_id) throw new Error("tax_return_id is required");

    // Fetch the existing tax return
    const taxReturn = await getTaxReturnById(supabase, tax_return_id);
    if (!taxReturn) throw new Error("Tax return not found: " + tax_return_id);

    // Merge overrides with existing json_summary computed data
    const existingData = taxReturn.json_summary?.form_1040 || {};
    const mergedData = { ...existingData, ...(computed_data_overrides || {}) };

    // Delete existing form instances (they will be regenerated)
    const { error: deleteErr } = await supabase
      .from("tax_form_instances")
      .delete()
      .eq("tax_return_id", tax_return_id);

    if (deleteErr) console.warn("Failed to delete old form instances: " + deleteErr.message);

    // Update the tax return with merged data if overrides were provided
    if (computed_data_overrides) {
      const updatedSummary = { ...taxReturn.json_summary, form_1040: mergedData };
      await supabase
        .from("tax_returns")
        .update({
          json_summary: updatedSummary,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tax_return_id);
    }

    // Call fill-tax-forms to regenerate PDFs
    const fillResp = await fetch(SUPABASE_URL + "/functions/v1/fill-tax-forms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({
        tax_return_id,
        client_id: taxReturn.client_id,
        client_name: taxReturn.client_name,
        tax_year: taxReturn.tax_year,
        computed_data: mergedData,
        draft_mode,
      }),
    });

    if (!fillResp.ok) {
      const errText = await fillResp.text();
      throw new Error("fill-tax-forms failed (" + fillResp.status + "): " + errText.slice(0, 300));
    }

    const fillResult = await fillResp.json();

    // Audit log
    await logAudit(supabase, {
      tax_return_id,
      action: "pdfs_regenerated",
      actor: "regenerate-tax-pdfs",
      old_values: { form_count: taxReturn.tax_form_instances?.length || 0 },
      new_values: {
        form_count: fillResult.forms_generated,
        overrides_applied: !!computed_data_overrides,
        draft_mode,
      },
    });

    return new Response(JSON.stringify({
      ok: true,
      tax_return_id,
      regenerated: true,
      ...fillResult,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("regenerate-tax-pdfs error: " + msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

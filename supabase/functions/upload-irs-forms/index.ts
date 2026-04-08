// supabase/functions/upload-irs-forms/index.ts
// One-shot utility: downloads blank IRS PDFs from irs.gov and caches them in the
// "irs-forms" Supabase storage bucket so fill-tax-forms never has to hit irs.gov at runtime.
//
// Usage (run once per tax year):
//   curl -X POST https://<project>.supabase.co/functions/v1/upload-irs-forms \
//     -H "Authorization: Bearer <service-role-key>" \
//     -H "Content-Type: application/json" \
//     -d '{"tax_year": 2022}'

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { determineRequiredForms } from "../_shared/pdfFormFill.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Forms needed for a typical self-employed return
const DEFAULT_FORMS = [
  "1040",    // Form 1040
  "1040sc",  // Schedule C (business income)
  "1040sse", // Schedule SE (self-employment tax)
  "1040s1",  // Schedule 1 (additional income/adjustments)
  "1040s2",  // Schedule 2 (additional taxes)
  "1040s3",  // Schedule 3 (additional credits)
];

function getIrsUrl(formSlug: string, year: number): string {
  const currentYear = new Date().getFullYear();
  if (year >= currentYear) {
    return `https://www.irs.gov/pub/irs-pdf/f${formSlug}.pdf`;
  }
  return `https://www.irs.gov/pub/irs-prior/f${formSlug}--${year}.pdf`;
}

async function fetchWithTimeout(url: string, timeoutMs = 20000): Promise<Response> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(tid);
  }
}

async function ensureBucket(supabase: any): Promise<void> {
  const { data: buckets } = await supabase.storage.listBuckets();
  const exists = buckets?.some((b: { name: string }) => b.name === "irs-forms");
  if (!exists) {
    const { error } = await supabase.storage.createBucket("irs-forms", {
      public: false,
      fileSizeLimit: 52428800, // 50 MB
    });
    if (error && !error.message?.includes("already exists")) {
      throw new Error(`Failed to create irs-forms bucket: ${error.message}`);
    }
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const taxYear: number = Number(body.tax_year ?? new Date().getFullYear() - 1);

    // Accept explicit form list, computed_data for dynamic detection, or fall back to defaults
    let forms: string[];
    if (Array.isArray(body.forms) && body.forms.length > 0) {
      forms = body.forms;
    } else if (body.computed_data && typeof body.computed_data === "object") {
      forms = determineRequiredForms(body.computed_data as Record<string, unknown>);
      console.log(`[upload-irs-forms] Determined forms from computed_data: ${forms.join(", ")}`);
    } else {
      forms = DEFAULT_FORMS;
    }

    console.log(`[upload-irs-forms] Uploading ${forms.length} forms for tax year ${taxYear}`);

    await ensureBucket(supabase);

    const results: Record<string, unknown>[] = [];

    for (const formType of forms) {
      const formSlug = formType.toLowerCase().replace(/[^a-z0-9]/g, "");
      const storageKey = `f${formSlug}--${taxYear}.pdf`;

      // Skip if already cached
      const { data: existing } = await supabase.storage.from("irs-forms").download(storageKey);
      if (existing) {
        console.log(`[upload-irs-forms] Already cached: ${storageKey}`);
        results.push({ form: formType, storageKey, status: "already_cached" });
        continue;
      }

      const url = getIrsUrl(formSlug, taxYear);
      console.log(`[upload-irs-forms] Fetching ${url}`);

      let pdfBytes: Uint8Array;
      try {
        const resp = await fetchWithTimeout(url);
        if (!resp.ok) {
          // Try current-year fallback
          const fallback = `https://www.irs.gov/pub/irs-pdf/f${formSlug}.pdf`;
          console.warn(`[upload-irs-forms] ${url} returned ${resp.status}, trying ${fallback}`);
          const resp2 = await fetchWithTimeout(fallback);
          if (!resp2.ok) {
            results.push({ form: formType, storageKey, status: "error", error: `IRS returned ${resp2.status}` });
            continue;
          }
          pdfBytes = new Uint8Array(await resp2.arrayBuffer());
        } else {
          pdfBytes = new Uint8Array(await resp.arrayBuffer());
        }
      } catch (e) {
        results.push({ form: formType, storageKey, status: "error", error: String(e) });
        continue;
      }

      const { error: uploadErr } = await supabase.storage
        .from("irs-forms")
        .upload(storageKey, pdfBytes, { contentType: "application/pdf", upsert: true });

      if (uploadErr) {
        results.push({ form: formType, storageKey, status: "error", error: uploadErr.message });
      } else {
        console.log(`[upload-irs-forms] Uploaded ${storageKey} (${pdfBytes.length} bytes)`);
        results.push({ form: formType, storageKey, status: "uploaded", bytes: pdfBytes.length });
      }
    }

    const uploaded = results.filter((r) => r.status === "uploaded").length;
    const cached = results.filter((r) => r.status === "already_cached").length;
    const errors = results.filter((r) => r.status === "error").length;

    return new Response(
      JSON.stringify({ ok: true, tax_year: taxYear, uploaded, already_cached: cached, errors, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(`[upload-irs-forms] Fatal: ${err}`);
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

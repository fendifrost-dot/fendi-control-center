// supabase/functions/fill-tax-forms/index.ts
// Edge function to fill IRS tax form PDFs and upload to Drive + Supabase storage

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getIrsFormUrl,
  determineRequiredForms,
  fillPdfForm,
  addDraftWatermark,
  inspectPdfFields,
} from "../_shared/pdfFormFill.ts";
import {
  getAccessToken,
  uploadFileToDrive,
  getOrCreateClientTaxFolder,
} from "../_shared/googleDriveUpload.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Flatten nested computed data into a flat key-value map.
 * e.g. { form_1040: { line_1: "50000" } } => { "form_1040.line_1": "50000", "line_1": "50000" }
 */
function flattenComputedData(
  data: Record<string, unknown>,
  prefix = ""
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (value && typeof value === "object" && !Array.isArray(value)) {
      // Recurse into nested objects
      const nested = flattenComputedData(value as Record<string, unknown>, fullKey);
      Object.assign(result, nested);
      // Also keep short key for convenience
      const shortNested = flattenComputedData(value as Record<string, unknown>, "");
      for (const [shortKey, shortVal] of Object.entries(shortNested)) {
        if (!result[shortKey]) {
          result[shortKey] = shortVal;
        }
      }
    } else {
      result[fullKey] = value;
      // Also store without prefix for flat access
      if (prefix && !result[key]) {
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Build basic field mappings for common 1040 fields.
 * Maps computed_data keys to PDF form field names.
 */
function getFieldMappings(formType: string): Record<string, string> {
  const mappings: Record<string, Record<string, string>> = {
    "1040": {
      first_name: "topmostSubform[0].Page1[0].f1_02[0]",
      last_name: "topmostSubform[0].Page1[0].f1_03[0]",
      ssn: "topmostSubform[0].Page1[0].f1_04[0]",
      address: "topmostSubform[0].Page1[0].f1_06[0]",
      city_state_zip: "topmostSubform[0].Page1[0].f1_07[0]",
      filing_status: "topmostSubform[0].Page1[0].c1_1[0]",
      wages: "topmostSubform[0].Page1[0].f1_10[0]",
      interest_income: "topmostSubform[0].Page1[0].f1_12[0]",
      total_income: "topmostSubform[0].Page1[0].f1_22[0]",
      adjusted_gross_income: "topmostSubform[0].Page1[0].f1_26[0]",
      standard_deduction: "topmostSubform[0].Page2[0].f2_02[0]",
      taxable_income: "topmostSubform[0].Page2[0].f2_04[0]",
      tax: "topmostSubform[0].Page2[0].f2_06[0]",
      total_tax: "topmostSubform[0].Page2[0].f2_14[0]",
      total_payments: "topmostSubform[0].Page2[0].f2_18[0]",
      refund: "topmostSubform[0].Page2[0].f2_20[0]",
      amount_owed: "topmostSubform[0].Page2[0].f2_24[0]",
    },
    "1040sc": {
      business_name: "topmostSubform[0].Page1[0].f1_02[0]",
      principal_business: "topmostSubform[0].Page1[0].f1_01[0]",
      business_code: "topmostSubform[0].Page1[0].f1_03[0]",
      ein: "topmostSubform[0].Page1[0].f1_04[0]",
      gross_receipts: "topmostSubform[0].Page1[0].f1_07[0]",
      total_expenses: "topmostSubform[0].Page1[0].f1_30[0]",
      net_profit: "topmostSubform[0].Page1[0].f1_31[0]",
    },
    "1040sse": {
      net_earnings: "topmostSubform[0].Page1[0].f1_03[0]",
      se_tax: "topmostSubform[0].Page1[0].f1_11[0]",
      deduction: "topmostSubform[0].Page1[0].f1_12[0]",
    },
  };

  return mappings[formType] || {};
}

async function ensureStorageBucket(supabase: ReturnType<typeof createClient>, bucketName: string) {
  const { data: buckets } = await supabase.storage.listBuckets();
  const exists = buckets?.some((b: { name: string }) => b.name === bucketName);
  if (!exists) {
    const { error } = await supabase.storage.createBucket(bucketName, {
      public: false,
      fileSizeLimit: 52428800, // 50MB
    });
    if (error && !error.message?.includes("already exists")) {
      console.error(`Failed to create bucket: ${error.message}`);
    }
  }
}

async function processForm(
  supabase: ReturnType<typeof createClient>,
  driveAccessToken: string,
  driveFolderId: string,
  formType: string,
  taxYear: number,
  taxReturnId: string,
  clientName: string,
  flatData: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const formLabel = formType.toUpperCase();
  console.log(`Processing form: ${formLabel} for ${taxYear}`);

  // 1. Fetch blank IRS PDF
  const pdfUrl = getIrsFormUrl(formType, taxYear);
  console.log(`Fetching PDF from: ${pdfUrl}`);

  let pdfResponse: Response;
  try {
    pdfResponse = await fetch(pdfUrl);
    if (!pdfResponse.ok) {
      // Fallback to current year form if prior year not available
      const fallbackUrl = getIrsFormUrl(formType, new Date().getFullYear());
      console.log(`Prior year PDF not found, trying current: ${fallbackUrl}`);
      pdfResponse = await fetch(fallbackUrl);
      if (!pdfResponse.ok) {
        throw new Error(`Failed to fetch form ${formType}: ${pdfResponse.status}`);
      }
    }
  } catch (err) {
    return { form: formType, status: "error", error: `Failed to fetch PDF: ${err}` };
  }

  const pdfBytes = new Uint8Array(await pdfResponse.arrayBuffer());

  // 2. Inspect fields for debugging
  try {
    const fields = await inspectPdfFields(pdfBytes);
    console.log(`Form ${formType} has ${fields.length} fields: ${fields.slice(0, 5).map(f => f.name).join(", ")}...`);
  } catch (err) {
    console.warn(`Could not inspect fields: ${err}`);
  }

  // 3. Fill fields
  const fieldMappings = getFieldMappings(formType);
  let filledDoc;
  try {
    filledDoc = await fillPdfForm(pdfBytes, fieldMappings, flatData);
  } catch (err) {
    return { form: formType, status: "error", error: `Failed to fill PDF: ${err}` };
  }

  // 4. Add DRAFT watermark
  await addDraftWatermark(filledDoc);

  // 5. Save filled PDF
  const filledPdfBytes = await filledDoc.save();
  const fileName = `${clientName.replace(/\s+/g, "_")}_${taxYear}_${formType}_DRAFT.pdf`;
  const storagePath = `${taxReturnId}/${fileName}`;

  // 6. Upload to Supabase storage
  const bucketName = "tax-documents";
  await ensureStorageBucket(supabase, bucketName);

  const { error: uploadError } = await supabase.storage
    .from(bucketName)
    .upload(storagePath, filledPdfBytes, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadError) {
    console.error(`Storage upload error: ${uploadError.message}`);
  }

  // 7. Upload to Google Drive
  let driveResult = null;
  try {
    driveResult = await uploadFileToDrive(
      driveAccessToken,
      fileName,
      new Uint8Array(filledPdfBytes),
      "application/pdf",
      driveFolderId
    );
    console.log(`Uploaded to Drive: ${driveResult.name} (${driveResult.id})`);
  } catch (err) {
    console.error(`Drive upload error: ${err}`);
  }

  // 8. Insert tax_form_instances row
  const { error: dbError } = await supabase.from("tax_form_instances").insert({
    tax_return_id: taxReturnId,
    form_type: formType,
    tax_year: taxYear,
    status: "draft",
    storage_path: storagePath,
    drive_file_id: driveResult?.id || null,
    drive_link: driveResult?.webViewLink || null,
    field_count: Object.keys(fieldMappings).length,
    created_at: new Date().toISOString(),
  });

  if (dbError) {
    console.error(`DB insert error: ${dbError.message}`);
  }

  return {
    form: formType,
    status: "success",
    fileName,
    storagePath,
    driveFileId: driveResult?.id || null,
    driveLink: driveResult?.webViewLink || null,
  };
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const {
      tax_return_id,
      tax_year,
      client_name,
      client_id,
      computed_data,
    } = await req.json();

    if (!tax_return_id || !tax_year || !client_name || !computed_data) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: tax_return_id, tax_year, client_name, computed_data" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`=== Fill Tax Forms: ${client_name} ${tax_year} (return: ${tax_return_id}) ===`);

    // Flatten computed data
    const flatData = flattenComputedData(computed_data);
    console.log(`Flattened data keys: ${Object.keys(flatData).slice(0, 20).join(", ")}...`);

    // Determine required forms
    const requiredForms = determineRequiredForms(computed_data);
    console.log(`Required forms: ${requiredForms.join(", ")}`);

    // Get Google Drive access
    let driveAccessToken: string;
    let driveFolderId: string;
    try {
      driveAccessToken = await getAccessToken();
      driveFolderId = await getOrCreateClientTaxFolder(driveAccessToken, client_name, tax_year);
      console.log(`Drive folder ID: ${driveFolderId}`);
    } catch (err) {
      console.error(`Google Drive auth failed: ${err}`);
      return new Response(
        JSON.stringify({ error: `Google Drive authentication failed: ${err}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Process forms in batches of 3
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < requiredForms.length; i += 3) {
      const batch = requiredForms.slice(i, i + 3);
      console.log(`Processing batch ${Math.floor(i / 3) + 1}: ${batch.join(", ")}`);

      const batchResults = await Promise.all(
        batch.map((formType) =>
          processForm(
            supabase,
            driveAccessToken,
            driveFolderId,
            formType,
            Number(tax_year),
            tax_return_id,
            client_name,
            flatData
          )
        )
      );
      results.push(...batchResults);
    }

    // Update tax return status
    await supabase
      .from("tax_returns")
      .update({ status: "forms_generated", forms_generated_at: new Date().toISOString() })
      .eq("id", tax_return_id);

    const successCount = results.filter((r) => r.status === "success").length;
    const errorCount = results.filter((r) => r.status === "error").length;

    console.log(`=== Complete: ${successCount} success, ${errorCount} errors ===`);

    return new Response(
      JSON.stringify({
        success: true,
        tax_return_id,
        client_name,
        tax_year,
        forms_processed: results.length,
        successful: successCount,
        errors: errorCount,
        results,
        drive_folder_id: driveFolderId,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(`Unhandled error: ${err}`);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

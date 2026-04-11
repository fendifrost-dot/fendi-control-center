// supabase/functions/fill-tax-forms/index.ts
// Edge function to fill IRS tax form PDFs and upload to Drive + Supabase storage

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  fetchIrsFormPdf,
  determineRequiredForms,
  fillPdfForm,
  addDraftWatermark,
  inspectPdfFields,
} from "../_shared/pdfFormFill.ts";
import { getExpandedFieldMappings } from "../_shared/irsFieldMappings.ts";
import {
  getAccessToken,
  uploadFileToDrive,
  ensureClientTaxReturnsYearFolder,
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

/** Maps computed_data / json_summary keys to IRS AcroForm names (see _shared/irsFieldMappings.ts). */
function getFieldMappings(formType: string, taxYear: number): Record<string, string> {
  return getExpandedFieldMappings(formType, taxYear);
}

function deriveFilingStatusCheckboxes(flatData: Record<string, unknown>) {
  const raw =
    (flatData.form_1040 && typeof flatData.form_1040 === "object"
      ? (flatData.form_1040 as Record<string, unknown>).filing_status
      : undefined) ||
    flatData["form_1040.filing_status"] ||
    flatData.filing_status;
  const status = String(raw ?? "").toLowerCase();
  if (!status) {
    flatData.filing_status_single = "1";
    return;
  }
  if (status.includes("joint")) flatData.filing_status_mfj = "1";
  else if (status.includes("separate")) flatData.filing_status_mfs = "1";
  else if (status.includes("head")) flatData.filing_status_hoh = "1";
  else if (status.includes("widow")) flatData.filing_status_qw = "1";
  else flatData.filing_status_single = "1";
}

function pickFormFieldData(
  flatData: Record<string, unknown>,
  fieldMappings: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fieldMappings)) {
    const value = flatData[key];
    if (value !== undefined && value !== null && value !== "") {
      out[key] = value;
    }
  }
  return out;
}

async function ensureStorageBucket(supabase: any, bucketName: string) {
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
  supabase: any,
  driveAccessToken: string | null,
  driveFolderId: string | null,
  formType: string,
  taxYear: number,
  taxReturnId: string,
  clientName: string,
  flatData: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const formLabel = formType.toUpperCase();
  console.log(`Processing form: ${formLabel} for ${taxYear}`);

  // 1. Fetch blank IRS PDF — tries Supabase storage first, then irs.gov
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await fetchIrsFormPdf(supabase, formType, taxYear);
  } catch (err) {
    console.error(`[fill-tax-forms] ${err}`);
    return { form: formType, status: "error", error: `Failed to fetch PDF: ${err}` };
  }

  // 2. Inspect fields for debugging
  try {
    const fields = await inspectPdfFields(pdfBytes);
    console.log(`Form ${formType} has ${fields.length} fields: ${fields.slice(0, 5).map(f => f.name).join(", ")}...`);
  } catch (err) {
    console.warn(`Could not inspect fields: ${err}`);
  }

  // 3. Fill fields
  const fieldMappings = getFieldMappings(formType, taxYear);
  const formFieldData = pickFormFieldData(flatData, fieldMappings);
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

  // 7. Upload to Google Drive (skipped if Drive auth is unavailable)
  let driveResult = null;
  if (driveAccessToken && driveFolderId) {
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
      const message = String(err);
      console.warn(`Drive upload failed for ${formType}: ${message}`);
      // One retry path for expired/invalid token errors.
      if (message.includes("401") || message.toLowerCase().includes("unauthorized")) {
        try {
          const refreshedToken = await getAccessToken();
          driveResult = await uploadFileToDrive(
            refreshedToken,
            fileName,
            new Uint8Array(filledPdfBytes),
            "application/pdf",
            driveFolderId
          );
          console.log(`Uploaded to Drive after token refresh: ${driveResult.name} (${driveResult.id})`);
        } catch (retryErr) {
          console.warn(`Drive retry failed for ${formType}: ${retryErr}`);
        }
      }
    }
  } else {
    console.warn(`Drive unavailable; skipping upload for ${formType}`);
  }

  // 8. Insert tax_form_instances row
  const { error: dbError } = await supabase.from("tax_form_instances").insert({
    tax_return_id: taxReturnId,
    form_type: formType,
    form_year: taxYear,
    status: "draft",
    pdf_url: storagePath,
    drive_file_id: driveResult?.id || null,
    field_data: formFieldData,
    notes: `fields: ${Object.keys(fieldMappings).length}, drive_link: ${driveResult?.webViewLink || "N/A"}`,
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

    const body = await req.json();
    const {
      tax_return_id,
      tax_year,
      client_name,
      client_id: bodyClientId,
      computed_data: computedFromBody,
    } = body;

    if (!tax_return_id || !tax_year || !client_name) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields: tax_return_id, tax_year, client_name",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let resolvedClientId =
      typeof bodyClientId === "string" && bodyClientId.trim() ? bodyClientId.trim() : null;
    if (!resolvedClientId) {
      const { data: trForClient, error: trClientErr } = await supabase
        .from("tax_returns")
        .select("client_id")
        .eq("id", tax_return_id)
        .maybeSingle();
      if (trClientErr || !trForClient?.client_id) {
        return new Response(
          JSON.stringify({
            error: "could not resolve client_id",
            detail: trClientErr?.message ?? "tax_returns row missing client_id",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      resolvedClientId = trForClient.client_id as string;
    }

    const { data: clientRow, error: clientErr } = await supabase
      .from("clients")
      .select("id, name, drive_folder_id")
      .eq("id", resolvedClientId)
      .single();

    if (clientErr || !clientRow) {
      return new Response(
        JSON.stringify({ error: "client not found", detail: clientErr?.message }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!clientRow.drive_folder_id) {
      console.error(
        `[fill-tax-forms] client ${clientRow.id} (${clientRow.name}) has no drive_folder_id set — refusing to run name-based folder search (ghost folder bug)`,
      );
      return new Response(
        JSON.stringify({
          error: "client has no drive_folder_id",
          detail:
            "Set clients.drive_folder_id to a folder inside the Fendi Tax Returns Shared Drive before running fill-tax-forms. Name-based folder resolution is disabled to prevent creating ghost folders in the service account's My Drive.",
          client_id: clientRow.id,
          client_name: clientRow.name,
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let computed_data = computedFromBody as Record<string, unknown> | undefined;
    const missingComputed =
      !computed_data ||
      typeof computed_data !== "object" ||
      Array.isArray(computed_data) ||
      Object.keys(computed_data).length === 0;
    if (missingComputed) {
      const { data: tr, error: trErr } = await supabase
        .from("tax_returns")
        .select("json_summary")
        .eq("id", tax_return_id)
        .maybeSingle();
      if (trErr || !tr?.json_summary) {
        return new Response(
          JSON.stringify({
            error: "computed_data missing and no json_summary on tax_returns row",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      computed_data = tr.json_summary as Record<string, unknown>;
    }

    console.log(`=== Fill Tax Forms: ${client_name} ${tax_year} (return: ${tax_return_id}) ===`);

    await supabase.from("tax_form_instances").delete().eq("tax_return_id", tax_return_id);

    // Flatten computed data
    const flatData = flattenComputedData(computed_data!);
    deriveFilingStatusCheckboxes(flatData);
    console.log(`Flattened data keys: ${Object.keys(flatData).slice(0, 20).join(", ")}...`);

    // Determine required forms
    const requiredForms = determineRequiredForms(computed_data!);
    console.log(`Required forms: ${requiredForms.join(", ")}`);

    // Get Google Drive access
    let driveAccessToken: string | null = null;
    let driveFolderId: string | null = null;
    try {
      driveAccessToken = await getAccessToken();
      console.log(
        `[fill-tax-forms] using client.drive_folder_id=${clientRow.drive_folder_id} for client=${clientRow.name} year=${tax_year}`,
      );
      driveFolderId = await ensureClientTaxReturnsYearFolder(
        driveAccessToken,
        clientRow.drive_folder_id,
        Number(tax_year),
      );
      console.log(`Drive year folder ID: ${driveFolderId}`);
    } catch (err) {
      console.warn(`Google Drive auth failed, continuing without Drive upload: ${err}`);
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

    // Mark ready for human review after PDF generation
    await supabase
      .from("tax_returns")
      .update({ status: "review", updated_at: new Date().toISOString() })
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
        drive_available: !!driveAccessToken,
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

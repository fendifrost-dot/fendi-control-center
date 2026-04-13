// supabase/functions/fill-tax-forms/index.ts
// Fills IRS PDF forms with computed tax data, uploads to Supabase Storage + Google Drive,
// and records each filled form in the tax_form_instances table.
//
// FIXED: Flatten nested computed_data (form_1040.X, schedule_c.Y) into flat keys
// so pdfFormFill field mappings can find them.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { fillPdfForm, addDraftWatermark, determineRequiredForms } from "../_shared/pdfFormFill.ts";
import { uploadToDrive, getOrCreateClientTaxFolder } from "../_shared/googleDriveUpload.ts";
import { insertFormInstance, updateFormInstance, logAudit } from "../_shared/taxReturns.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const FORM_DISPLAY_NAMES: Record<string, string> = {
  "1040": "Form 1040 - U.S. Individual Income Tax Return",
  "schedule_c": "Schedule C - Profit or Loss From Business",
  "schedule_se": "Schedule SE - Self-Employment Tax",
};

/**
 * Flatten nested computed_data from Claude into a flat key-value map.
 * Claude outputs: { form_1040: { total_income: X }, schedule_c: { gross_income: Y }, ... }
 * pdfFormFill expects: { total_income: X, gross_income: Y, ... }
 *
 * Also handles the case where data is already flat.
 */
function flattenComputedData(data: Record<string, unknown>): Record<string, unknown> {
  const flat: Record<string, unknown> = {};

  // First, copy any top-level non-object values (already flat keys)
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      // This is a nested section like form_1040, schedule_c, schedule_se, filing_readiness
      const section = value as Record<string, unknown>;
      for (const [subKey, subValue] of Object.entries(section)) {
        // Don't overwrite if the same key exists from a more specific section
        if (!(subKey in flat)) {
          flat[subKey] = subValue;
        }
      }
    } else {
      flat[key] = value;
    }
  }

  // Map common Claude output field names to what pdfFormFill expects
  const aliases: Record<string, string> = {
    "net_profit": "net_profit_or_loss",
    "gross_receipts_or_sales": "gross_receipts",
    "total_expenses_amount": "total_expenses",
    "se_tax": "self_employment_tax",
    "deductible_se_tax": "deductible_half_se",
    "deductible_half": "deductible_half_se",
    "net_se_earnings": "net_earnings",
  };

  for (const [from, to] of Object.entries(aliases)) {
    if (flat[from] !== undefined && flat[to] === undefined) {
      flat[to] = flat[from];
    }
  }

  // Derive fields that Claude might not explicitly output
  if (flat["net_profit_or_loss"] === undefined && flat["gross_income"] !== undefined && flat["total_expenses"] !== undefined) {
    flat["net_profit_or_loss"] = Number(flat["gross_income"]) - Number(flat["total_expenses"]);
  }
  if (flat["net_earnings"] === undefined && flat["net_profit_or_loss"] !== undefined) {
    flat["net_earnings"] = Math.round(Number(flat["net_profit_or_loss"]) * 0.9235);
  }
  if (flat["se_tax_multiplied"] === undefined && flat["net_earnings"] !== undefined) {
    flat["se_tax_multiplied"] = Math.round(Number(flat["net_earnings"]) * 0.9235);
  }
  if (flat["self_employment_tax"] === undefined && flat["net_earnings"] !== undefined) {
    flat["self_employment_tax"] = Math.round(Number(flat["net_earnings"]) * 0.1413);
  }
  if (flat["deductible_half_se"] === undefined && flat["self_employment_tax"] !== undefined) {
    flat["deductible_half_se"] = Math.round(Number(flat["self_employment_tax"]) / 2);
  }

  console.log("Flattened computed_data keys: " + Object.keys(flat).filter(k => flat[k] !== undefined && flat[k] !== null).join(", "));
  return flat;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const {
      tax_return_id,
      client_id,
      client_name,
      tax_year,
      computed_data,
      draft_mode = true,
    } = body;

    if (!tax_return_id) throw new Error("tax_return_id is required");
    if (!tax_year) throw new Error("tax_year is required");
    if (!computed_data || typeof computed_data !== "object") throw new Error("computed_data object is required");

    console.log("Filling tax forms for return " + tax_return_id + " year " + tax_year);
    console.log("Raw computed_data keys: " + Object.keys(computed_data).join(", "));

    // Flatten nested Claude output into flat field map
    const flatData = flattenComputedData(computed_data);

    // Determine which forms to generate using flattened data
    const requiredForms = determineRequiredForms(flatData);
    console.log("Required forms: " + requiredForms.join(", "));

    // Get or create Drive folder for this client/year
    let driveFolderId: string | null = null;
    let driveFolderUrl: string | null = null;
    try {
      const folder = await getOrCreateClientTaxFolder(client_name || client_id, tax_year);
      driveFolderId = folder.folderId;
      driveFolderUrl = folder.folderUrl;
      console.log("Drive folder: " + driveFolderUrl);
    } catch (driveErr) {
      console.warn("Drive folder creation failed (continuing without Drive): " + driveErr);
    }

    const results: Array<{
      form_type: string;
      form_name: string;
      instance_id: string;
      pdf_url: string | null;
      drive_url: string | null;
      filled_fields: string[];
      failed_fields: string[];
      status: string;
    }> = [];

    // Process forms in parallel batches of 3
    const batchSize = 3;
    for (let i = 0; i < requiredForms.length; i += batchSize) {
      const batch = requiredForms.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map(async (formType) => {
          const formName = FORM_DISPLAY_NAMES[formType] || formType;
          console.log("Processing " + formType + "...");

          // Create a pending form instance
          const instanceId = await insertFormInstance(supabase, {
            tax_return_id,
            form_type: formType,
            form_year: tax_year,
            status: "pending",
            field_data: flatData,
          });

          try {
            // Fill the PDF with FLATTENED data
            const { pdfBytes, filledFields, failedFields } = await fillPdfForm(
              formType, tax_year, flatData
            );

            console.log(formType + " filled " + filledFields.length + " fields, " + failedFields.length + " failed");

            // Add DRAFT watermark if in draft mode
            const finalPdf = draft_mode
              ? await addDraftWatermark(pdfBytes)
              : pdfBytes;

            // Upload to Supabase Storage
            const safeName = (client_name || client_id || "unknown").replace(/[^a-zA-Z0-9]/g, "_");
            const fileName = formType + "_" + tax_year + "_" + safeName + ".pdf";
            const storagePath = "tax-forms/" + tax_return_id + "/" + fileName;

            let pdfUrl: string | null = null;
            try {
              // Ensure bucket exists (ignore error if already exists)
              await supabase.storage.createBucket("tax-documents", { public: false });
            } catch (_) { /* bucket may already exist */ }

            const { error: uploadError } = await supabase.storage
              .from("tax-documents")
              .upload(storagePath, finalPdf, {
                contentType: "application/pdf",
                upsert: true,
              });

            if (uploadError) {
              console.warn("Storage upload failed for " + formType + ": " + uploadError.message);
            } else {
              // Create a signed URL (valid for 1 hour) instead of public URL
              const { data: signedData } = await supabase.storage
                .from("tax-documents")
                .createSignedUrl(storagePath, 3600);
              pdfUrl = signedData?.signedUrl || null;
              if (!pdfUrl) {
                // Fallback to public URL
                const { data: urlData } = supabase.storage
                  .from("tax-documents")
                  .getPublicUrl(storagePath);
                pdfUrl = urlData?.publicUrl || null;
              }
            }

            // Upload to Google Drive
            let driveUrl: string | null = null;
            let driveFileId: string | null = null;
            if (driveFolderId) {
              try {
                const driveFileName = (draft_mode ? "DRAFT_" : "") + formName.replace(/[^a-zA-Z0-9 ]/g, "") + "_" + tax_year + ".pdf";
                const driveResult = await uploadToDrive(
                  driveFolderId,
                  driveFileName,
                  finalPdf
                );
                driveUrl = driveResult.webViewLink ?? null;
                driveFileId = driveResult.fileId;
                console.log(formType + " uploaded to Drive: " + driveUrl);
              } catch (driveErr) {
                console.warn("Drive upload failed for " + formType + ": " + driveErr);
              }
            }

            // Update the form instance with results
            await updateFormInstance(supabase, instanceId, {
              status: "filled",
              pdf_url: pdfUrl || driveUrl || undefined,
              drive_file_id: driveFileId || undefined,
            });

            return {
              form_type: formType,
              form_name: formName,
              instance_id: instanceId,
              pdf_url: pdfUrl,
              drive_url: driveUrl,
              filled_fields: filledFields,
              failed_fields: failedFields,
              status: "filled",
            };
          } catch (fillErr) {
            const errMsg = fillErr instanceof Error ? fillErr.message : String(fillErr);
            console.error("Failed to fill " + formType + ": " + errMsg);

            await updateFormInstance(supabase, instanceId, {
              status: "error",
              error_message: errMsg,
            });

            return {
              form_type: formType,
              form_name: formName,
              instance_id: instanceId,
              pdf_url: null,
              drive_url: null,
              filled_fields: [],
              failed_fields: [],
              status: "error: " + errMsg,
            };
          }
        })
      );

      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        }
      }
    }

    // Update Drive folder URL on the tax return
    if (driveFolderUrl) {
      await supabase
        .from("tax_returns")
        .update({ drive_folder_url: driveFolderUrl, updated_at: new Date().toISOString() })
        .eq("id", tax_return_id);
    }

    // Audit log
    await logAudit(supabase, {
      tax_return_id,
      action: "forms_filled",
      actor: "fill-tax-forms",
      new_values: {
        forms_generated: results.map((r) => r.form_type),
        forms_with_drive: results.filter((r) => r.drive_url).map((r) => r.form_type),
        drive_folder_url: driveFolderUrl,
        draft_mode,
      },
    });

    const summary = {
      ok: true,
      tax_return_id,
      tax_year,
      forms_generated: results.length,
      drive_folder_url: driveFolderUrl,
      forms: results,
    };

    console.log("Fill complete: " + results.length + " forms generated, " + results.filter(r => r.drive_url).length + " uploaded to Drive");
    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("fill-tax-forms error: " + msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// supabase/functions/fill-tax-forms/index.ts
// Fills IRS PDF forms with computed tax data, uploads to Supabase Storage + Google Drive,
// and records each filled form in the tax_form_instances table.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { fillPdfForm, addDraftWatermark, determineRequiredForms } from "../_shared/pdfFormFill.ts";
import { uploadToDrive, getOrCreateClientTaxFolder } from "../_shared/googleDriveUpload.ts";
import { insertFormInstance, updateFormInstance, getFormTemplate, logAudit } from "../_shared/taxReturns.ts";

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

    // Determine which forms to generate
    const requiredForms = determineRequiredForms(computed_data);
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
            field_data: computed_data,
          });

          try {
            // Fill the PDF
            const { pdfBytes, filledFields, failedFields } = await fillPdfForm(
              formType, tax_year, computed_data
            );

            // Add DRAFT watermark if in draft mode
            const finalPdf = draft_mode
              ? await addDraftWatermark(pdfBytes)
              : pdfBytes;

            // Upload to Supabase Storage
            const fileName = formType + "_" + tax_year + "_" + (client_name || client_id).replace(/[^a-zA-Z0-9]/g, "_") + ".pdf";
            const storagePath = "tax-forms/" + tax_return_id + "/" + fileName;

            const { error: uploadError } = await supabase.storage
              .from("tax-documents")
              .upload(storagePath, finalPdf, {
                contentType: "application/pdf",
                upsert: true,
              });

            let pdfUrl: string | null = null;
            if (uploadError) {
              console.warn("Storage upload failed for " + formType + ": " + uploadError.message);
            } else {
              const { data: urlData } = supabase.storage
                .from("tax-documents")
                .getPublicUrl(storagePath);
              pdfUrl = urlData?.publicUrl || null;
            }

            // Upload to Google Drive
            let driveUrl: string | null = null;
            if (driveFolderId) {
              try {
                const driveResult = await uploadToDrive(
                  driveFolderId,
                  (draft_mode ? "DRAFT_" : "") + formName.replace(/[^a-zA-Z0-9 ]/g, "") + "_" + tax_year + ".pdf",
                  finalPdf
                );
                driveUrl = driveResult.webViewLink;
              } catch (driveErr) {
                console.warn("Drive upload failed for " + formType + ": " + driveErr);
              }
            }

            // Update the form instance with results
            await updateFormInstance(supabase, instanceId, {
              status: "filled",
              pdf_url: pdfUrl || driveUrl || undefined,
              drive_file_id: driveUrl ? driveUrl.split("/d/")[1]?.split("/")[0] : undefined,
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

    console.log("Fill complete: " + results.length + " forms generated");
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

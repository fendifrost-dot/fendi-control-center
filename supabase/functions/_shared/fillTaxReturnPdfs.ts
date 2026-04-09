/**
 * Fill IRS PDFs for a tax return: Supabase Storage + optional Google Drive (service account).
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { fillPdfWithMapping, flattenFormsObject, mergeClientInfoFlat } from "./pdfFormFill.ts";
import type { CoreFormType } from "./irsFormUrls.ts";
import { getTaxReturnById, upsertTaxFormInstance } from "./taxReturns.ts";
import {
  driveFilePreviewUrl,
  ensureClientTaxReturnsYearFolder,
  getDriveAccessTokenFromJson,
  upsertPdfInDriveFolder,
} from "./googleDriveUpload.ts";

const STORAGE_BUCKET = "tax-filled-pdfs";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isCoreFormType(s: string): s is CoreFormType {
  return ["f1040", "schedule_c", "schedule_se", "schedule_1", "schedule_2"].includes(s);
}

export interface FillTaxReturnPdfsOptions {
  formsToFill?: string[];
  /** Shown in audit log / console */
  auditActor?: string;
}

export interface FillTaxReturnPdfsFormResult {
  form_type: string;
  storage_path?: string;
  pdf_url?: string;
  drive_file_id?: string;
  error?: string;
}

export interface FillTaxReturnPdfsResult {
  ok: boolean;
  tax_return_id: string;
  forms: FillTaxReturnPdfsFormResult[];
  error?: string;
}

export async function fillTaxReturnPdfs(
  supabase: SupabaseClient,
  taxReturnId: string,
  options?: FillTaxReturnPdfsOptions,
): Promise<FillTaxReturnPdfsResult> {
  const auditActor = options?.auditActor ?? "fill-tax-forms";

  const taxReturn = await getTaxReturnById(supabase, taxReturnId);
  if (!taxReturn) {
    return { ok: false, tax_return_id: taxReturnId, forms: [], error: "tax_return not found" };
  }

  const computed = taxReturn.computed_data as Record<string, unknown> | null;
  if (!computed || typeof computed !== "object") {
    return { ok: false, tax_return_id: taxReturnId, forms: [], error: "tax_return has no computed_data" };
  }

  const forms = (computed.forms ?? {}) as Record<string, unknown>;
  const clientInfo = computed.client_info as Record<string, unknown> | undefined;
  let needed = (computed.forms_needed as string[] | undefined) ?? Object.keys(forms);
  if (Array.isArray(options?.formsToFill) && options!.formsToFill!.length > 0) {
    needed = needed.filter((n) => options!.formsToFill!.includes(n));
  }
  needed = needed.filter(isCoreFormType);

  const taxYear = taxReturn.tax_year as number;
  const clientId = taxReturn.client_id as string;

  const { data: clientRow } = await supabase
    .from("clients")
    .select("drive_folder_id")
    .eq("id", clientId)
    .maybeSingle();
  const clientDriveFolderId = (clientRow as { drive_folder_id: string | null } | null)?.drive_folder_id ?? null;

  const saJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") ?? "";
  let driveToken: string | null = null;
  if (saJson && clientDriveFolderId) {
    try {
      driveToken = await getDriveAccessTokenFromJson(saJson);
    } catch (e) {
      console.warn("[fillTaxReturnPdfs] Drive token failed, using storage only:", e);
    }
  }

  let driveYearFolderId: string | null = null;
  if (driveToken && clientDriveFolderId) {
    try {
      driveYearFolderId = await ensureClientTaxReturnsYearFolder(
        driveToken,
        clientDriveFolderId,
        taxYear,
      );
    } catch (e) {
      console.warn("[fillTaxReturnPdfs] Drive folder path failed:", e);
      driveToken = null;
      driveYearFolderId = null;
    }
  }

  const flatBase = mergeClientInfoFlat(clientInfo, flattenFormsObject(forms));

  async function fillOne(formType: CoreFormType): Promise<FillTaxReturnPdfsFormResult> {
    try {
      const { data: template, error: tErr } = await supabase
        .from("tax_form_templates")
        .select("id, field_mapping, irs_pdf_url")
        .eq("form_type", formType)
        .eq("tax_year", taxYear)
        .maybeSingle();

      if (tErr) throw new Error(tErr.message);
      if (!template?.irs_pdf_url) {
        return { form_type: formType, error: "no tax_form_templates row for this year/form" };
      }

      const mapping = template.field_mapping as Record<string, string>;
      if (!mapping || Object.keys(mapping).length === 0) {
        return { form_type: formType, error: "empty field_mapping for template" };
      }

      const pdfResp = await fetch(template.irs_pdf_url);
      if (!pdfResp.ok) {
        return {
          form_type: formType,
          error: `IRS PDF fetch failed ${pdfResp.status}`,
        };
      }
      const pdfBytes = new Uint8Array(await pdfResp.arrayBuffer());

      const returnStatus = (taxReturn.status as string) || "draft";
      const filled = await fillPdfWithMapping(pdfBytes, mapping, flatBase, {
        watermarkDraft: returnStatus !== "final" && returnStatus !== "filed",
      });
      const fileName = `${formType}.pdf`;
      const storagePath = `${clientId}/${taxYear}/${fileName}`;

      const { error: upErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, filled, {
          contentType: "application/pdf",
          upsert: true,
        });

      if (upErr) {
        return { form_type: formType, error: `storage upload: ${upErr.message}` };
      }

      const { data: signed, error: sErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(storagePath, 60 * 60 * 24 * 365);

      if (sErr || !signed?.signedUrl) {
        return { form_type: formType, error: sErr?.message ?? "signed URL failed" };
      }

      let pdfDriveFileId: string | null = storagePath;
      let pdfDriveUrl: string | null = signed.signedUrl;

      if (driveToken && driveYearFolderId) {
        try {
          const driveFileId = await upsertPdfInDriveFolder(driveToken, driveYearFolderId, fileName, filled);
          pdfDriveFileId = driveFileId;
          pdfDriveUrl = driveFilePreviewUrl(driveFileId);
        } catch (de) {
          console.warn(`[fillTaxReturnPdfs] Drive upload failed for ${formType}:`, de);
        }
      }

      const slice = forms[formType] as Record<string, unknown> | undefined;

      await upsertTaxFormInstance(supabase, {
        taxReturnId,
        templateId: template.id as string,
        formType,
        formYear: taxYear,
        fieldValues: flatBase,
        computedLines: (slice ?? {}) as Record<string, unknown>,
        pdfDriveFileId,
        pdfDriveUrl,
      });

      {
        const { error: auditErr } = await supabase.from("tax_return_audit_log").insert({
          tax_return_id: taxReturnId,
          action: "pdf_filled",
          actor: auditActor,
          metadata: {
            form_type: formType,
            storage_path: storagePath,
            drive_file_id: pdfDriveFileId !== storagePath ? pdfDriveFileId : undefined,
          },
        });
        if (auditErr) console.warn("[fillTaxReturnPdfs] audit:", auditErr.message);
      }

      return {
        form_type: formType,
        storage_path: storagePath,
        pdf_url: pdfDriveUrl ?? signed.signedUrl,
        drive_file_id: pdfDriveFileId !== storagePath ? pdfDriveFileId : undefined,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { form_type: formType, error: msg };
    }
  }

  const results: FillTaxReturnPdfsFormResult[] = [];
  for (const batch of chunk(needed, 3)) {
    const batchResults = await Promise.all(batch.map((f) => fillOne(f)));
    results.push(...batchResults);
  }

  return {
    ok: true,
    tax_return_id: taxReturnId,
    forms: results,
  };
}

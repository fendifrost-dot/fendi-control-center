// supabase/functions/_shared/pdfFormFill.ts
// PDF form filling for IRS tax documents using pdf-lib

import { PDFDocument, rgb, degrees, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

export { PDFDocument };

/**
 * Get the IRS.gov URL for a tax form PDF
 */
export function getIrsFormUrl(formType: string, year: number | string): string {
  const yr = Number(year);
  const currentYear = new Date().getFullYear();
  // Normalize form type: remove spaces and special chars for URL
  const formSlug = formType.toLowerCase().replace(/[^a-z0-9]/g, "");

  if (yr >= currentYear) {
    // Current year - use latest
    return `https://www.irs.gov/pub/irs-pdf/f${formSlug}.pdf`;
  } else {
    // Prior year
    return `https://www.irs.gov/pub/irs-prior/f${formSlug}--${yr}.pdf`;
  }
}

/**
 * Fetch a blank IRS form PDF.
 * Tier order:
 *   1. Supabase storage bucket "irs-forms" → `f{formSlug}--{year}.pdf`
 *   2. IRS.gov year-specific URL (prior-year pattern or current, 15s timeout)
 *   3. IRS.gov current-year URL (15s timeout)
 * Throws if all sources fail.
 */
export async function fetchIrsFormPdf(
  supabase: any,
  formType: string,
  year: number | string
): Promise<Uint8Array> {
  const yr = Number(year);
  const currentYear = new Date().getFullYear();
  const formSlug = formType.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Always store with year suffix so multiple tax years coexist in the bucket
  const storageKey = `f${formSlug}--${yr}.pdf`;

  // 1. Try Supabase storage "irs-forms" bucket
  try {
    const { data, error } = await supabase.storage.from("irs-forms").download(storageKey);
    if (!error && data) {
      console.log(`[fetchIrsFormPdf] Cache hit in storage: ${storageKey}`);
      return new Uint8Array(await (data as Blob).arrayBuffer());
    }
    console.log(`[fetchIrsFormPdf] Storage miss for ${storageKey}: ${error?.message ?? "no data"}`);
  } catch (e) {
    console.warn(`[fetchIrsFormPdf] Storage lookup error: ${e}`);
  }

  // Helper: fetch with 15s timeout
  async function fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 15000);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(tid);
    }
  }

  // 2. Try IRS.gov year-specific URL
  const primaryUrl = getIrsFormUrl(formType, yr);
  try {
    const resp = await fetchWithTimeout(primaryUrl);
    if (resp.ok) {
      console.log(`[fetchIrsFormPdf] Fetched from IRS: ${primaryUrl}`);
      return new Uint8Array(await resp.arrayBuffer());
    }
    console.warn(`[fetchIrsFormPdf] IRS primary URL failed (${resp.status}): ${primaryUrl}`);
  } catch (e) {
    console.warn(`[fetchIrsFormPdf] IRS primary URL error: ${e}`);
  }

  // 3. Try IRS.gov current-year URL (only if different from primary)
  const fallbackUrl = `https://www.irs.gov/pub/irs-pdf/f${formSlug}.pdf`;
  if (fallbackUrl !== primaryUrl) {
    try {
      const resp = await fetchWithTimeout(fallbackUrl);
      if (resp.ok) {
        console.log(`[fetchIrsFormPdf] Fetched from IRS (current-year fallback): ${fallbackUrl}`);
        return new Uint8Array(await resp.arrayBuffer());
      }
      console.error(`[fetchIrsFormPdf] IRS fallback URL also failed (${resp.status}): ${fallbackUrl}`);
    } catch (e) {
      console.error(`[fetchIrsFormPdf] IRS fallback URL error: ${e}`);
    }
  }

  throw new Error(
    `[fetchIrsFormPdf] All sources exhausted for form ${formSlug} year ${yr}. ` +
    `Tried: storage key "${storageKey}", ${primaryUrl}` +
    (fallbackUrl !== primaryUrl ? `, ${fallbackUrl}` : "") +
    `. Upload blank PDFs to the "irs-forms" storage bucket to avoid irs.gov rate limits.`
  );
}

/**
 * Determine which IRS forms are required based on computed tax data.
 * Checks both flat and nested key patterns.
 */
export function determineRequiredForms(computedData: Record<string, unknown>): string[] {
  const forms: string[] = ["1040"]; // Always need the main form

  // Helper to check if a key pattern exists in the data
  const hasKey = (patterns: string[]): boolean => {
    for (const pattern of patterns) {
      // Check flat keys
      if (computedData[pattern] !== undefined && computedData[pattern] !== null) return true;

      // Check nested keys (dot notation)
      const parts = pattern.split(".");
      let current: unknown = computedData;
      let found = true;
      for (const part of parts) {
        if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
          current = (current as Record<string, unknown>)[part];
        } else {
          found = false;
          break;
        }
      }
      if (found && current !== undefined && current !== null) return true;
    }
    return false;
  };

  // Schedule C - Business income
  if (hasKey([
    "schedule_c", "scheduleC", "schedule_c_profit", "scheduleCProfit",
    "business_income", "businessIncome", "self_employment_income",
    "form_1040.schedule_c", "form1040.scheduleC",
    "schedules.c", "schedules.schedule_c",
  ])) {
    forms.push("1040sc");
  }

  // Schedule SE - Self-employment tax
  if (hasKey([
    "schedule_se", "scheduleSE", "self_employment_tax", "selfEmploymentTax",
    "se_tax", "seTax",
    "form_1040.schedule_se", "form1040.scheduleSE",
    "schedules.se", "schedules.schedule_se",
  ])) {
    forms.push("1040sse");
  }

  // Schedule D - Capital gains
  if (hasKey([
    "schedule_d", "scheduleD", "capital_gains", "capitalGains",
    "form_1040.schedule_d", "form1040.scheduleD",
    "schedules.d", "schedules.schedule_d",
  ])) {
    forms.push("1040sd");
  }

  // Schedule E - Rental/Royalty income
  if (hasKey([
    "schedule_e", "scheduleE", "rental_income", "rentalIncome", "royalty_income",
    "form_1040.schedule_e", "form1040.scheduleE",
    "schedules.e", "schedules.schedule_e",
  ])) {
    forms.push("1040se");
  }

  // Schedule A - Itemized deductions
  if (hasKey([
    "schedule_a", "scheduleA", "itemized_deductions", "itemizedDeductions",
    "form_1040.schedule_a", "form1040.scheduleA",
    "schedules.a", "schedules.schedule_a",
  ])) {
    forms.push("1040sa");
  }

  // Schedule B - Interest and dividends
  if (hasKey([
    "schedule_b", "scheduleB", "interest_income", "dividend_income",
    "form_1040.schedule_b", "form1040.scheduleB",
    "schedules.b", "schedules.schedule_b",
  ])) {
    forms.push("1040sb");
  }

  // Schedule 1 - Additional income
  if (hasKey([
    "schedule_1", "schedule1", "additional_income", "additionalIncome",
    "form_1040.schedule_1", "form1040.schedule1",
    "schedules.1", "schedules.schedule_1",
  ])) {
    forms.push("1040s1");
  }

  // Schedule 2 - Additional taxes
  if (hasKey([
    "schedule_2", "schedule2", "additional_taxes", "additionalTaxes",
    "form_1040.schedule_2", "form1040.schedule2",
    "schedules.2", "schedules.schedule_2",
  ])) {
    forms.push("1040s2");
  }

  // Schedule 3 - Additional credits
  if (hasKey([
    "schedule_3", "schedule3", "additional_credits", "additionalCredits",
    "form_1040.schedule_3", "form1040.schedule3",
    "schedules.3", "schedules.schedule_3",
  ])) {
    forms.push("1040s3");
  }

  // If Schedule C is present, usually need Schedule SE too
  if (forms.includes("1040sc") && !forms.includes("1040sse")) {
    forms.push("1040sse");
  }

  // If Schedule C or SE, usually need Schedule 1 and 2
  if ((forms.includes("1040sc") || forms.includes("1040sse")) && !forms.includes("1040s1")) {
    forms.push("1040s1");
  }
  if (forms.includes("1040sse") && !forms.includes("1040s2")) {
    forms.push("1040s2");
  }

  return [...new Set(forms)]; // Deduplicate
}

/**
 * Fill a PDF form using AcroForm API with text overlay fallback
 */
export async function fillPdfForm(
  pdfBytes: Uint8Array,
  fieldMappings: Record<string, string>,
  values: Record<string, unknown>
): Promise<PDFDocument> {
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  let filledCount = 0;
  const failedFields: string[] = [];

  for (const [valueKey, fieldName] of Object.entries(fieldMappings)) {
    const value = values[valueKey];
    if (value === undefined || value === null || value === "") continue;

    const strValue = String(value);

    try {
      // Try AcroForm field first
      const field = fields.find((f) => f.getName() === fieldName);

      if (field) {
        try {
          const textField = form.getTextField(field.getName());
          textField.setText(strValue);
          filledCount++;
          continue;
        } catch {
          // Field might be a checkbox or other type
          try {
            const checkbox = form.getCheckBox(field.getName());
            if (strValue === "true" || strValue === "1" || strValue.toLowerCase() === "yes" || strValue.toLowerCase() === "x") {
              checkbox.check();
            } else {
              checkbox.uncheck();
            }
            filledCount++;
            continue;
          } catch {
            failedFields.push(fieldName);
          }
        }
      } else {
        failedFields.push(fieldName);
      }
    } catch (err) {
      console.error(`Error filling field "${fieldName}": ${err}`);
      failedFields.push(fieldName);
    }
  }

  console.log(`Filled ${filledCount} fields via AcroForm. ${failedFields.length} fields need text overlay fallback.`);

  // Text overlay fallback for fields that couldn't be filled via AcroForm
  if (failedFields.length > 0) {
    console.log(`Text overlay fallback fields: ${failedFields.join(", ")}`);
    // For fields we couldn't fill, add text annotations on the first page
    const pages = pdfDoc.getPages();
    if (pages.length > 0) {
      const firstPage = pages[0];
      let yOffset = 50; // Start near bottom
      for (const fieldName of failedFields) {
        // Find the original value key for this field
        const valueKey = Object.entries(fieldMappings).find(([_, v]) => v === fieldName)?.[0];
        if (!valueKey) continue;
        const value = values[valueKey];
        if (value === undefined || value === null || value === "") continue;

        // Add small text annotation
        firstPage.drawText(`${fieldName}: ${String(value)}`, {
          x: 10,
          y: yOffset,
          size: 7,
          font,
          color: rgb(0.2, 0.2, 0.2),
        });
        yOffset += 12;
      }
    }
  }

  // Flatten form fields to prevent editing
  try {
    form.flatten();
  } catch (err) {
    console.warn(`Could not flatten form: ${err}`);
  }

  return pdfDoc;
}

/**
 * Add a diagonal DRAFT watermark to all pages
 */
export async function addDraftWatermark(pdfDoc: PDFDocument): Promise<void> {
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  for (const page of pages) {
    const { width, height } = page.getSize();
    const text = "DRAFT";
    const fontSize = Math.min(width, height) * 0.15;
    const textWidth = font.widthOfTextAtSize(text, fontSize);

    page.drawText(text, {
      x: (width - textWidth) / 2,
      y: height / 2 - fontSize / 2,
      size: fontSize,
      font,
      color: rgb(0.85, 0.85, 0.85),
      rotate: degrees(45),
      opacity: 0.35,
    });
  }
}

/**
 * Inspect and list all form fields in a PDF
 */
export async function inspectPdfFields(pdfBytes: Uint8Array): Promise<Array<{ name: string; type: string }>> {
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const form = pdfDoc.getForm();
  const fields = form.getFields();

  return fields.map((field) => ({
    name: field.getName(),
    type: field.constructor.name,
  }));
}

/** Flatten nested objects to dotted keys (e.g. forms.f1040.line1). */
function flattenDotted(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenDotted(value as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

/** Nested `forms` object from computed_data → flat keys for AcroForm mapping (value paths). */
export function flattenFormsObject(forms: Record<string, unknown>): Record<string, unknown> {
  return flattenDotted(forms, "forms");
}

/** Merge client_info.* and forms.* into one flat lookup map for PDF filling. */
export function mergeClientInfoFlat(
  clientInfo: Record<string, unknown> | undefined,
  formsFlat: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...formsFlat };
  if (clientInfo && typeof clientInfo === "object") {
    Object.assign(out, flattenDotted(clientInfo, "client_info"));
  }
  return out;
}

/** DB templates store PDF field name → data path; fillPdfForm expects data path → PDF field name. */
function invertPdfFieldMapping(mapping: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [pdfField, dataPath] of Object.entries(mapping)) {
    out[dataPath] = pdfField;
  }
  return out;
}

/**
 * Fill PDF using template `field_mapping`, apply optional DRAFT watermark, return saved bytes.
 */
export async function fillPdfWithMapping(
  pdfBytes: Uint8Array,
  mapping: Record<string, string>,
  flatBase: Record<string, unknown>,
  opts?: { watermarkDraft?: boolean },
): Promise<Uint8Array> {
  const inverted = invertPdfFieldMapping(mapping);
  const doc = await fillPdfForm(pdfBytes, inverted, flatBase);
  if (opts?.watermarkDraft) {
    await addDraftWatermark(doc);
  }
  return await doc.save();
}

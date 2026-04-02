// supabase/functions/_shared/pdfFormFill.ts
// Fills IRS PDF forms using pdf-lib. Downloads blank forms from IRS.gov,
// maps computed tax data to form field names, and returns filled PDF bytes.

import { PDFDocument, rgb, StandardFonts, degrees } from "https://esm.sh/pdf-lib@1.17.1";

// IRS PDF URLs (prior-year so forms stay stable)
const IRS_PDF_URLS: Record<string, string> = {
  "1040_2024": "https://www.irs.gov/pub/irs-prior/f1040--2024.pdf",
  "1040_2023": "https://www.irs.gov/pub/irs-prior/f1040--2023.pdf",
  "1040_2022": "https://www.irs.gov/pub/irs-prior/f1040--2022.pdf",
  "schedule_c_2024": "https://www.irs.gov/pub/irs-prior/f1040sc--2024.pdf",
  "schedule_c_2023": "https://www.irs.gov/pub/irs-prior/f1040sc--2023.pdf",
  "schedule_c_2022": "https://www.irs.gov/pub/irs-prior/f1040sc--2022.pdf",
  "schedule_se_2024": "https://www.irs.gov/pub/irs-prior/f1040sse--2024.pdf",
  "schedule_se_2023": "https://www.irs.gov/pub/irs-prior/f1040sse--2023.pdf",
  "schedule_se_2022": "https://www.irs.gov/pub/irs-prior/f1040sse--2022.pdf",
};

const pdfCache = new Map<string, Uint8Array>();

export interface FieldMapping {
  pdfField: string;
  dataKey: string;
  format?: "currency" | "integer" | "text" | "ssn" | "ein" | "checkbox";
  fallbackX?: number;
  fallbackY?: number;
  fallbackPage?: number;
}

// Form 1040 field mappings
export const FORM_1040_FIELDS: FieldMapping[] = [
  { pdfField: "topmostSubform[0].Page1[0].f1_02[0]", dataKey: "first_name", format: "text" },
  { pdfField: "topmostSubform[0].Page1[0].f1_03[0]", dataKey: "last_name", format: "text" },
  { pdfField: "topmostSubform[0].Page1[0].f1_04[0]", dataKey: "ssn", format: "ssn" },
  { pdfField: "topmostSubform[0].Page1[0].f1_07[0]", dataKey: "wages_salaries", format: "currency", fallbackX: 530, fallbackY: 420, fallbackPage: 0 },
  { pdfField: "topmostSubform[0].Page1[0].Line9[0].f1_10[0]", dataKey: "total_income", format: "currency", fallbackX: 530, fallbackY: 350, fallbackPage: 0 },
  { pdfField: "topmostSubform[0].Page1[0].f1_13[0]", dataKey: "adjusted_gross_income", format: "currency", fallbackX: 530, fallbackY: 290, fallbackPage: 0 },
  { pdfField: "topmostSubform[0].Page2[0].f2_02[0]", dataKey: "standard_deduction", format: "currency", fallbackX: 530, fallbackY: 660, fallbackPage: 1 },
  { pdfField: "topmostSubform[0].Page2[0].f2_04[0]", dataKey: "taxable_income", format: "currency", fallbackX: 530, fallbackY: 620, fallbackPage: 1 },
  { pdfField: "topmostSubform[0].Page2[0].f2_06[0]", dataKey: "total_tax", format: "currency", fallbackX: 530, fallbackY: 500, fallbackPage: 1 },
  { pdfField: "topmostSubform[0].Page2[0].f2_13[0]", dataKey: "total_payments", format: "currency", fallbackX: 530, fallbackY: 340, fallbackPage: 1 },
  { pdfField: "topmostSubform[0].Page2[0].f2_14[0]", dataKey: "amount_owed", format: "currency", fallbackX: 530, fallbackY: 280, fallbackPage: 1 },
  { pdfField: "topmostSubform[0].Page2[0].f2_15[0]", dataKey: "refund_amount", format: "currency", fallbackX: 530, fallbackY: 240, fallbackPage: 1 },
];

// Schedule C field mappings
export const SCHEDULE_C_FIELDS: FieldMapping[] = [
  { pdfField: "topmostSubform[0].Page1[0].f1_01[0]", dataKey: "proprietor_name", format: "text" },
  { pdfField: "topmostSubform[0].Page1[0].f1_02[0]", dataKey: "ssn", format: "ssn" },
  { pdfField: "topmostSubform[0].Page1[0].f1_03[0]", dataKey: "business_name", format: "text" },
  { pdfField: "topmostSubform[0].Page1[0].f1_05[0]", dataKey: "business_code", format: "text" },
  { pdfField: "topmostSubform[0].Page1[0].f1_07[0]", dataKey: "gross_receipts", format: "currency", fallbackX: 530, fallbackY: 498, fallbackPage: 0 },
  { pdfField: "topmostSubform[0].Page1[0].f1_09[0]", dataKey: "gross_income", format: "currency", fallbackX: 530, fallbackY: 458, fallbackPage: 0 },
  { pdfField: "topmostSubform[0].Page1[0].f1_10[0]", dataKey: "advertising", format: "currency" },
  { pdfField: "topmostSubform[0].Page1[0].f1_12[0]", dataKey: "car_truck_expenses", format: "currency" },
  { pdfField: "topmostSubform[0].Page1[0].f1_15[0]", dataKey: "insurance", format: "currency" },
  { pdfField: "topmostSubform[0].Page1[0].f1_18[0]", dataKey: "office_expense", format: "currency" },
  { pdfField: "topmostSubform[0].Page1[0].f1_24[0]", dataKey: "supplies", format: "currency" },
  { pdfField: "topmostSubform[0].Page1[0].f1_28[0]", dataKey: "total_expenses", format: "currency", fallbackX: 530, fallbackY: 126, fallbackPage: 0 },
  { pdfField: "topmostSubform[0].Page1[0].f1_29[0]", dataKey: "net_profit_or_loss", format: "currency", fallbackX: 530, fallbackY: 106, fallbackPage: 0 },
];

// Schedule SE field mappings
export const SCHEDULE_SE_FIELDS: FieldMapping[] = [
  { pdfField: "topmostSubform[0].Page1[0].f1_01[0]", dataKey: "proprietor_name", format: "text" },
  { pdfField: "topmostSubform[0].Page1[0].f1_02[0]", dataKey: "ssn", format: "ssn" },
  { pdfField: "topmostSubform[0].Page1[0].Section1Short[0].f1_03[0]", dataKey: "net_earnings", format: "currency", fallbackX: 530, fallbackY: 478, fallbackPage: 0 },
  { pdfField: "topmostSubform[0].Page1[0].Section1Short[0].f1_04[0]", dataKey: "se_tax_multiplied", format: "currency", fallbackX: 530, fallbackY: 450, fallbackPage: 0 },
  { pdfField: "topmostSubform[0].Page1[0].Section1Short[0].f1_05[0]", dataKey: "self_employment_tax", format: "currency", fallbackX: 530, fallbackY: 420, fallbackPage: 0 },
  { pdfField: "topmostSubform[0].Page1[0].Section1Short[0].f1_06[0]", dataKey: "deductible_half_se", format: "currency", fallbackX: 530, fallbackY: 392, fallbackPage: 0 },
];

export const FIELD_MAPPINGS: Record<string, FieldMapping[]> = {
  "1040": FORM_1040_FIELDS,
  "schedule_c": SCHEDULE_C_FIELDS,
  "schedule_se": SCHEDULE_SE_FIELDS,
};

async function downloadBlankPdf(formType: string, formYear: number): Promise<Uint8Array> {
  const cacheKey = formType + "_" + formYear;
  if (pdfCache.has(cacheKey)) return pdfCache.get(cacheKey)!;
  const url = IRS_PDF_URLS[cacheKey];
  if (!url) throw new Error("No IRS PDF URL configured for " + formType + " year " + formYear);
  console.log("Downloading blank PDF: " + url);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Failed to download IRS PDF (" + resp.status + "): " + url);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  pdfCache.set(cacheKey, bytes);
  return bytes;
}

function formatValue(value: unknown, format?: string): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  switch (format) {
    case "currency": {
      const num = parseFloat(str);
      if (isNaN(num)) return str;
      return num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }
    case "integer": return String(Math.round(parseFloat(str) || 0));
    case "ssn": return str.replace(/^(\d{3})(\d{2})(\d{4})$/, "$1-$2-$3");
    case "ein": return str.replace(/^(\d{2})(\d{7})$/, "$1-$2");
    default: return str;
  }
}

/**
 * Fill an IRS PDF form with computed tax data.
 * Strategy: Try AcroForm field filling first, fall back to text overlay.
 */
export async function fillPdfForm(
  formType: string,
  formYear: number,
  computedData: Record<string, unknown>,
  customFieldMappings?: FieldMapping[]
): Promise<{ pdfBytes: Uint8Array; filledFields: string[]; failedFields: string[] }> {
  const blankBytes = await downloadBlankPdf(formType, formYear);
  const pdfDoc = await PDFDocument.load(blankBytes, { ignoreEncryption: true });
  const fieldMappings = customFieldMappings || FIELD_MAPPINGS[formType] || [];
  const filledFields: string[] = [];
  const failedFields: string[] = [];

  let form: any = null;
  try { form = pdfDoc.getForm(); } catch (e) {
    console.warn("No AcroForm found in " + formType + " " + formYear + ", using text overlay only");
  }
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (const mapping of fieldMappings) {
    const value = computedData[mapping.dataKey];
    if (value === null || value === undefined || value === "") continue;
    const formatted = formatValue(value, mapping.format);
    let filled = false;

    if (form) {
      try {
        const field = form.getTextField(mapping.pdfField);
        field.setText(formatted);
        filled = true;
        filledFields.push(mapping.dataKey);
      } catch (_) {
        if (mapping.format === "checkbox") {
          try { const cb = form.getCheckBox(mapping.pdfField); if (value) cb.check(); filled = true; filledFields.push(mapping.dataKey); } catch (_) {}
        }
      }
    }

    if (!filled && mapping.fallbackX !== undefined && mapping.fallbackY !== undefined) {
      const pageIdx = mapping.fallbackPage ?? 0;
      const pages = pdfDoc.getPages();
      if (pageIdx < pages.length) {
        pages[pageIdx].drawText(formatted, { x: mapping.fallbackX, y: mapping.fallbackY, size: 10, font, color: rgb(0, 0, 0) });
        filled = true;
        filledFields.push(mapping.dataKey + " (overlay)");
      }
    }
    if (!filled) failedFields.push(mapping.dataKey);
  }

  if (form) { try { form.flatten(); } catch (e) { console.warn("Could not flatten form:", e); } }
  const pdfBytes = await pdfDoc.save();
  return { pdfBytes: new Uint8Array(pdfBytes), filledFields, failedFields };
}

/** Add a DRAFT watermark to every page of a PDF. */
export async function addDraftWatermark(pdfBytes: Uint8Array): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();
    page.drawText("DRAFT - NOT FOR FILING", {
      x: width / 2 - 180, y: height / 2 - 20, size: 40, font,
      color: rgb(0.9, 0.1, 0.1), opacity: 0.25, rotate: degrees(45),
    });
  }
  return new Uint8Array(await pdfDoc.save());
}

/** Inspect a PDF and return all AcroForm field names. */
export async function inspectPdfFields(formType: string, formYear: number): Promise<{ name: string; type: string }[]> {
  const blankBytes = await downloadBlankPdf(formType, formYear);
  const pdfDoc = await PDFDocument.load(blankBytes, { ignoreEncryption: true });
  try {
    const form = pdfDoc.getForm();
    return form.getFields().map((field: any) => ({ name: field.getName(), type: field.constructor.name }));
  } catch (e) {
    return [{ name: "ERROR", type: "Could not read form: " + e }];
  }
}

/** Determine which forms are needed for a given tax return. */
export function determineRequiredForms(computedData: Record<string, unknown>): string[] {
  const forms = ["1040"];
  if (computedData.gross_receipts || computedData.net_profit_or_loss || computedData.business_name) forms.push("schedule_c");
  const netEarnings = Number(computedData.net_earnings || computedData.net_profit_or_loss || 0);
  if (netEarnings > 400) forms.push("schedule_se");
  return forms;
}

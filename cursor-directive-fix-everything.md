# Cursor Directive: Fix All Tax Pipeline Issues

## Pre-flight
```bash
cd ~/fendi-control-center
rm -f .git/index.lock .git/HEAD.lock
git checkout main
git pull origin main
```

## Context
The tax pipeline can now write DB rows (upsertTaxReturn works). fill-tax-forms works when called directly via Lovable. But the end-to-end Telegram flow still doesn't produce PDFs, and the PDFs themselves only fill ~17% of fields. This directive fixes EVERYTHING.

---

## Issue 1: fill-tax-forms not triggered from generate-tax-documents pipeline

**File:** `supabase/functions/generate-tax-documents/index.ts`

The `runPdfFill()` function calls fill-tax-forms via HTTP. It passes `pdfBody` which includes `computed_data: summary` (the json_summary). But the call may be failing silently because:

- The timing logs we added should show if this step runs. Check if `[generate] PDF+TXF took Xms` appears in logs.
- If it doesn't appear, the function is timing out before reaching the PDF step.
- **Fix:** Move `runPdfFill()` call to AFTER the response is returned. Use `EdgeRuntime.waitUntil()` for just the PDF/TXF step (not the whole pipeline). The DB write is the critical path; PDFs can be background work.

```typescript
// After upsert succeeds and response is built, kick off PDFs in background
const bgPdfWork = Promise.all([runPdfFill(), runTxfExport(...)]);
if (typeof (globalThis as any).EdgeRuntime?.waitUntil === "function") {
  (globalThis as any).EdgeRuntime.waitUntil(bgPdfWork);
} else {
  // Fallback: don't await, just fire and forget
  bgPdfWork.catch(e => console.error("[generate] background PDF/TXF error:", e));
}

// Return response immediately with pdf_txf_status: "generating_in_background"
```

This way the DB write + response happens fast, and PDFs generate asynchronously.

---

## Issue 2: Only 17 of ~100+ Form 1040 fields mapped

**File:** `supabase/functions/fill-tax-forms/index.ts` (lines 65-101)

The FIELD_MAPS object for form 1040 only has 17 entries. The 2022 Form 1040 has approximately 100+ fillable fields. Expand the mapping to cover all critical lines.

**Required 1040 field additions** (2022 form field names follow the pattern `topmostSubform[0].PageN[0].fN_XX[0]`):

Add these mappings to the `"1040"` section:

```typescript
"1040": {
  // Page 1 - Personal Info
  first_name: "topmostSubform[0].Page1[0].f1_02[0]",
  last_name: "topmostSubform[0].Page1[0].f1_03[0]",
  ssn: "topmostSubform[0].Page1[0].f1_04[0]",
  spouse_first_name: "topmostSubform[0].Page1[0].f1_05[0]",
  spouse_last_name: "topmostSubform[0].Page1[0].f1_06[0]",
  spouse_ssn: "topmostSubform[0].Page1[0].f1_07[0]",
  address: "topmostSubform[0].Page1[0].f1_08[0]",
  apt_no: "topmostSubform[0].Page1[0].f1_09[0]",
  city_state_zip: "topmostSubform[0].Page1[0].f1_10[0]",
  
  // Filing Status checkboxes (c1_1 through c1_5)
  filing_status_single: "topmostSubform[0].Page1[0].c1_1[0]",
  filing_status_mfj: "topmostSubform[0].Page1[0].c1_2[0]",
  filing_status_mfs: "topmostSubform[0].Page1[0].c1_3[0]",
  filing_status_hoh: "topmostSubform[0].Page1[0].c1_4[0]",
  filing_status_qw: "topmostSubform[0].Page1[0].c1_5[0]",
  
  // Income lines
  wages: "topmostSubform[0].Page1[0].Line1[0].f1_11[0]",        // Line 1
  tax_exempt_interest: "topmostSubform[0].Page1[0].f1_13[0]",    // Line 2a
  taxable_interest: "topmostSubform[0].Page1[0].f1_14[0]",       // Line 2b
  qualified_dividends: "topmostSubform[0].Page1[0].f1_15[0]",    // Line 3a
  ordinary_dividends: "topmostSubform[0].Page1[0].f1_16[0]",     // Line 3b
  ira_distributions: "topmostSubform[0].Page1[0].f1_17[0]",      // Line 4a
  ira_taxable: "topmostSubform[0].Page1[0].f1_18[0]",            // Line 4b
  pensions: "topmostSubform[0].Page1[0].f1_19[0]",               // Line 5a
  pensions_taxable: "topmostSubform[0].Page1[0].f1_20[0]",       // Line 5b
  social_security: "topmostSubform[0].Page1[0].f1_21[0]",        // Line 6a
  social_security_taxable: "topmostSubform[0].Page1[0].f1_22[0]",// Line 6b
  capital_gain_loss: "topmostSubform[0].Page1[0].f1_23[0]",      // Line 7
  other_income: "topmostSubform[0].Page1[0].f1_24[0]",           // Line 8
  total_income: "topmostSubform[0].Page1[0].f1_25[0]",           // Line 9
  adjustments: "topmostSubform[0].Page1[0].f1_26[0]",            // Line 10
  adjusted_gross_income: "topmostSubform[0].Page1[0].f1_27[0]",  // Line 11
  
  // Page 2 - Deductions & Tax
  standard_deduction: "topmostSubform[0].Page2[0].f2_01[0]",     // Line 12
  qualified_business_deduction: "topmostSubform[0].Page2[0].f2_02[0]", // Line 13
  total_deductions: "topmostSubform[0].Page2[0].f2_03[0]",       // Line 14
  taxable_income: "topmostSubform[0].Page2[0].f2_04[0]",         // Line 15
  tax: "topmostSubform[0].Page2[0].f2_06[0]",                    // Line 16
  schedule_2_line_21: "topmostSubform[0].Page2[0].f2_07[0]",     // Line 17 (from Sch 2)
  total_before_credits: "topmostSubform[0].Page2[0].f2_08[0]",   // Line 18
  child_tax_credit: "topmostSubform[0].Page2[0].f2_09[0]",       // Line 19
  schedule_3_line_8: "topmostSubform[0].Page2[0].f2_10[0]",      // Line 20
  total_credits: "topmostSubform[0].Page2[0].f2_11[0]",          // Line 21
  tax_minus_credits: "topmostSubform[0].Page2[0].f2_12[0]",      // Line 22
  other_taxes: "topmostSubform[0].Page2[0].f2_13[0]",            // Line 23
  total_tax: "topmostSubform[0].Page2[0].f2_14[0]",              // Line 24
  
  // Payments
  federal_withholding: "topmostSubform[0].Page2[0].f2_15[0]",    // Line 25
  estimated_payments: "topmostSubform[0].Page2[0].f2_16[0]",     // Line 26
  earned_income_credit: "topmostSubform[0].Page2[0].f2_17[0]",   // Line 27
  total_payments: "topmostSubform[0].Page2[0].f2_18[0]",         // Line 33
  
  // Refund/Amount Owed
  overpaid: "topmostSubform[0].Page2[0].f2_19[0]",               // Line 34
  refund: "topmostSubform[0].Page2[0].f2_20[0]",                 // Line 35a
  amount_owed: "topmostSubform[0].Page2[0].f2_24[0]",            // Line 37
}
```

**IMPORTANT:** These field names are APPROXIMATE based on typical IRS PDF structure. You MUST verify them by:
1. Download the blank f1040--2022.pdf from the irs-forms Supabase bucket
2. Use `pip install pypdf` then extract actual field names:
```python
from pypdf import PdfReader
reader = PdfReader("/tmp/f1040--2022.pdf")
fields = reader.get_fields()
for name, field in sorted(fields.items()):
    print(f"{name}: {field.get('/V', '')}")
```
3. Match the verified field names to the mappings above
4. Fix any mismatches

---

## Issue 3: Schedules 1 & 2 have zero field mappings

**File:** `supabase/functions/fill-tax-forms/index.ts`

Add field mappings for Schedule 1 (1040s1) and Schedule 2 (1040s2). Again, verify against actual PDF field names.

**Schedule 1 (Additional Income and Adjustments):**
```typescript
"1040s1": {
  // Part I - Additional Income
  taxable_refunds: field_name_line_1,
  alimony_received: field_name_line_2a,
  business_income: field_name_line_3,      // From Schedule C
  capital_gain_loss: field_name_line_4,
  rental_income: field_name_line_5,
  other_income: field_name_line_8z,
  total_additional_income: field_name_line_9,
  
  // Part II - Adjustments
  educator_expenses: field_name_line_11,
  self_employment_tax_deduction: field_name_line_15,  // 1/2 of SE tax
  self_employed_health_insurance: field_name_line_17,
  ira_deduction: field_name_line_20,
  student_loan_interest: field_name_line_21,
  total_adjustments: field_name_line_25,
}
```

**Schedule 2 (Additional Taxes):**
```typescript
"1040s2": {
  self_employment_tax: field_name_line_4,  // From Schedule SE
  total_schedule_2: field_name_line_21,
}
```

---

## Issue 4: Filing status = "unknown"

**File:** `supabase/functions/generate-tax-documents/index.ts`

The Claude analysis prompt doesn't explicitly ask for filing status. Add to the system prompt or user prompt:

```
REQUIRED in json_summary.form_1040:
- filing_status: must be one of "single", "married_filing_jointly", "married_filing_separately", "head_of_household", "qualifying_widow"
- If not determinable from documents, default to "single" for individual filers
```

Also in `fill-tax-forms/index.ts`, map filing_status string to the correct checkbox:
```typescript
// Before filling, convert filing_status to checkbox
if (flatData.filing_status) {
  const status = String(flatData.filing_status).toLowerCase();
  if (status.includes("single")) flatData.filing_status_single = "1";
  else if (status.includes("joint")) flatData.filing_status_mfj = "1";
  else if (status.includes("separate")) flatData.filing_status_mfs = "1";
  else if (status.includes("head")) flatData.filing_status_hoh = "1";
  else if (status.includes("widow")) flatData.filing_status_qw = "1";
  else flatData.filing_status_single = "1"; // default
}
```

---

## Issue 5: Tax calculation discrepancy ($24,184 vs $28,500)

**File:** `supabase/functions/generate-tax-documents/index.ts`

The json_summary has `estimated_tax_liability: $28,500` but the DB field `total_tax` shows `$24,184.49`. This happens because Claude estimates roughly while the DB might be using a different field.

**Fix:** Add a tax calculation validation step after Claude returns:
```typescript
// Validate tax math
const income = Number(form1040.total_income) || 0;
const deductions = Number(form1040.standard_deduction) || 12950; // 2022 standard
const taxableIncome = income - deductions;

// 2022 tax brackets (single)
function calculate2022Tax(taxable: number): number {
  if (taxable <= 10275) return taxable * 0.10;
  if (taxable <= 41775) return 1027.5 + (taxable - 10275) * 0.12;
  if (taxable <= 89075) return 4807.5 + (taxable - 41775) * 0.22;
  if (taxable <= 170050) return 15213.5 + (taxable - 89075) * 0.24;
  if (taxable <= 215950) return 34647.5 + (taxable - 170050) * 0.32;
  if (taxable <= 539900) return 49335.5 + (taxable - 215950) * 0.35;
  return 162718 + (taxable - 539900) * 0.37;
}

const calculatedTax = calculate2022Tax(taxableIncome);
const seTax = Number(form1040.self_employment_tax) || 0;
const totalTax = calculatedTax + seTax;

// Override Claude's estimate with calculated value
form1040.tax = Math.round(calculatedTax * 100) / 100;
form1040.total_tax = Math.round(totalTax * 100) / 100;
```

For Sam Higgins: $161,229.90 - $12,950 = $148,279.90 taxable.
Tax = $15,213.50 + ($148,279.90 - $89,075) × 0.24 = $15,213.50 + $14,209.18 = $29,422.68
Plus SE tax ($22,777 × 0.5 deductible, so recalc needed).

---

## Issue 6: Analyzed data empty on frontend

**File:** `supabase/functions/generate-tax-documents/index.ts`

After `upsertTaxReturn()` succeeds, also write the json_summary to a field the frontend reads. Check what field `YearWorkspacePage.tsx` reads for the "Analyzed data" tab.

```typescript
// After upsert, also update the client-year analyzed_data
await supabase
  .from("tax_returns")
  .update({ analyzed_data: summary })
  .eq("id", taxReturnId);
```

If the frontend reads from a different table (like `client_documents` or `analyzed_data`), write there too.

---

## Issue 7: field_data not saved

**File:** `supabase/functions/fill-tax-forms/index.ts`

When inserting into `tax_form_instances`, the `notes` field gets a string but `field_data` (if it exists) gets `{}`. Save the actual data:

```typescript
// When inserting form instance, include the data that was used to fill
await supabase.from("tax_form_instances").insert({
  tax_return_id,
  form_type: formSlug,
  form_year: taxYear,
  status: "draft",
  pdf_url: storagePath,
  drive_file_id: driveFileId || null,
  field_data: flatData,  // Save what was actually filled
  notes: `Filled ${filledCount} fields. ${driveLink || ""}`,
});
```

---

## Issue 8: Drive upload 401

**File:** Check Lovable secrets for `GOOGLE_SERVICE_ACCOUNT_JSON`

The service account key may be expired or the Drive folder permissions changed. Quick check:
1. In Lovable secrets, is GOOGLE_SERVICE_ACCOUNT_JSON set?
2. Is the service account email (fendi-tax-drive@empyrean-caster-488501-u4.iam.gserviceaccount.com) still shared on the TAXES Drive folder?
3. Test with a simple Drive API call to verify auth works

This is lower priority — PDFs save to Supabase storage regardless.

---

## Commit Strategy

1. **Commit 1:** Field mappings expansion (Issues 2, 3, 4) — verify field names first
2. **Commit 2:** Tax calculation validation (Issue 5)
3. **Commit 3:** Pipeline fixes (Issues 1, 6, 7) — background PDFs, analyzed_data, field_data
4. **Commit 4:** Drive auth fix (Issue 8) — if time permits

Push each commit to origin/main immediately. Then Lovable deploy.

---

## Testing After All Fixes

```
Telegram: Generate Sam Higgins tax return for 2022
```

Physical verification via Lovable SQL:
```sql
-- New return should exist with updated_at today
SELECT id, agi, total_tax, filing_status, updated_at FROM tax_returns 
WHERE client_name = 'Sam Higgins' AND tax_year = 2022 ORDER BY updated_at DESC LIMIT 1;

-- Form instances should exist with field_data populated
SELECT form_type, status, field_data, notes FROM tax_form_instances 
WHERE tax_return_id = 'bf3b85bb-c470-4192-9bf0-326dbe1507ec' ORDER BY created_at DESC;

-- PDFs should be in storage
SELECT name, created_at FROM storage.objects 
WHERE bucket_id = 'tax-documents' AND name LIKE '%bf3b85bb%' ORDER BY created_at DESC;
```

Then download and visually inspect the 1040 PDF to verify fields are filled correctly.

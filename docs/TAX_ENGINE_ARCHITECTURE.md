# Fendi Tax Engine — Full Architecture Blueprint

> **Status:** Approved for implementation
> **Date:** April 2, 2026
> **Scope:** Transform the current text-summary tax generator into a full IRS form-filling tax preparation engine

---

## Executive Summary

The current tax generator produces a one-shot text summary sent to Telegram chat with zero persistence — no saved clients, no filled IRS forms, no editable returns, no PDFs. This blueprint redesigns the system into a professional tax preparation engine comparable to TurboTax or H&R Block: actual IRS forms downloaded from irs.gov, programmatically filled as PDFs, saved per client in Google Drive, with full edit/regenerate capability via both Telegram and a web dashboard.

---

## Current State (What Exists Today)

### What Works
- Claude API computes Form 1040 line items, Schedule C (self-employment), Schedule SE, filing readiness scores, and deduction analysis
- CC Tax external API provides raw financial data (transactions, P&L, documents, reconciliations) per tax year
- Google Drive integration exists for syncing client folders and ingesting documents
- Clients table in Supabase stores client name + Drive folder ID
- Telegram webhook routes natural language to workflows

### What's Missing
- No `tax_returns` database table — nothing is saved after generation
- No IRS PDF form filling — only text summaries
- No Google Drive upload for completed returns
- No way to retrieve or edit a previously generated return
- No web dashboard for tax management
- No client-return relationship tracking

---

## Target Architecture

### System Flow (End to End)

```
User Request (Telegram or Web)
        │
        ▼
┌─────────────────────┐
│  Intent Router       │  Telegram: creditIntent / taxIntent regex
│  (webhook or web)    │  Web: direct API call from dashboard
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Tax Return Manager  │  Creates or loads tax_return record
│  (new edge function) │  Checks for existing return (client + year)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  CC Tax Data Fetch   │  Pulls raw financial data from CC Tax API
│  (existing)          │  7 parallel requests per year
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Claude Tax Compute  │  Computes all form line values
│  (enhanced prompt)   │  Returns structured JSON per form
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Persist to DB       │  Saves input_data + computed_data
│  (NEW)               │  to tax_returns + tax_form_instances
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  PDF Form Filler     │  Downloads IRS PDFs from irs.gov
│  (NEW edge function) │  Maps computed values → form fields
│                      │  Fills PDFs using pdf-lib (Deno)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Google Drive Upload │  Uploads filled PDFs to client folder
│  (NEW)               │  Organizes: /ClientName/Tax Returns/2024/
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Response            │  Telegram: summary + Drive links
│                      │  Web: renders in dashboard with PDF viewer
└─────────────────────┘
```

---

## Database Schema

### New Tables

#### `tax_returns` — One record per client per tax year

```sql
CREATE TABLE public.tax_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  tax_year integer NOT NULL CHECK (tax_year >= 2020 AND tax_year <= 2030),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','final','filed')),
  filing_status text CHECK (filing_status IN ('single','married_joint','married_separate','head_of_household','qualifying_surviving_spouse')),
  input_data jsonb DEFAULT '{}'::jsonb,
  computed_data jsonb DEFAULT '{}'::jsonb,
  filing_readiness_score integer DEFAULT 0,
  missing_items jsonb DEFAULT '[]'::jsonb,
  agi numeric(12,2),
  total_tax numeric(12,2),
  refund_or_owed numeric(12,2),
  drive_folder_id text,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  created_by text,
  version integer DEFAULT 1,
  UNIQUE(client_id, tax_year)
);
```

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid (PK) | Auto-generated |
| `client_id` | uuid (FK → clients) | Which client |
| `tax_year` | integer | 2022, 2023, 2024, 2025 |
| `status` | text | draft, review, final, filed |
| `filing_status` | text | single, married_joint, married_separate, head_of_household |
| `input_data` | jsonb | Raw financial data from CC Tax API |
| `computed_data` | jsonb | Claude's computed form values (all lines) |
| `filing_readiness_score` | integer | 0-100 |
| `missing_items` | jsonb | Array of missing documents/info |
| `agi` | numeric | Adjusted Gross Income |
| `total_tax` | numeric | Total tax liability |
| `refund_or_owed` | numeric | Positive = refund, negative = owed |
| `drive_folder_id` | text | Google Drive folder for this return's PDFs |
| `notes` | text | Preparer notes |
| `version` | integer | Increments on each regeneration |

#### `tax_form_instances` — Individual filled forms within a return

```sql
CREATE TABLE public.tax_form_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_return_id uuid NOT NULL REFERENCES public.tax_returns(id) ON DELETE CASCADE,
  form_type text NOT NULL,
  form_year integer NOT NULL,
  field_values jsonb DEFAULT '{}'::jsonb,
  computed_lines jsonb DEFAULT '{}'::jsonb,
  pdf_drive_file_id text,
  pdf_drive_url text,
  status text DEFAULT 'generated' CHECK (status IN ('generated','reviewed','signed')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
```

| Column | Type | Description |
|--------|------|-------------|
| `tax_return_id` | uuid (FK → tax_returns) | Parent return |
| `form_type` | text | f1040, schedule_c, schedule_se, schedule_1, etc. |
| `form_year` | integer | IRS form version year |
| `field_values` | jsonb | Map of IRS field IDs → filled values |
| `computed_lines` | jsonb | Line-by-line breakdown with descriptions |
| `pdf_drive_file_id` | text | Google Drive file ID of filled PDF |
| `pdf_drive_url` | text | Direct Drive URL for the PDF |
| `status` | text | generated, reviewed, signed |

#### `tax_form_templates` — IRS form metadata (field mappings)

```sql
CREATE TABLE public.tax_form_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_type text NOT NULL,
  tax_year integer NOT NULL,
  irs_pdf_url text NOT NULL,
  field_mapping jsonb DEFAULT '{}'::jsonb,
  field_metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE(form_type, tax_year)
);
```

| Column | Type | Description |
|--------|------|-------------|
| `form_type` | text | f1040, schedule_c, etc. |
| `tax_year` | integer | Which year's version |
| `irs_pdf_url` | text | Download URL from irs.gov |
| `field_mapping` | jsonb | Maps our computed field names → IRS PDF field IDs |
| `field_metadata` | jsonb | Field types, validation rules, descriptions |

### Indexes

```sql
CREATE INDEX idx_tax_returns_client ON public.tax_returns(client_id);
CREATE INDEX idx_tax_returns_year ON public.tax_returns(tax_year);
CREATE INDEX idx_tax_returns_status ON public.tax_returns(status);
CREATE INDEX idx_tax_form_instances_return ON public.tax_form_instances(tax_return_id);
CREATE INDEX idx_tax_form_templates_lookup ON public.tax_form_templates(form_type, tax_year);

ALTER TABLE public.tax_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_form_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_form_templates ENABLE ROW LEVEL SECURITY;
```

---

## IRS Form Library

### Forms Required (Full Suite)

| Form | Name | When Required |
|------|------|---------------|
| **1040** | U.S. Individual Income Tax Return | Always (main return) |
| **Schedule 1** | Additional Income and Adjustments | SE tax deduction, other income |
| **Schedule 2** | Additional Taxes | Self-employment tax, AMT |
| **Schedule 3** | Additional Credits and Payments | Estimated tax payments |
| **Schedule A** | Itemized Deductions | If itemizing instead of standard |
| **Schedule B** | Interest and Dividends | If > $1,500 interest/dividends |
| **Schedule C** | Profit or Loss from Business | Self-employed / sole proprietor |
| **Schedule D** | Capital Gains and Losses | Stock/asset sales |
| **Schedule E** | Supplemental Income | Rental, royalties, partnerships |
| **Schedule SE** | Self-Employment Tax | If SE net earnings ≥ $400 |
| **Form 8812** | Credits for Qualifying Children | Child Tax Credit |
| **Form 8959** | Additional Medicare Tax | High earners (> $200k) |
| **Form 8995** | QBI Deduction | Qualified Business Income |
| **Form 1040-ES** | Estimated Tax Worksheet | Quarterly estimates |
| **Form 1040-V** | Payment Voucher | If amount owed with return |

### IRS PDF URL Pattern

```
Current year:  https://www.irs.gov/pub/irs-pdf/f1040.pdf
Prior years:   https://www.irs.gov/pub/irs-prior/f1040--{YEAR}.pdf

Examples:
  Schedule C:    https://www.irs.gov/pub/irs-prior/f1040sc--{YEAR}.pdf
  Schedule SE:   https://www.irs.gov/pub/irs-prior/f1040sse--{YEAR}.pdf
  Schedule 1:    https://www.irs.gov/pub/irs-prior/f1040s1--{YEAR}.pdf
  Schedule 2:    https://www.irs.gov/pub/irs-prior/f1040s2--{YEAR}.pdf
  Schedule A:    https://www.irs.gov/pub/irs-prior/f1040sa--{YEAR}.pdf
  Schedule B:    https://www.irs.gov/pub/irs-prior/f1040sb--{YEAR}.pdf
  Schedule D:    https://www.irs.gov/pub/irs-prior/f1040sd--{YEAR}.pdf
```

### PDF Form Field Extraction Process

IRS PDFs are fillable with named form fields. For each form + year:

1. Download the IRS PDF
2. Extract all form field IDs using pdf-lib or pypdf
3. Map each field ID to our computed value names
4. Store the mapping in `tax_form_templates`
5. At fill time: look up mapping → inject values → flatten PDF → upload

Example field mapping (Form 1040):
```json
{
  "topmostSubform[0].Page1[0].f1_01[0]": "first_name",
  "topmostSubform[0].Page1[0].f1_02[0]": "last_name",
  "topmostSubform[0].Page1[0].f1_03[0]": "ssn",
  "topmostSubform[0].Page1[0].Line1[0]": "wages_line1",
  "topmostSubform[0].Page1[0].Line8[0]": "other_income_line8",
  "topmostSubform[0].Page1[0].Line9[0]": "total_income_line9",
  "topmostSubform[0].Page1[0].Line11[0]": "agi_line11"
}
```

---

## PDF Generation Pipeline

### New Edge Function: `fill-tax-forms`

```
Input:  { tax_return_id: uuid, forms_to_fill?: string[] }
Output: { ok: true, forms: [{ form_type, drive_url, drive_file_id }] }

Steps:
1. Load tax_return + computed_data from DB
2. Determine which forms are needed based on the return data
3. For each form:
   a. Load field_mapping from tax_form_templates
   b. Download IRS PDF (cached in Supabase storage after first download)
   c. Map computed values → PDF field IDs
   d. Fill PDF using pdf-lib
   e. Upload to Google Drive: /{client_folder}/Tax Returns/{year}/{form_name}.pdf
   f. Save drive_file_id to tax_form_instances
4. Return URLs for all generated PDFs
```

### Technology: pdf-lib (Deno compatible)

```typescript
import { PDFDocument } from 'https://cdn.skypack.dev/pdf-lib';

// Load IRS form
const formBytes = await fetch(irsFormUrl).then(r => r.arrayBuffer());
const pdfDoc = await PDFDocument.load(formBytes);
const form = pdfDoc.getForm();

// Fill fields
form.getTextField('topmostSubform[0].Page1[0].f1_01[0]').setText('Alvin');
form.getTextField('topmostSubform[0].Page1[0].f1_02[0]').setText('Sabbs');
form.getTextField('topmostSubform[0].Page1[0].Line11[0]').setText('45,230');

// Flatten (makes fields non-editable, like a printed form)
form.flatten();

// Save
const filledPdf = await pdfDoc.save();
```

### Google Drive Upload (New Helper)

```typescript
async function uploadToClientDrive(
  clientDriveFolderId: string,
  fileName: string,
  pdfBytes: Uint8Array,
  subfolderPath: string  // e.g., "Tax Returns/2024"
): Promise<{ fileId: string; webViewLink: string }> {
  // 1. Create subfolder structure if not exists
  // 2. Upload PDF using Google Drive API v3 multipart upload
  // 3. Return file ID and shareable link
}
```

### Drive Folder Structure Per Client

```
📁 Client Name (existing Drive folder)
├── 📁 Tax Returns
│   ├── 📁 2022
│   │   ├── Form_1040_2022.pdf
│   │   ├── Schedule_C_2022.pdf
│   │   ├── Schedule_SE_2022.pdf
│   │   └── Tax_Summary_2022.pdf
│   ├── 📁 2023
│   │   ├── Form_1040_2023.pdf
│   │   ├── Schedule_C_2023.pdf
│   │   └── ...
│   ├── 📁 2024
│   └── 📁 2025
├── 📁 Credit Reports (existing)
└── 📁 Dispute Letters (existing)
```

---

## Enhanced Claude Prompt

The current prompt already computes Form 1040 lines, Schedule C, and Schedule SE. It needs to be expanded to output structured field values that map directly to IRS PDF form fields.

### Required Output Structure (per form)

```json
{
  "client_info": {
    "first_name": "Sam",
    "last_name": "Higgins",
    "ssn": "XXX-XX-XXXX",
    "address": "...",
    "filing_status": "single"
  },
  "forms": {
    "f1040": {
      "page1": {
        "line1_wages": 0,
        "line2a_tax_exempt_interest": 0,
        "line2b_taxable_interest": 150,
        "line3a_qualified_dividends": 0,
        "line3b_ordinary_dividends": 0,
        "line4a_ira_distributions": 0,
        "line8_other_income": 0,
        "line9_total_income": 67150,
        "line10_adjustments": 4740,
        "line11_agi": 62410,
        "line12_standard_deduction": 14600,
        "line13_qbi_deduction": 0,
        "line14_total_deductions": 14600,
        "line15_taxable_income": 47810
      },
      "page2": {
        "line16_tax": 5436,
        "line22_sum": 5436,
        "line23_se_tax": 9470,
        "line24_total_tax": 14906,
        "line25_w2_withholding": 0,
        "line26_estimated_payments": 0,
        "line33_total_payments": 0,
        "line37_amount_owed": 14906
      }
    },
    "schedule_c": {
      "business_name": "Higgins Consulting",
      "ein": "",
      "business_code": "541990",
      "line1_gross_receipts": 67000,
      "line7_gross_income": 67000,
      "line28_total_expenses": 0,
      "line31_net_profit": 67000
    },
    "schedule_se": {
      "line2_net_earnings": 67000,
      "line3_92_35_pct": 61875,
      "line4a_max_wage_base": 160200,
      "line10_se_tax": 9470,
      "line13_deductible_half": 4735
    },
    "schedule_1": {
      "line15_se_tax_deduction": 4735,
      "line26_total_adjustments": 4735
    },
    "schedule_2": {
      "line4_se_tax": 9470,
      "line21_total": 9470
    }
  },
  "forms_needed": ["f1040", "schedule_c", "schedule_se", "schedule_1", "schedule_2"],
  "filing_readiness": {
    "score": 85,
    "missing": ["SSN verification", "State W-2 confirmation"],
    "ready_to_file": false
  }
}
```

---

## Telegram Commands

### New Tax Commands

| Command | Description | Example |
|---------|-------------|---------|
| Natural language | Auto-routes via taxIntent regex | "Generate Sam's 2024 tax return" |
| `/tax generate <client> <years>` | Generate or regenerate return(s) | `/tax generate Sam 2022-2025` |
| `/tax status <client>` | Show all returns and their status | `/tax status Sam` |
| `/tax view <client> <year>` | View return summary + Drive links | `/tax view Sam 2024` |
| `/tax edit <client> <year>` | Update details and regenerate | `/tax edit Sam 2024` |
| `/tax forms <client> <year>` | List all filled PDFs with links | `/tax forms Sam 2024` |
| `/tax clients` | List all clients with tax returns | `/tax clients` |

### taxIntent Regex (New)

```typescript
const taxIntent =
  /\btax\s+return/i.test(lowerText) ||
  /\bgenerate\b.*\btax/i.test(lowerText) ||
  /\bfile\b.*\btax/i.test(lowerText) ||
  /\btax\b.*\b(2022|2023|2024|2025)\b/i.test(lowerText) ||
  /\b1040\b/i.test(lowerText) ||
  /\bschedule\s+[a-z]/i.test(lowerText) ||
  /\btax\s+(status|view|edit|forms)/i.test(lowerText);
```

### Updated generate_tax_docs Tool Flow

```
1. Parse client name + years from request
2. Fuzzy-match client in clients table
3. For each year:
   a. Check if tax_return exists → load or create
   b. Fetch raw data from CC Tax API
   c. Call Claude with enhanced prompt → get structured form values
   d. Save to tax_returns (input_data, computed_data, agi, etc.)
   e. Call fill-tax-forms edge function → fills IRS PDFs
   f. PDFs uploaded to Drive, URLs saved to tax_form_instances
4. Send Telegram summary with Drive links to each filled form
```

---

## Web Dashboard

### New Route: `/tax`

**Tech:** React + shadcn/ui + TanStack Query (matches existing Ops dashboard)

### Pages

#### `/tax` — Tax Returns Overview
- Client selector dropdown (from clients table)
- Grid of tax return cards per year
- Status badges (draft/review/final/filed)
- Quick stats: AGI, tax owed/refund, readiness score
- "Generate New Return" button

#### `/tax/:clientId/:year` — Return Detail
- **Summary Tab**: Key figures, filing recommendation, missing items
- **Forms Tab**: List of filled IRS forms with embedded PDF viewer, download button, Drive link, form status
- **Edit Tab**: Editable fields grouped by form section, "Regenerate" button that recomputes and refills PDFs, version history
- **Activity Log**: When return was created, edited, forms generated, who made changes

### Component Structure

```
src/pages/
├── Tax.tsx                    (main tax dashboard)
├── TaxReturnDetail.tsx        (individual return view)
src/components/tax/
├── ClientSelector.tsx
├── TaxReturnCard.tsx
├── TaxFormsList.tsx
├── TaxFormViewer.tsx           (PDF preview)
├── TaxReturnEditor.tsx         (field editing)
├── TaxSummaryPanel.tsx
├── FilingReadinessGauge.tsx
└── TaxActivityLog.tsx
```

---

## Implementation Phases

### Phase 1: Foundation (Database + Persistence) — CRITICAL
- Create migration with all 3 new tables
- Update generate-tax-documents to save results to tax_returns
- Update telegram webhook tool to persist computed data
- Add client lookup and return retrieval queries
- **Deliverable**: Tax returns are saved and retrievable

### Phase 2: IRS Form Library (Field Mapping) — HIGH
- Download IRS PDFs for 2022-2025 (1040 + all schedules)
- Extract form field IDs from each PDF
- Create field mappings (our computed names → IRS field IDs)
- Populate tax_form_templates table
- **Deliverable**: Complete field mapping for all forms × all years

### Phase 3: PDF Filling Engine — HIGH
- Build fill-tax-forms edge function using pdf-lib
- Implement field value → PDF injection
- Add Google Drive upload for filled PDFs
- Create Drive folder structure per client
- **Deliverable**: Actual filled IRS PDFs saved to client Drive folders

### Phase 4: Enhanced Claude Prompt — HIGH
- Expand TAX_SYSTEM_PROMPT to output form-field-level values
- Add all Schedule 1, 2, 3, A, B, D, E line computations
- Add conditional form detection (which forms are needed)
- Increase output structure to cover full suite
- **Deliverable**: Claude produces exact values for every IRS form field

### Phase 5: Telegram Commands — MEDIUM
- Add /tax command parser in webhook
- Implement status, view, edit, forms, clients subcommands
- Update taxIntent regex for natural language routing
- Add edit/regenerate flow
- **Deliverable**: Full tax management via Telegram

### Phase 6: Web Dashboard — MEDIUM
- Build /tax route with client selector
- Build return detail page with tabs
- Implement PDF viewer component
- Build field editor with regenerate capability
- **Deliverable**: Full tax management via web UI

### Phase 7: Polish & Production Hardening — LOWER
- Version history for returns
- Audit trail (who changed what when)
- PDF watermark "DRAFT" until status = final
- Filing checklist automation
- State tax form support (future)

---

## Technical Considerations

### Edge Function Timeouts
- Current Supabase edge function timeout: ~60 seconds
- PDF filling per form: ~2-3 seconds
- Drive upload per file: ~3-5 seconds
- Strategy: Fill and upload forms in parallel batches of 3
- Fallback: Split into separate edge function calls per form

### IRS Form Field Extraction (One-Time Setup)
- Must be done once per form per year
- Use pdf-lib in Node.js to enumerate all fields
- Store results in tax_form_templates
- Field IDs change between tax years — each year needs its own mapping

### Google Drive API Authentication
- Current system uses API Key (limited to public reads)
- PDF upload requires OAuth2 service account with write access
- Need: Google Cloud service account with Drive API scope
- Store: Service account JSON key in Supabase secrets

### Data Security
- SSN and sensitive data stored encrypted in Supabase (JSONB with application-level encryption)
- PDFs in Drive should be in restricted client folders
- No SSN in Telegram messages — only last 4 digits
- Web dashboard requires authentication

---

## Success Criteria

When complete, the system should:

1. Accept "Generate Sam's 2024 tax return" via Telegram or web
2. Pull all financial data automatically
3. Compute every line on every applicable IRS form
4. Fill actual IRS PDF forms with computed values
5. Save filled PDFs to client's Google Drive folder
6. Persist all data so the return can be retrieved anytime
7. Allow editing individual values and regenerating affected forms
8. Show a professional dashboard with PDF preview and status tracking
9. Track return status from draft through filed
10. Handle multiple clients across multiple tax years simultaneously

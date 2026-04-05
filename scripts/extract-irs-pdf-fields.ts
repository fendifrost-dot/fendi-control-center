#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write
/**
 * Download an IRS fillable PDF and print all AcroForm field names (for tax_form_templates.field_mapping).
 *
 * Usage:
 *   deno run --allow-net --allow-read scripts/extract-irs-pdf-fields.ts https://www.irs.gov/pub/irs-prior/f1040--2024.pdf
 *
 * Pipe output to a file and reconcile keys with scripts/extract-irs-pdf-fields.ts vs seeded mappings.
 */
import { PDFDocument } from "npm:pdf-lib@1.17.1";

const url = Deno.args[0];
if (!url) {
  console.error("Usage: extract-irs-pdf-fields.ts <pdf-url>");
  Deno.exit(1);
}

const resp = await fetch(url);
if (!resp.ok) {
  console.error(`Fetch failed: ${resp.status}`);
  Deno.exit(1);
}

const buf = new Uint8Array(await resp.arrayBuffer());
const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
const names = pdf.getForm().getFields().map((f) => f.getName());
console.log(JSON.stringify({ url, field_count: names.length, fields: names.sort() }, null, 2));

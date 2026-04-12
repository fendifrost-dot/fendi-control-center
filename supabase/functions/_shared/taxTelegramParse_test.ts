import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  extractClientNameForTaxCommand,
  tryParseManualDeductionMessage,
  tryParseManualIncomeMessage,
} from "./taxTelegramParse.ts";

Deno.test("tryParseManualIncomeMessage: 1099-K style with name and year", () => {
  const r = tryParseManualIncomeMessage(
    "Add $161,229.90 business income for Sam Higgins 2022 from 1099-K payments",
  );
  assertEquals(r?.client_name, "Sam Higgins");
  assertEquals(r?.tax_year, 2022);
  assertEquals(r?.amount, 161229.9);
  assertEquals(r?.category, "freelance");
});

Deno.test("tryParseManualDeductionMessage: add business expense", () => {
  const r = tryParseManualDeductionMessage(
    "Add $450 business expense for Jane Doe 2023 for software",
  );
  assertEquals(r?.client_name, "Jane Doe");
  assertEquals(r?.tax_year, 2023);
  assertEquals(r?.amount, 450);
  assertEquals(r?.category, "office_expense");
});

Deno.test("tryParseManualIncomeMessage: rejects deduction-only phrasing", () => {
  const r = tryParseManualIncomeMessage("Add $100 deduction for Sam Higgins 2022");
  assertEquals(r, null);
});

Deno.test("tryParseManualIncomeMessage: freeform add income name year amount", () => {
  const r = tryParseManualIncomeMessage(
    "add income Sam Higgins 2022 161229.90 business",
  );
  assertEquals(r?.client_name, "Sam Higgins");
  assertEquals(r?.tax_year, 2022);
  assertEquals(r?.amount, 161229.9);
});

Deno.test("tryParseManualIncomeMessage: fullwidth dollar sign", () => {
  const r = tryParseManualIncomeMessage(
    "Add \uFF04" + "5,000 cash income for Sam 2022",
  );
  assertEquals(r?.amount, 5000);
  assertEquals(r?.tax_year, 2022);
});

Deno.test("tryParseManualDeductionMessage: home office keyword", () => {
  const r = tryParseManualDeductionMessage(
    "Add $3,000 deduction for Sam Higgins 2022 home office",
  );
  assertEquals(r?.client_name, "Sam Higgins");
  assertEquals(r?.category, "office_expense");
});

// --- extractClientNameForTaxCommand tests (CG pattern parity) ---

Deno.test("extractClientNameForTaxCommand: basic generate", () => {
  assertEquals(
    extractClientNameForTaxCommand("generate Sam Higgins tax return"),
    "Sam Higgins",
  );
});

Deno.test("extractClientNameForTaxCommand: do + name + tax", () => {
  assertEquals(
    extractClientNameForTaxCommand("do Jabril tax return for 2022"),
    "Jabril",
  );
});

Deno.test("extractClientNameForTaxCommand: noisy status word stripped", () => {
  assertEquals(
    extractClientNameForTaxCommand("generate Jabril extension tax return"),
    "Jabril",
  );
  assertEquals(
    extractClientNameForTaxCommand("file Ashley amendment tax return for 2023"),
    "Ashley",
  );
  assertEquals(
    extractClientNameForTaxCommand("prepare Deleon progress tax docs"),
    "Deleon",
  );
});

Deno.test("extractClientNameForTaxCommand: multi-word name + noise stripped", () => {
  assertEquals(
    extractClientNameForTaxCommand("generate Mary Jane extension tax return"),
    "Mary Jane",
  );
});

Deno.test("extractClientNameForTaxCommand: quoted name exact", () => {
  assertEquals(
    extractClientNameForTaxCommand(`generate "North Star Client LLC" tax return`),
    "North Star Client LLC",
  );
});

Deno.test("extractClientNameForTaxCommand: LLC name with 'Tax' in business name preserved", () => {
  // "Tax" should NOT be stripped from "Tax Solutions LLC" because it's part of the entity name
  assertEquals(
    extractClientNameForTaxCommand(`generate "Tax Solutions LLC" tax return`),
    "Tax Solutions LLC",
  );
});

Deno.test("extractClientNameForTaxCommand: possessive form", () => {
  assertEquals(
    extractClientNameForTaxCommand("prepare Sam Higgins's tax return for 2022"),
    "Sam Higgins",
  );
});

Deno.test("extractClientNameForTaxCommand: tax return for NAME pattern", () => {
  assertEquals(
    extractClientNameForTaxCommand("tax return for Leon Dorset"),
    "Leon Dorset",
  );
});

Deno.test("extractClientNameForTaxCommand: file + name + for year", () => {
  assertEquals(
    extractClientNameForTaxCommand("file Terrence tax return for 2024"),
    "Terrence",
  );
});

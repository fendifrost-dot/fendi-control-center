import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
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
    "Add ＄5,000 cash income for Sam 2022",
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

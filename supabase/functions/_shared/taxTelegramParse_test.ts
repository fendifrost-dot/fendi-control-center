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

/**
 * Run: deno test supabase/functions/_shared/telegramAttachmentCaption_test.ts --allow-env
 */
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  clarificationMessageForFailure,
  parseAttachmentCaption,
} from "./telegramAttachmentCaption.ts";

Deno.test("parseAttachmentCaption: pipe-separated happy path with round", () => {
  const r = parseAttachmentCaption("Sam | Equifax | Round 2 response");
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  assertEquals(r.value.client, "Sam");
  assertEquals(r.value.bureauCanonical, "equifax");
  assertEquals(r.value.bureau, "Equifax");
  assertEquals(r.value.round, 2);
  assertEquals(r.value.shortTag, "r2-response");
});

Deno.test("parseAttachmentCaption: slash separator", () => {
  const r = parseAttachmentCaption("Tara / Innovis / Round 1 response");
  if (!r.ok) throw new Error("expected ok");
  assertEquals(r.value.client, "Tara");
  assertEquals(r.value.bureauCanonical, "innovis");
  assertEquals(r.value.round, 1);
  assertEquals(r.value.shortTag, "r1-response");
});

Deno.test("parseAttachmentCaption: dash separator", () => {
  const r = parseAttachmentCaption("Damekia - LexisNexis - Round 1 response");
  if (!r.ok) throw new Error("expected ok");
  assertEquals(r.value.client, "Damekia");
  assertEquals(r.value.bureauCanonical, "lexisnexis");
  assertEquals(r.value.round, 1);
});

Deno.test("parseAttachmentCaption: case-insensitive bureau (TU alias)", () => {
  const r = parseAttachmentCaption("sam | tu | r2");
  if (!r.ok) throw new Error("expected ok");
  assertEquals(r.value.bureauCanonical, "transunion");
  assertEquals(r.value.bureau, "TransUnion");
  assertEquals(r.value.round, 2);
});

Deno.test("parseAttachmentCaption: 'Trans Union' two-word alias", () => {
  const r = parseAttachmentCaption("Sam | Trans Union | Round 2 response");
  if (!r.ok) throw new Error("expected ok");
  assertEquals(r.value.bureauCanonical, "transunion");
});

Deno.test("parseAttachmentCaption: round optional → response tag", () => {
  const r = parseAttachmentCaption("Sam | Equifax");
  if (!r.ok) throw new Error("expected ok");
  assertEquals(r.value.round, null);
  assertEquals(r.value.shortTag, "response");
});

Deno.test("parseAttachmentCaption: empty caption fails with empty_caption", () => {
  const r = parseAttachmentCaption("");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "empty_caption");
});

Deno.test("parseAttachmentCaption: non-string caption fails", () => {
  const r = parseAttachmentCaption(undefined);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "empty_caption");
});

Deno.test("parseAttachmentCaption: only client fails too_few_segments", () => {
  const r = parseAttachmentCaption("Sam");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "too_few_segments");
});

Deno.test("parseAttachmentCaption: missing bureau (trailing pipe) fails", () => {
  const r = parseAttachmentCaption("Sam |   ");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "too_few_segments");
});

Deno.test("parseAttachmentCaption: unknown bureau fails", () => {
  const r = parseAttachmentCaption("Sam | NotABureau | Round 1");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "unknown_bureau");
});

Deno.test("parseAttachmentCaption: leading/trailing whitespace tolerated", () => {
  const r = parseAttachmentCaption("   Sam   |   Equifax   |   Round 2 response   ");
  if (!r.ok) throw new Error("expected ok");
  assertEquals(r.value.client, "Sam");
  assertEquals(r.value.bureau, "Equifax");
  assertEquals(r.value.round, 2);
});

Deno.test("parseAttachmentCaption: extra trailing segments folded into round field", () => {
  const r = parseAttachmentCaption("Sam | Equifax | Round 2 | response");
  if (!r.ok) throw new Error("expected ok");
  assertEquals(r.value.round, 2);
});

Deno.test("parseAttachmentCaption: 'r2 response' shorthand parses round", () => {
  const r = parseAttachmentCaption("Sam | EQ | r2 response");
  if (!r.ok) throw new Error("expected ok");
  assertEquals(r.value.round, 2);
  assertEquals(r.value.shortTag, "r2-response");
});

Deno.test("parseAttachmentCaption: bureau-only round-number tail", () => {
  const r = parseAttachmentCaption("Sam | EQ | 3");
  if (!r.ok) throw new Error("expected ok");
  assertEquals(r.value.round, 3);
  assertEquals(r.value.shortTag, "r3-response");
});

Deno.test("clarificationMessageForFailure: empty_caption mentions caption requirement", () => {
  const msg = clarificationMessageForFailure("empty_caption", "");
  assertEquals(msg.includes("no caption"), true);
});

Deno.test("clarificationMessageForFailure: unknown_bureau lists known bureaus", () => {
  const msg = clarificationMessageForFailure("unknown_bureau", "Sam | Foo | r1");
  assertEquals(msg.includes("Equifax"), true);
  assertEquals(msg.includes("TransUnion"), true);
  assertEquals(msg.includes("Innovis"), true);
});

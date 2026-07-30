import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  hasNaturalLanguageExecutionIntent,
  isClearlyConversational,
  isConnectivityCheck,
  isHelpRequest,
  isHubStatusRequest,
  isMacBridgeStatusCheck,
  isUnknownSlashCommand,
  normalizeTelegramText,
} from "./telegramNaturalLanguage.ts";

Deno.test("normalizeTelegramText strips bot mention", () => {
  assertEquals(normalizeTelegramText("@FendiAIbot /ping"), "/ping");
});

Deno.test("isMacBridgeStatusCheck natural phrases", () => {
  assertEquals(isMacBridgeStatusCheck("is my mac online"), true);
  assertEquals(isMacBridgeStatusCheck("/mac status"), true);
  assertEquals(isMacBridgeStatusCheck("can you see if my laptop is reachable"), true);
});

Deno.test("isHubStatusRequest natural phrases", () => {
  assertEquals(isHubStatusRequest("what's the hub status"), true);
  assertEquals(isHubStatusRequest("status"), true);
  assertEquals(isHubStatusRequest("how is everything going"), true);
});

Deno.test("isHelpRequest paraphrases", () => {
  assertEquals(isHelpRequest("what can you do for me"), true);
  assertEquals(isHelpRequest("I'm stuck"), true);
});

Deno.test("hasNaturalLanguageExecutionIntent credit phrase", () => {
  assertEquals(hasNaturalLanguageExecutionIntent("analyze credit for jabril"), true);
  assertEquals(hasNaturalLanguageExecutionIntent("jabril needs help with his credit"), true);
});

Deno.test("mac work not cloud execution", () => {
  assertEquals(hasNaturalLanguageExecutionIntent("on my mac run git status"), false);
});

Deno.test("isUnknownSlashCommand", () => {
  assertEquals(isUnknownSlashCommand("/foobar"), true);
  assertEquals(isUnknownSlashCommand("/status"), false);
});

Deno.test("isClearlyConversational", () => {
  assertEquals(isClearlyConversational("hello"), true);
  assertEquals(isClearlyConversational("explain how disputes work"), true);
  assertEquals(isClearlyConversational("analyze credit for jabril"), false);
});

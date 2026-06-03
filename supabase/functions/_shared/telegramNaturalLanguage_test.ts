import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  hasNaturalLanguageExecutionIntent,
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
});

Deno.test("isHubStatusRequest natural phrases", () => {
  assertEquals(isHubStatusRequest("what's the hub status"), true);
  assertEquals(isHubStatusRequest("status"), true);
});

Deno.test("hasNaturalLanguageExecutionIntent credit phrase", () => {
  assertEquals(hasNaturalLanguageExecutionIntent("analyze credit for jabril"), true);
});

Deno.test("mac work not cloud execution", () => {
  assertEquals(hasNaturalLanguageExecutionIntent("on my mac run git status"), false);
});

Deno.test("isUnknownSlashCommand", () => {
  assertEquals(isUnknownSlashCommand("/foobar"), true);
  assertEquals(isUnknownSlashCommand("/status"), false);
});

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { assertShellAllowed, parseMacTelegramCommand } from "./remoteBridge.ts";

Deno.test("parseMacTelegramCommand: /mac status", () => {
  const r = parseMacTelegramCommand("/mac status");
  assertEquals(r?.command_type, "ping");
});

Deno.test("parseMacTelegramCommand: /mac cursor prompt", () => {
  const r = parseMacTelegramCommand("/mac cursor fix the tax PDF timeout");
  assertEquals(r?.command_type, "cursor_agent");
  assertEquals(r?.payload.text, "fix the tax PDF timeout");
});

Deno.test("parseMacTelegramCommand: run on my mac", () => {
  const r = parseMacTelegramCommand("run on my mac: git status");
  assertEquals(r?.command_type, "shell");
  assertEquals(r?.payload.text, "git status");
});

Deno.test("assertShellAllowed blocks rm -rf", () => {
  const err = assertShellAllowed("rm -rf /");
  if (!err || !err.includes("Blocked")) throw new Error(`expected block, got ${err}`);
});

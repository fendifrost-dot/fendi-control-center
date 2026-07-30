/**
 * Natural-language-first Telegram commands — before task row, pending state, and Lane 2.
 * Regex catches common phrasing; Gemini dialogue classify handles paraphrases.
 * Bump TELEGRAM_WEBHOOK_BUNDLE_VERSION when deploying telegram-webhook.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { parseMacTelegramCommand } from "./remoteBridge.ts";
import { tryHandleRemoteMacCommand } from "./remoteBridgeTelegram.ts";
import { classifyEarlyDialogueIntent } from "./telegramDialogueClassify.ts";
import {
  isConnectivityCheck,
  isHelpRequest,
  isHubStatusRequest,
  isUnknownSlashCommand,
  NATURAL_LANGUAGE_HELP,
  normalizeTelegramText,
} from "./telegramNaturalLanguage.ts";

export const TELEGRAM_WEBHOOK_BUNDLE_VERSION = "2026-06-03-telegram-v4-dialogue";

async function quickHubStatus(supabase: SupabaseClient): Promise<string> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  let macLine = "Mac bridge: unknown";
  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/remote-bridge-api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "health" }),
    });
    const h = await resp.json();
    macLine = h.online ? `Mac bridge: online (${h.primary_device?.device_name ?? "device"})` : "Mac bridge: offline";
  } catch {
    macLine = "Mac bridge: health check failed";
  }

  const { count: failedTasks } = await supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("status", "failed");
  const { count: queuedOutbox } = await supabase
    .from("telegram_outbox")
    .select("id", { count: "exact", head: true })
    .in("status", ["queued", "failed"]);

  return [
    "Hub status",
    macLine,
    `Failed tasks: ${failedTasks ?? 0}`,
    `Outbox pending/failed: ${queuedOutbox ?? 0}`,
    `Webhook bundle: ${TELEGRAM_WEBHOOK_BUNDLE_VERSION}`,
  ].join("\n");
}

async function handleByDialogueIntent(
  supabase: SupabaseClient,
  chatId: string,
  normalized: string,
  intent: "ping" | "help" | "hub_status" | "mac_status" | "mac_run",
  sendMessage: (chatId: string, text: string) => Promise<void>,
): Promise<boolean> {
  if (intent === "help") {
    await sendMessage(chatId, NATURAL_LANGUAGE_HELP);
    return true;
  }
  if (intent === "ping") {
    await sendMessage(chatId, `pong\nwebhook bundle: ${TELEGRAM_WEBHOOK_BUNDLE_VERSION}`);
    return true;
  }
  if (intent === "hub_status") {
    await sendMessage(chatId, await quickHubStatus(supabase));
    return true;
  }
  if (intent === "mac_status" || intent === "mac_run") {
    if (parseMacTelegramCommand(normalized)) {
      return await tryHandleRemoteMacCommand(supabase, chatId, normalized, sendMessage);
    }
    if (intent === "mac_status") {
      return await tryHandleRemoteMacCommand(supabase, chatId, "/mac status", sendMessage);
    }
    await sendMessage(
      chatId,
      "Got it — you want something run on your Mac. Say what to run in your own words (e.g. git status in the control-center folder).",
    );
    return true;
  }
  return false;
}

export async function tryHandleTelegramEarlyCommands(
  supabase: SupabaseClient,
  chatId: string,
  text: string,
  sendMessage: (chatId: string, text: string) => Promise<void>,
): Promise<boolean> {
  const normalized = normalizeTelegramText(text);

  if (isUnknownSlashCommand(normalized)) {
    await sendMessage(
      chatId,
      `That slash shortcut isn't recognized.\n\n${NATURAL_LANGUAGE_HELP}`,
    );
    return true;
  }

  if (isHelpRequest(normalized)) {
    await sendMessage(chatId, NATURAL_LANGUAGE_HELP);
    return true;
  }

  if (isConnectivityCheck(normalized)) {
    await sendMessage(chatId, `pong\nwebhook bundle: ${TELEGRAM_WEBHOOK_BUNDLE_VERSION}`);
    return true;
  }

  if (isHubStatusRequest(normalized)) {
    await sendMessage(chatId, await quickHubStatus(supabase));
    return true;
  }

  if (parseMacTelegramCommand(normalized)) {
    return await tryHandleRemoteMacCommand(supabase, chatId, normalized, sendMessage);
  }

  // Paraphrases: Gemini reads meaning, not exact wording (regex above is fast path only)
  if (!normalized.startsWith("/") && normalized.length <= 500) {
    const dialogue = await classifyEarlyDialogueIntent(normalized);
    if (dialogue && dialogue !== "none") {
      const handled = await handleByDialogueIntent(supabase, chatId, normalized, dialogue, sendMessage);
      if (handled) return true;
    }
  }

  return false;
}

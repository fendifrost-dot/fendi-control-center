/**
 * Natural-language-first Telegram commands — before task row, pending state, and Lane 2.
 * Bump TELEGRAM_WEBHOOK_BUNDLE_VERSION when deploying telegram-webhook.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { parseMacTelegramCommand } from "./remoteBridge.ts";
import { tryHandleRemoteMacCommand } from "./remoteBridgeTelegram.ts";
import {
  isConnectivityCheck,
  isHelpRequest,
  isHubStatusRequest,
  isUnknownSlashCommand,
  NATURAL_LANGUAGE_HELP,
  normalizeTelegramText,
} from "./telegramNaturalLanguage.ts";

export const TELEGRAM_WEBHOOK_BUNDLE_VERSION = "2026-06-03-telegram-v3-natural";

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

  return false;
}

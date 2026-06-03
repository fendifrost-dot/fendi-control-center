/**
 * High-priority Telegram commands — run before task row, pending state, and Lane 2.
 * Bump TELEGRAM_WEBHOOK_BUNDLE_VERSION when deploying telegram-webhook.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { parseMacTelegramCommand } from "./remoteBridge.ts";
import { tryHandleRemoteMacCommand } from "./remoteBridgeTelegram.ts";

/** Change this string on every telegram-webhook deploy to verify production bundle. */
export const TELEGRAM_WEBHOOK_BUNDLE_VERSION = "2026-06-03-telegram-v2";

export async function tryHandleTelegramEarlyCommands(
  supabase: SupabaseClient,
  chatId: string,
  text: string,
  sendMessage: (chatId: string, text: string) => Promise<void>,
): Promise<boolean> {
  const lower = text.toLowerCase().trim();

  if (lower === "/ping" || lower === "/version" || lower === "/hub version") {
    await sendMessage(
      chatId,
      lower === "/ping"
        ? `pong\nwebhook bundle: ${TELEGRAM_WEBHOOK_BUNDLE_VERSION}`
        : `Fendi webhook bundle: ${TELEGRAM_WEBHOOK_BUNDLE_VERSION}`,
    );
    return true;
  }

  if (parseMacTelegramCommand(text)) {
    return await tryHandleRemoteMacCommand(supabase, chatId, text, sendMessage);
  }

  return false;
}

/** Telegram handlers for Remote Control Hub — import from telegram-webhook. */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { assertShellAllowed, parseMacTelegramCommand } from "./remoteBridge.ts";

export async function tryHandleRemoteMacCommand(
  _supabase: SupabaseClient,
  chatId: string,
  text: string,
  sendMessage: (chatId: string, text: string) => Promise<void>,
): Promise<boolean> {
  const parsed = parseMacTelegramCommand(text);
  if (!parsed) return false;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const enqueueKey = Deno.env.get("REMOTE_BRIDGE_ENQUEUE_KEY") ?? "";

  if (parsed.command_type === "ping") {
    const healthResp = await fetch(`${supabaseUrl}/functions/v1/remote-bridge-api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "health" }),
    });
    const health = await healthResp.json().catch(() => ({}));
    const online = health.online ? "online" : "offline";
    await sendMessage(
      chatId,
      [
        "Mac bridge status",
        `Bridge: ${online}`,
        `Queued: ${health.queued_commands ?? "?"}`,
        `Token configured: ${health.bridge_token_configured ? "yes" : "no"}`,
        health.primary_device?.last_seen_at
          ? `Last seen: ${health.primary_device.last_seen_at}`
          : "Last seen: never — run scripts/remote-bridge on your Mac",
      ].join("\n"),
    );
    return true;
  }

  if (parsed.command_type === "shell" && parsed.payload.text) {
    const block = assertShellAllowed(parsed.payload.text);
    if (block) {
      await sendMessage(chatId, `Mac bridge blocked: ${block}`);
      return true;
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${serviceKey}`,
  };
  if (enqueueKey) headers["x-remote-bridge-enqueue-key"] = enqueueKey;

  const resp = await fetch(`${supabaseUrl}/functions/v1/remote-bridge-api`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "enqueue",
      command_type: parsed.command_type,
      payload: parsed.payload,
      source: "telegram",
      reply_chat_id: chatId,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    await sendMessage(
      chatId,
      `Mac bridge enqueue failed: ${data.error ?? resp.status}. Deploy remote-bridge-api and set REMOTE_BRIDGE_TOKEN on your Mac.`,
    );
    return true;
  }

  const id = data.command?.id ?? "unknown";
  await sendMessage(
    chatId,
    `Mac bridge: queued ${String(id).slice(0, 8)} (${parsed.command_type}). Runs when your Mac daemon is connected.`,
  );
  return true;
}

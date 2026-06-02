import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  assertShellAllowed,
  formatRemoteResultForTelegram,
  type RemoteCommandPayload,
  type RemoteCommandType,
} from "../_shared/remoteBridge.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-remote-bridge-token",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BRIDGE_TOKEN = Deno.env.get("REMOTE_BRIDGE_TOKEN") ?? "";
const ENQUEUE_KEY = Deno.env.get("REMOTE_BRIDGE_ENQUEUE_KEY") ?? "";
const BOT_TOKEN = Deno.env.get("FendiAIbot") ?? "";
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function authBridge(req: Request): boolean {
  if (!BRIDGE_TOKEN) return false;
  const header = req.headers.get("x-remote-bridge-token") ?? req.headers.get("X-Remote-Bridge-Token");
  return header === BRIDGE_TOKEN;
}

async function authEnqueue(req: Request, body: Record<string, unknown>): Promise<boolean> {
  const key = req.headers.get("x-remote-bridge-enqueue-key") ?? body.enqueue_key;
  if (ENQUEUE_KEY && key === ENQUEUE_KEY) return true;
  const auth = req.headers.get("authorization") ?? "";
  if (auth === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) return true;
  if (auth.startsWith("Bearer ")) {
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
    if (anonKey) {
      const userClient = createClient(SUPABASE_URL, anonKey, {
        global: { headers: { Authorization: auth } },
      });
      const { data } = await userClient.auth.getUser();
      if (data.user) return true;
    }
  }
  return false;
}

async function ensureDefaultDevice(supabase: ReturnType<typeof createClient>): Promise<string> {
  const name = Deno.env.get("REMOTE_BRIDGE_DEVICE_NAME") ?? "primary-mac";
  const { data: existing } = await supabase
    .from("remote_bridge_devices")
    .select("id")
    .eq("device_name", name)
    .eq("status", "active")
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data: created, error } = await supabase
    .from("remote_bridge_devices")
    .insert({ device_name: name, capabilities: ["shell", "cursor_agent", "claude", "open_url", "notify"] })
    .select("id")
    .single();
  if (error || !created?.id) throw new Error(error?.message ?? "device create failed");
  return created.id as string;
}

async function notifyTelegram(chatId: string, text: string) {
  if (!TELEGRAM_API || !chatId) return;
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const action = String(body.action ?? "health");

  if (action === "health") {
    const { count } = await supabase
      .from("remote_command_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued");
    const { data: device } = await supabase
      .from("remote_bridge_devices")
      .select("id, device_name, last_seen_at, status")
      .eq("status", "active")
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    return json({
      ok: true,
      bridge_token_configured: Boolean(BRIDGE_TOKEN),
      enqueue_key_configured: Boolean(ENQUEUE_KEY),
      queued_commands: count ?? 0,
      primary_device: device ?? null,
      online: device?.last_seen_at
        ? Date.now() - new Date(device.last_seen_at as string).getTime() < 60_000
        : false,
    });
  }

  if (action === "enqueue") {
    if (!(await authEnqueue(req, body))) return json({ error: "Unauthorized" }, 401);

    const command_type = String(body.command_type ?? "") as RemoteCommandType;
    const payload = (body.payload ?? {}) as RemoteCommandPayload;
    const reply_chat_id = body.reply_chat_id ? String(body.reply_chat_id) : null;
    const source = String(body.source ?? "api");
    const source_ref = body.source_ref ? String(body.source_ref) : null;

    if (!command_type) return json({ error: "command_type required" }, 400);
    if (command_type === "shell" && payload.text) {
      const block = assertShellAllowed(payload.text);
      if (block) return json({ error: block }, 400);
    }

    let device_id: string | null = body.device_id ? String(body.device_id) : null;
    if (!device_id) {
      try {
        device_id = await ensureDefaultDevice(supabase);
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    const { data: row, error } = await supabase
      .from("remote_command_queue")
      .insert({
        device_id,
        source,
        source_ref,
        command_type,
        payload,
        reply_chat_id,
        status: "queued",
      })
      .select("id, command_type, status, created_at")
      .single();

    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, command: row });
  }

  if (!authBridge(req)) return json({ error: "Invalid or missing X-Remote-Bridge-Token" }, 401);

  if (action === "register" || action === "heartbeat") {
    const deviceName = String(body.device_name ?? Deno.env.get("REMOTE_BRIDGE_DEVICE_NAME") ?? "primary-mac");
    let deviceId = body.device_id ? String(body.device_id) : null;
    if (!deviceId) deviceId = await ensureDefaultDevice(supabase);
    await supabase
      .from("remote_bridge_devices")
      .update({ last_seen_at: new Date().toISOString(), device_name: deviceName })
      .eq("id", deviceId);
    return json({ ok: true, device_id: deviceId });
  }

  if (action === "poll") {
    const deviceId = body.device_id ? String(body.device_id) : await ensureDefaultDevice(supabase);
    const limit = Math.min(Number(body.limit ?? 5), 10);
    const now = new Date().toISOString();

    const { data: rows, error } = await supabase.rpc("claim_remote_command_rows", {
      p_device_id: deviceId,
      p_limit: limit,
      p_now: now,
    });
    if (error) return json({ error: error.message }, 500);

    await supabase
      .from("remote_bridge_devices")
      .update({ last_seen_at: now })
      .eq("id", deviceId);

    return json({ ok: true, device_id: deviceId, commands: rows ?? [] });
  }

  if (action === "complete") {
    const commandId = String(body.command_id ?? "");
    if (!commandId) return json({ error: "command_id required" }, 400);

    const status = body.ok === false ? "failed" : "completed";
    const result_json = (body.result ?? {}) as Record<string, unknown>;
    const errorText = body.error ? String(body.error) : null;

    const { data: cmd, error: updErr } = await supabase
      .from("remote_command_queue")
      .update({
        status,
        result_json,
        error: errorText,
        completed_at: new Date().toISOString(),
      })
      .eq("id", commandId)
      .select("id, command_type, reply_chat_id, source")
      .single();

    if (updErr) return json({ error: updErr.message }, 500);

    if (cmd?.reply_chat_id && cmd.source === "telegram") {
      const msg = formatRemoteResultForTelegram(
        commandId,
        cmd.command_type as string,
        result_json as { stdout?: string; stderr?: string; exit_code?: number; message?: string },
        errorText,
      );
      await notifyTelegram(cmd.reply_chat_id as string, msg);
    }

    return json({ ok: true });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});

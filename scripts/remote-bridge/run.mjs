#!/usr/bin/env node
/**
 * Fendi Remote Bridge — run on your Mac while away.
 * Polls the control hub command queue and executes shell / Cursor / Claude locally.
 *
 * Env: SUPABASE_URL, REMOTE_BRIDGE_TOKEN, optional REMOTE_BRIDGE_DEVICE_NAME, REMOTE_BRIDGE_WORKDIR
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
const BRIDGE_TOKEN = process.env.REMOTE_BRIDGE_TOKEN;
const DEVICE_NAME = process.env.REMOTE_BRIDGE_DEVICE_NAME ?? "primary-mac";
const WORKDIR = process.env.REMOTE_BRIDGE_WORKDIR ?? homedir();
const POLL_MS = Number(process.env.REMOTE_BRIDGE_POLL_MS ?? 3000);
const API = `${SUPABASE_URL}/functions/v1/remote-bridge-api`;

if (!SUPABASE_URL || !BRIDGE_TOKEN) {
  console.error("Set SUPABASE_URL and REMOTE_BRIDGE_TOKEN");
  process.exit(1);
}

let deviceId = process.env.REMOTE_BRIDGE_DEVICE_ID ?? null;

async function api(body) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Remote-Bridge-Token": BRIDGE_TOKEN,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function runProcess(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? WORKDIR,
      env: { ...process.env, ...opts.env },
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ stdout, stderr, exit_code: 124, message: "timeout" });
    }, opts.timeoutMs ?? 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exit_code: code ?? 1 });
    });
  });
}

function which(bin) {
  const paths = (process.env.PATH ?? "").split(":");
  for (const dir of ["/usr/local/bin", "/opt/homebrew/bin", join(homedir(), ".local/bin"), ...paths]) {
    const p = join(dir, bin);
    if (existsSync(p)) return p;
  }
  return bin;
}

async function executeCommand(row) {
  const { id, command_type, payload } = row;
  const p = payload ?? {};

  switch (command_type) {
    case "ping":
      return { message: `Bridge alive on ${DEVICE_NAME}`, exit_code: 0 };
    case "shell":
      return runProcess("/bin/bash", ["-lc", String(p.text ?? "")], { timeoutMs: (p.timeout_sec ?? 120) * 1000 });
    case "open_url": {
      const url = String(p.url ?? "");
      if (process.platform === "darwin") await runProcess("/usr/bin/open", [url]);
      else await runProcess("xdg-open", [url]);
      return { message: `Opened ${url}`, exit_code: 0 };
    }
    case "notify": {
      const msg = String(p.text ?? "").replace(/"/g, '\\"');
      if (process.platform === "darwin") {
        await runProcess("/usr/bin/osascript", [
          "-e",
          `display notification "${msg}" with title "Fendi Control Hub"`,
        ]);
      }
      return { message: "Notification sent", exit_code: 0 };
    }
    case "cursor_agent": {
      const cursor = which("cursor");
      const prompt = String(p.text ?? "");
      return runProcess(cursor, ["agent", "--print", prompt], { timeoutMs: 300_000 });
    }
    case "claude": {
      const claude = which("claude");
      const prompt = String(p.text ?? "");
      return runProcess(claude, ["-p", prompt], { timeoutMs: 300_000 });
    }
    default:
      return { exit_code: 1, stderr: `Unknown command_type: ${command_type}` };
  }
}

async function loop() {
  const reg = await api({ action: deviceId ? "heartbeat" : "register", device_name: DEVICE_NAME, device_id: deviceId });
  deviceId = reg.device_id ?? deviceId;

  const poll = await api({ action: "poll", device_id: deviceId, limit: 5 });
  for (const cmd of poll.commands ?? []) {
    console.log(`[bridge] run ${cmd.id} ${cmd.command_type}`);
    try {
      const result = await executeCommand(cmd);
      await api({ action: "complete", command_id: cmd.id, ok: true, result });
      console.log(`[bridge] done ${cmd.id}`);
    } catch (e) {
      await api({
        action: "complete",
        command_id: cmd.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      console.error(`[bridge] fail ${cmd.id}`, e);
    }
  }
}

console.log(`Remote bridge starting (${DEVICE_NAME}) → ${API}`);
(async () => {
  for (;;) {
    try {
      await loop();
    } catch (e) {
      console.error("[bridge] poll error:", e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})();

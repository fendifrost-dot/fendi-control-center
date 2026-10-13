#!/usr/bin/env node
/**
 * Fendi Remote Bridge — run on your Mac while away.
 * Polls the control hub command queue and executes shell / Cursor / Claude locally.
 *
 * Env: SUPABASE_URL, REMOTE_BRIDGE_TOKEN, optional REMOTE_BRIDGE_DEVICE_NAME, REMOTE_BRIDGE_WORKDIR
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRIDGE_HOME, executeAgentHandoff, imessageRead, imessageSend, probeCapabilities, pruneWorkspaces } from "./agentHandoff.mjs";
import { deliverSaved, flushOutbox, saveResult } from "./resultOutbox.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
const BRIDGE_TOKEN = process.env.REMOTE_BRIDGE_TOKEN;
const DEVICE_NAME = process.env.REMOTE_BRIDGE_DEVICE_NAME ?? "primary-mac";
const WORKDIR = process.env.REMOTE_BRIDGE_WORKDIR ?? homedir();
const POLL_MS = Number(process.env.REMOTE_BRIDGE_POLL_MS ?? 3000);
const API = `${SUPABASE_URL}/functions/v1/remote-bridge-api`;
const HUB_API = `${SUPABASE_URL}/functions/v1/agent-hub`;
const MAX_AGENT_RUNS = Number(process.env.REMOTE_BRIDGE_MAX_AGENT_RUNS ?? 2);
const CAPS_EVERY_MS = 10 * 60_000;

if (!SUPABASE_URL || !BRIDGE_TOKEN) {
  console.error("Set SUPABASE_URL and REMOTE_BRIDGE_TOKEN");
  process.exit(1);
}

// Keep the device id across restarts so the hub sees one Mac, not a new row per restart.
const DEVICE_FILE = join(BRIDGE_HOME, "device.json");
function loadDeviceId() {
  try { return JSON.parse(readFileSync(DEVICE_FILE, "utf8")).device_id ?? null; } catch { return null; }
}
function saveDeviceId(id) {
  try {
    mkdirSync(BRIDGE_HOME, { recursive: true });
    writeFileSync(DEVICE_FILE, JSON.stringify({ device_id: id, device_name: DEVICE_NAME, saved_at: new Date().toISOString() }));
  } catch (e) {
    console.error("[bridge] could not save device id:", e instanceof Error ? e.message : e);
  }
}
let deviceId = process.env.REMOTE_BRIDGE_DEVICE_ID ?? loadDeviceId();

async function api(body, url = API) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Remote-Bridge-Token": BRIDGE_TOKEN,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
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
      const msg = String(p.text ?? "");
      if (process.platform === "darwin") {
        await runProcess("/usr/bin/osascript", [
          "-e",
          'on run argv\ndisplay notification (item 1 of argv) with title "Fendi Control Hub"\nend run',
          msg,
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
    case "imessage_send":
      return imessageSend(p);
    case "imessage_read":
      return imessageRead(p);
    case "capabilities": {
      const caps = await reportCapabilities();
      return { message: "Capabilities reported", exit_code: 0, stdout: JSON.stringify(caps, null, 2) };
    }
    default:
      return { exit_code: 1, stderr: `Unknown command_type: ${command_type}` };
  }
}

let lastCapsAt = 0;
async function reportCapabilities() {
  const caps = await probeCapabilities(WORKDIR);
  if (deviceId) {
    try {
      await api({ action: "bridge_capabilities", device_id: deviceId, capabilities: caps }, HUB_API);
    } catch (e) {
      console.error("[bridge] capability report failed (is agent-hub deployed?):", e instanceof Error ? e.message : e);
    }
  }
  lastCapsAt = Date.now();
  return caps;
}

/** Agent handoffs can take many minutes; run them alongside the poll loop. */
const agentRuns = new Set();
async function runAgentHandoff(cmd) {
  const p = cmd.payload ?? {};
  console.log(`[bridge] agent handoff ${p.handoff_id} -> ${p.cli} (${p.purpose})`);
  const res = await executeAgentHandoff(p, WORKDIR);
  // Save the answer to disk first; then post it. If posting fails it is re-sent on later loops.
  const file = saveResult(BRIDGE_HOME, p.handoff_id, {
    ok: res.ok, body: res.body, error: res.error, session_id: res.session_id ?? null, meta: res.meta ?? {},
  });
  const delivery = await deliverSaved(BRIDGE_HOME, p.handoff_id, (b) => api(b, HUB_API));
  if (delivery !== "delivered") console.error(`[bridge] result for ${p.handoff_id} ${delivery}; kept at ${file}`);
  await api({
    action: "complete", command_id: cmd.id, ok: res.ok,
    result: {
      exit_code: res.ok ? 0 : 1,
      message: delivery === "delivered" ? `Answered handoff ${p.handoff_id}` : `Answer saved on the Mac (${delivery}); will be re-sent`,
      session_id: res.session_id ?? null,
    },
    error: res.ok ? undefined : res.error,
  });
  console.log(`[bridge] agent handoff ${p.handoff_id} ${res.ok ? "answered" : "failed"} (${delivery})`);
}

async function loop() {
  const reg = await api({ action: deviceId ? "heartbeat" : "register", device_name: DEVICE_NAME, device_id: deviceId });
  if (reg.device_id && reg.device_id !== deviceId) saveDeviceId(reg.device_id);
  deviceId = reg.device_id ?? deviceId;
  await flushOutbox(BRIDGE_HOME, (b) => api(b, HUB_API)).catch((e) => console.error("[bridge] outbox flush:", e));
  if (Date.now() - lastCapsAt > CAPS_EVERY_MS) {
    await reportCapabilities();
    pruneWorkspaces(WORKDIR)
      .then((r) => { if (r.removed.length || r.kept.length) console.log(`[bridge] workspaces: removed ${r.removed.length}, kept ${r.kept.length}`, r.kept.slice(0, 5)); })
      .catch((e) => console.error("[bridge] prune:", e));
  }

  // Leave queue rows unclaimed while agent slots are full, so nothing waits behind a long run.
  if (agentRuns.size >= MAX_AGENT_RUNS) return;
  const poll = await api({ action: "poll", device_id: deviceId, limit: 5 });
  for (const cmd of poll.commands ?? []) {
    if (cmd.command_type === "agent_handoff") {
      const job = runAgentHandoff(cmd).catch((e) => console.error("[bridge] agent handoff crashed", e)).finally(() => agentRuns.delete(job));
      agentRuns.add(job);
      continue;
    }
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

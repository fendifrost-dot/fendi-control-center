/**
 * Agent Hub handoffs on the Mac: run Claude Code / Cursor / Codex CLI against the
 * exact revision under review, keep one conversation per Control Center thread,
 * and report the answer back to agent-hub.
 *
 * Each thread gets a stable working directory (~/.fendi-bridge/threads/<thread_id>),
 * so `claude --resume` finds the same session on follow-ups (Claude stores sessions
 * per working directory).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
export const BRIDGE_HOME = process.env.REMOTE_BRIDGE_HOME ?? join(HOME, ".fendi-bridge");
const ALLOW_EDITS = process.env.REMOTE_BRIDGE_ALLOW_EDITS === "1";
const AGENT_TIMEOUT_MS = Number(process.env.REMOTE_BRIDGE_AGENT_TIMEOUT_SEC ?? 1200) * 1000;

/** "owner/repo" -> local checkout path. JSON in REMOTE_BRIDGE_REPOS, else auto-detect WORKDIR. */
function repoMap(workdir) {
  try {
    if (process.env.REMOTE_BRIDGE_REPOS) return JSON.parse(process.env.REMOTE_BRIDGE_REPOS);
  } catch (e) {
    console.error("[bridge] REMOTE_BRIDGE_REPOS is not valid JSON", e);
  }
  const guess = join(workdir, "Projects", "fendi-control-center");
  return existsSync(join(guess, ".git")) ? { "fendifrost-dot/fendi-control-center": guess } : {};
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, shell: false });
    } catch (e) {
      resolve({ stdout: "", stderr: String(e), exit_code: 127 });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (e) => (stderr += String(e)));
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
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

export function which(bin) {
  const dirs = ["/usr/local/bin", "/opt/homebrew/bin", join(HOME, ".local/bin"), join(HOME, ".claude/local"),
    ...(process.env.PATH ?? "").split(":")];
  for (const dir of dirs) {
    const p = join(dir, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Env for agent CLIs: Claude must use the Max login, never an API key. */
function cliEnv(cli) {
  const env = { ...process.env };
  if (cli === "claude") {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

async function prepareWorkspace(payload, workdir) {
  const dir = join(BRIDGE_HOME, "threads", String(payload.thread_id ?? payload.handoff_id));
  const repos = repoMap(workdir);
  const repoPath = payload.repo ? repos[payload.repo] : null;
  const notes = [];
  if (payload.repo && !repoPath) notes.push(`Repo ${payload.repo} has no local checkout mapped in REMOTE_BRIDGE_REPOS; ran without it.`);
  if (repoPath && payload.commit_sha) {
    await run("git", ["-C", repoPath, "fetch", "--quiet", "origin"], { timeoutMs: 120_000 });
    if (!existsSync(join(dir, ".git"))) {
      mkdirSync(join(BRIDGE_HOME, "threads"), { recursive: true });
      const r = await run("git", ["-C", repoPath, "worktree", "add", "--detach", dir, payload.commit_sha], { timeoutMs: 120_000 });
      if (r.exit_code !== 0) throw new Error(`git worktree add failed: ${r.stderr.slice(0, 500)}`);
    } else {
      const r = await run("git", ["-C", dir, "checkout", "--detach", "--force", payload.commit_sha], { timeoutMs: 60_000 });
      if (r.exit_code !== 0) throw new Error(`git checkout ${payload.commit_sha} failed: ${r.stderr.slice(0, 500)}`);
    }
    const head = await run("git", ["-C", dir, "rev-parse", "HEAD"]);
    notes.push(`Checked out ${payload.repo} at ${head.stdout.trim()} in ${dir}.`);
  } else {
    mkdirSync(dir, { recursive: true });
  }
  return { dir, notes };
}

function parseJsonLoose(text) {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const last = t.split("\n").reverse().find((l) => l.trim().startsWith("{"));
  try { return last ? JSON.parse(last) : null; } catch { return null; }
}

async function runClaude(payload, cwd, resume) {
  const bin = which("claude");
  if (!bin) throw new Error("claude CLI not found on this Mac");
  const readOnly = payload.read_only || !ALLOW_EDITS;
  const args = ["-p", "--output-format", "json", "--permission-mode", readOnly ? "plan" : "acceptEdits"];
  if (resume) args.push("--resume", resume);
  const r = await run(bin, args, { cwd, env: cliEnv("claude"), input: payload.prompt, timeoutMs: AGENT_TIMEOUT_MS });
  const out = parseJsonLoose(r.stdout);
  if (!out || out.is_error || r.exit_code !== 0) {
    const err = out?.result ?? r.stderr ?? r.stdout;
    return { ok: false, error: `claude exit ${r.exit_code}: ${String(err).slice(0, 1500)}`, resumeFailed: Boolean(resume) };
  }
  return {
    ok: true, body: String(out.result ?? ""), session_id: out.session_id ?? null,
    meta: { cli: "claude", num_turns: out.num_turns, duration_ms: out.duration_ms, permission_mode: readOnly ? "plan" : "acceptEdits",
      reported_cost_usd: out.total_cost_usd ?? null, note: "Runs on the Claude login (Max); ANTHROPIC_API_KEY is stripped." },
  };
}

async function runCursor(payload, cwd, resume) {
  const agentBin = which("cursor-agent");
  if (agentBin) {
    const args = ["-p", "--output-format", "json"];
    if (resume) args.push("--resume", resume);
    args.push(payload.prompt);
    const r = await run(agentBin, args, { cwd, timeoutMs: AGENT_TIMEOUT_MS });
    const out = parseJsonLoose(r.stdout);
    if (r.exit_code !== 0 || !out) {
      return { ok: false, error: `cursor-agent exit ${r.exit_code}: ${(r.stderr || r.stdout).slice(0, 1500)}`, resumeFailed: Boolean(resume) };
    }
    return { ok: true, body: String(out.result ?? out.text ?? r.stdout), session_id: out.session_id ?? out.chatId ?? null, meta: { cli: "cursor-agent" } };
  }
  const cursor = which("cursor");
  if (!cursor) throw new Error("Cursor CLI (cursor-agent or cursor) not found on this Mac");
  const r = await run(cursor, ["agent", "--print", payload.prompt], { cwd, timeoutMs: AGENT_TIMEOUT_MS });
  if (r.exit_code !== 0) return { ok: false, error: `cursor exit ${r.exit_code}: ${(r.stderr || r.stdout).slice(0, 1500)}` };
  return { ok: true, body: r.stdout, session_id: null, meta: { cli: "cursor agent --print", note: "no session continuity with this CLI form" } };
}

async function runCodex(payload, cwd, resume) {
  const bin = which("codex");
  if (!bin) throw new Error("codex CLI not found on this Mac");
  const readOnly = payload.read_only || !ALLOW_EDITS;
  const args = resume
    ? ["exec", "--json", "resume", resume, "-"]
    : ["exec", "--json", "--sandbox", readOnly ? "read-only" : "workspace-write", "--skip-git-repo-check", "-"];
  const r = await run(bin, args, { cwd, input: payload.prompt, timeoutMs: AGENT_TIMEOUT_MS });
  let sessionId = null;
  let last = "";
  for (const line of r.stdout.split("\n")) {
    const ev = parseJsonLoose(line);
    if (!ev) continue;
    if (ev.type === "thread.started" && ev.thread_id) sessionId = ev.thread_id;
    if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) last = ev.item.text;
  }
  if (r.exit_code !== 0 || !last) {
    return { ok: false, error: `codex exit ${r.exit_code}: ${(r.stderr || r.stdout).slice(-1500)}`, resumeFailed: Boolean(resume) };
  }
  return { ok: true, body: last, session_id: sessionId ?? resume, meta: { cli: "codex", sandbox: readOnly ? "read-only" : "workspace-write" } };
}

const RUNNERS = { claude: runClaude, cursor: runCursor, codex: runCodex };

/** Returns { ok, body?, error?, session_id?, meta } — never throws. */
export async function executeAgentHandoff(payload, workdir) {
  try {
    const runner = RUNNERS[payload.cli];
    if (!runner) return { ok: false, error: `unknown cli ${payload.cli}` };
    const ws = await prepareWorkspace(payload, workdir);
    let res = await runner(payload, ws.dir, payload.resume_session_id);
    if (!res.ok && res.resumeFailed) {
      // The stored session may be gone (CLI reinstalled, history cleared). Start fresh once.
      ws.notes.push(`Could not resume session ${payload.resume_session_id}; started a new one.`);
      res = await runner(payload, ws.dir, null);
    }
    return { ...res, meta: { ...(res.meta ?? {}), workspace: ws.dir, notes: ws.notes } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Delete thread workspaces untouched for 14 days (worktrees are pruned from their repo). */
export async function pruneWorkspaces(workdir) {
  const root = join(BRIDGE_HOME, "threads");
  if (!existsSync(root)) return;
  const cutoff = Date.now() - 14 * 86_400_000;
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    try {
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
  for (const repoPath of Object.values(repoMap(workdir))) {
    await run("git", ["-C", String(repoPath), "worktree", "prune"]);
  }
}

// ---------------------------------------------------------------------------
// iMessage (macOS Messages app)
// ---------------------------------------------------------------------------

const SEND_SCRIPT = `
on run argv
  set targetHandle to item 1 of argv
  set msgText to item 2 of argv
  tell application "Messages"
    try
      set svc to 1st account whose service type = iMessage
      send msgText to participant targetHandle of svc
    on error
      set svc to 1st service whose service type = iMessage
      send msgText to buddy targetHandle of svc
    end try
  end tell
  return "sent"
end run`;

export async function imessageSend(payload) {
  if (process.platform !== "darwin") return { exit_code: 1, stderr: "iMessage needs macOS" };
  const to = String(payload.to ?? "").trim();
  const text = String(payload.text ?? "");
  if (!to || !text) return { exit_code: 1, stderr: "to and text are required" };
  const r = await run("/usr/bin/osascript", ["-e", SEND_SCRIPT, to, text], { timeoutMs: 30_000 });
  return { ...r, message: r.exit_code === 0 ? `Sent to ${to}` : "Send failed (check Automation permission for Messages)" };
}

const CHAT_DB = join(HOME, "Library/Messages/chat.db");

export async function imessageRead(payload) {
  if (process.platform !== "darwin") return { exit_code: 1, stderr: "iMessage needs macOS" };
  const limit = Math.max(1, Math.min(Number(payload.limit ?? 20), 100));
  const handle = payload.handle ? String(payload.handle).replace(/'/g, "''") : null;
  const sql = `SELECT datetime(m.date/1000000000 + 978307200,'unixepoch','localtime') AS at, h.id AS handle,
    m.is_from_me AS from_me, m.text AS text
    FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.text IS NOT NULL ${handle ? `AND h.id = '${handle}'` : ""}
    ORDER BY m.date DESC LIMIT ${limit};`;
  const r = await run("/usr/bin/sqlite3", ["-readonly", "-json", CHAT_DB, sql], { timeoutMs: 20_000 });
  if (r.exit_code !== 0) {
    return { ...r, message: "Could not read Messages history. Grant Full Disk Access to the app running the bridge (Terminal/iTerm/node)." };
  }
  return { ...r, message: `Last ${limit} messages${handle ? ` with ${payload.handle}` : ""}. Messages stored only as rich text on newer macOS may be missing.` };
}

// ---------------------------------------------------------------------------
// Capability probe — what this Mac can actually do, reported to agent-hub.
// ---------------------------------------------------------------------------

async function cliInfo(bin, args = ["--version"]) {
  const p = which(bin);
  if (!p) return null;
  const r = await run(p, args, { timeoutMs: 15_000 });
  return { path: p, version: (r.stdout || r.stderr).trim().split("\n")[0].slice(0, 120) };
}

export async function probeCapabilities(workdir) {
  const caps = {
    platform: process.platform,
    bridge_version: "agent-hub-1",
    claude_cli: await cliInfo("claude"),
    cursor_cli: (await cliInfo("cursor-agent")) ?? (await cliInfo("cursor")),
    codex_cli: await cliInfo("codex"),
    repos: repoMap(workdir),
    allow_edits: ALLOW_EDITS,
    imessage_send: process.platform === "darwin" && existsSync("/usr/bin/osascript"),
    imessage_read: false,
    imessage_read_error: null,
  };
  if (process.platform === "darwin") {
    const r = await run("/usr/bin/sqlite3", ["-readonly", CHAT_DB, "SELECT count(*) FROM message LIMIT 1;"], { timeoutMs: 10_000 });
    caps.imessage_read = r.exit_code === 0;
    if (r.exit_code !== 0) caps.imessage_read_error = (r.stderr || "no access").trim().slice(0, 200);
  }
  return caps;
}

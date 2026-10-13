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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
export const BRIDGE_HOME = process.env.REMOTE_BRIDGE_HOME ?? join(HOME, ".fendi-bridge");
const ALLOW_EDITS = process.env.REMOTE_BRIDGE_ALLOW_EDITS === "1";
const AGENT_TIMEOUT_MS = Number(process.env.REMOTE_BRIDGE_AGENT_TIMEOUT_SEC ?? 1200) * 1000;
const LOCK_POLL_MS = Number(process.env.REMOTE_BRIDGE_LOCK_POLL_MS ?? 2000);

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

// ---------------------------------------------------------------------------
// Thread workspaces (review finding 4): never discard work.
// - A workspace with uncommitted changes, or a detached HEAD no branch contains,
//   is saved on a branch `agent-hub/keep/<thread>-<UTC stamp>` before moving to a new revision.
// - Checkout never uses --force; a refused checkout fails the handoff and changes nothing.
// - Cleanup removes only clean worktrees whose HEAD is on a branch or remote, idle 14+ days,
//   not locked by a running handoff. Everything else is kept and reported.
// Bookkeeping lives beside the workspace (<dir>.meta.json, <dir>.lock) so it never dirties it.
// ---------------------------------------------------------------------------

const KEEP_PREFIX = "agent-hub/keep";
const GIT_ID = ["-c", "user.name=Agent Hub", "-c", "user.email=agent-hub@localhost", "-c", "commit.gpgsign=false"];

function threadsRoot() {
  return join(BRIDGE_HOME, "threads");
}

function metaPath(dir) {
  return `${dir}.meta.json`;
}

function touchMeta(dir, extra = {}) {
  let meta = {};
  try { meta = JSON.parse(readFileSync(metaPath(dir), "utf8")); } catch { /* new */ }
  meta = { ...meta, ...extra, last_used_at: new Date().toISOString() };
  writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2));
}

function readMeta(dir) {
  try { return JSON.parse(readFileSync(metaPath(dir), "utf8")); } catch { return null; }
}

/** Cross-process lock: mkdir is atomic. Returns a release function, or null if held. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

export function lockWorkspace(dir) {
  const lock = `${dir}.lock`;
  // Reclaim a lock left by a bridge process that is no longer running.
  if (existsSync(lock)) {
    let holder = NaN;
    try { holder = Number(readFileSync(join(lock, "pid"), "utf8")); } catch { /* unreadable */ }
    if (Number.isFinite(holder) && !pidAlive(holder)) {
      try { rmSync(join(lock, "pid"), { force: true }); rmdirSync(lock); } catch { /* raced */ }
    }
  }
  try {
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(process.pid));
    return () => { try { rmSync(join(lock, "pid"), { force: true }); rmdirSync(lock); } catch { /* ignore */ } };
  } catch {
    return null;
  }
}

function isLocked(dir) {
  const lock = `${dir}.lock`;
  if (!existsSync(lock)) return false;
  try {
    return pidAlive(Number(readFileSync(join(lock, "pid"), "utf8")));
  } catch {
    return true; // lock without a readable pid: treat as held
  }
}

async function git(dir, args, timeoutMs = 60_000) {
  return run("git", ["-C", dir, ...args], { timeoutMs });
}

/** True when the commit is contained in some local branch or remote-tracking branch. */
async function isRetained(dir, rev = "HEAD") {
  // for-each-ref over real branches only: `git branch --contains` also lists a detached HEAD,
  // which would make an orphan commit look safe.
  const r = await git(dir, ["for-each-ref", "--contains", rev, "--format=%(refname)", "refs/heads", "refs/remotes"]);
  return r.exit_code === 0 && r.stdout.split("\n").some((l) => l.trim());
}

async function isDirty(dir) {
  const r = await git(dir, ["status", "--porcelain", "--untracked-files=all"]);
  if (r.exit_code !== 0) throw new Error(`git status failed in ${dir}: ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim().length > 0;
}

/**
 * Save anything in `dir` that is not already safe on a branch. Returns the branch name, or null
 * if nothing needed saving. Leaves the workspace clean and detached at the saved commit.
 */
export async function preserveWorkspace(dir, label) {
  const dirty = await isDirty(dir);
  const retained = await isRetained(dir);
  if (!dirty && retained) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  const branch = `${KEEP_PREFIX}/${String(label).slice(0, 8)}-${stamp}`;
  let r = await git(dir, ["switch", "-c", branch]);
  if (r.exit_code !== 0) throw new Error(`could not create ${branch}: ${r.stderr.slice(0, 300)}`);
  if (dirty) {
    r = await git(dir, ["add", "-A"]);
    if (r.exit_code !== 0) throw new Error(`git add failed: ${r.stderr.slice(0, 300)}`);
    r = await git(dir, [...GIT_ID, "commit", "--no-verify", "-m", `Agent Hub: keep uncommitted work from thread ${label}`]);
    if (r.exit_code !== 0) throw new Error(`could not commit kept work on ${branch}: ${r.stderr.slice(0, 300)}`);
  }
  r = await git(dir, ["switch", "--detach", branch]);
  if (r.exit_code !== 0) throw new Error(`git switch --detach failed: ${r.stderr.slice(0, 300)}`);
  return branch;
}

async function prepareWorkspace(payload, workdir) {
  const label = String(payload.thread_id ?? payload.handoff_id);
  const dir = join(threadsRoot(), label);
  const repos = repoMap(workdir);
  const repoPath = payload.repo ? repos[payload.repo] : null;
  const notes = [];
  mkdirSync(threadsRoot(), { recursive: true });
  if (payload.repo && !repoPath) notes.push(`Repo ${payload.repo} has no local checkout mapped in REMOTE_BRIDGE_REPOS; ran without it.`);
  if (repoPath && payload.commit_sha) {
    await run("git", ["-C", repoPath, "fetch", "--quiet", "origin"], { timeoutMs: 120_000 });
    if (!existsSync(join(dir, ".git"))) {
      const r = await run("git", ["-C", repoPath, "worktree", "add", "--detach", dir, payload.commit_sha], { timeoutMs: 120_000 });
      if (r.exit_code !== 0) throw new Error(`git worktree add failed: ${r.stderr.slice(0, 500)}`);
    } else {
      const kept = await preserveWorkspace(dir, label);
      if (kept) notes.push(`Saved earlier unretained work in ${dir} on branch ${kept} before switching revision.`);
      const r = await git(dir, ["checkout", "--detach", payload.commit_sha]);
      if (r.exit_code !== 0) throw new Error(`git checkout ${payload.commit_sha} refused; workspace left as it was: ${r.stderr.slice(0, 500)}`);
    }
    const head = await git(dir, ["rev-parse", "HEAD"]);
    notes.push(`Checked out ${payload.repo} at ${head.stdout.trim()} in ${dir}.`);
  } else {
    mkdirSync(dir, { recursive: true });
  }
  touchMeta(dir, { repo: payload.repo ?? null, repo_path: repoPath ?? null, last_handoff_id: payload.handoff_id ?? null });
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
    // One handoff at a time per thread workspace; a second one waits instead of sharing the checkout.
    const dir = join(threadsRoot(), String(payload.thread_id ?? payload.handoff_id));
    mkdirSync(threadsRoot(), { recursive: true });
    const deadline = Date.now() + AGENT_TIMEOUT_MS;
    let release = lockWorkspace(dir);
    while (!release && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
      release = lockWorkspace(dir);
    }
    if (!release) return { ok: false, error: `workspace ${dir} stayed busy with another handoff; retry later` };
    try {
      const ws = await prepareWorkspace(payload, workdir);
      let res = await runner(payload, ws.dir, payload.resume_session_id);
      if (!res.ok && res.resumeFailed) {
        // The stored session may be gone (CLI reinstalled, history cleared). Start fresh once.
        ws.notes.push(`Could not resume session ${payload.resume_session_id}; started a new one.`);
        res = await runner(payload, ws.dir, null);
      }
      touchMeta(ws.dir);
      return { ...res, meta: { ...(res.meta ?? {}), workspace: ws.dir, notes: ws.notes } };
    } finally {
      release();
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Remove idle thread workspaces only when nothing in them would be lost.
 * Returns { removed: [], kept: [{dir, reason}] } so the caller can log what was left alone.
 */
export async function pruneWorkspaces(workdir, { idleDays = 14, now = Date.now() } = {}) {
  const root = threadsRoot();
  const result = { removed: [], kept: [] };
  if (!existsSync(root)) return result;
  const cutoff = now - idleDays * 86_400_000;
  for (const name of readdirSync(root)) {
    if (name.endsWith(".lock") || name.endsWith(".meta.json")) continue;
    const dir = join(root, name);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const keep = (reason) => result.kept.push({ dir, reason });

    const meta = readMeta(dir);
    const lastUsed = meta?.last_used_at ? Date.parse(meta.last_used_at) : NaN;
    if (!Number.isFinite(lastUsed)) { keep("no last-used record; not removing unknown workspace"); continue; }
    if (lastUsed > cutoff) { keep("used recently"); continue; }
    if (isLocked(dir)) { keep("a handoff is running here"); continue; }

    if (existsSync(join(dir, ".git"))) {
      try {
        if (await isDirty(dir)) { keep("uncommitted changes"); continue; }
        if (!(await isRetained(dir))) { keep("HEAD is not on any branch or remote"); continue; }
      } catch (e) {
        keep(`could not inspect: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      // `git worktree remove` without --force refuses anything unclean, as a second guard.
      const repoPath = meta?.repo_path;
      const r = repoPath
        ? await run("git", ["-C", repoPath, "worktree", "remove", dir], { timeoutMs: 60_000 })
        : { exit_code: 1, stderr: "repo path unknown" };
      if (r.exit_code !== 0) { keep(`git worktree remove refused: ${String(r.stderr).trim().slice(0, 200)}`); continue; }
    } else {
      // Plain directory (no repo): only remove when empty.
      if (readdirSync(dir).length > 0) { keep("contains files and is not a git worktree"); continue; }
      try { rmdirSync(dir); } catch (e) { keep(`could not remove: ${e}`); continue; }
    }
    rmSync(metaPath(dir), { force: true });
    result.removed.push(dir);
  }
  for (const repoPath of Object.values(repoMap(workdir))) {
    await run("git", ["-C", String(repoPath), "worktree", "prune"]);
  }
  return result;
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

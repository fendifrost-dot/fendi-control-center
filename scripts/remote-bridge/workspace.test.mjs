// node --test scripts/remote-bridge/
// Review finding 4: thread workspaces never lose work, and cleanup only removes what is safe.
// Review finding 3 (bridge side): an answer survives a failed post and is re-sent safely.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "bridge-ws-"));
const bin = join(root, "bin");
const repo = join(root, "repo");
const home = join(root, "home");
mkdirSync(bin);
mkdirSync(repo);
const g = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
g(repo, "init", "-q", "-b", "main");
g(repo, "config", "user.email", "t@t");
g(repo, "config", "user.name", "t");
writeFileSync(join(repo, "a.txt"), "v1\n");
g(repo, "add", ".");
g(repo, "commit", "-qm", "one");
const sha1 = g(repo, "rev-parse", "HEAD");
writeFileSync(join(repo, "a.txt"), "v2\n");
g(repo, "commit", "-qam", "two");
const sha2 = g(repo, "rev-parse", "HEAD");
// A fake "origin" so `git fetch origin` succeeds offline.
g(repo, "remote", "add", "origin", repo);

// Stand-in claude: optionally edits a file (to simulate an agent leaving work behind).
writeFileSync(join(bin, "claude"), `#!/usr/bin/env bash
cat >/dev/null
if [[ -n "$FAKE_EDIT" ]]; then echo "$FAKE_EDIT" > agent-notes.txt; fi
printf '{"type":"result","is_error":false,"result":"head=%s","session_id":"s1"}' "$(git rev-parse --short HEAD 2>/dev/null)"
`);
chmodSync(join(bin, "claude"), 0o755);

process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.REMOTE_BRIDGE_HOME = home;
process.env.REMOTE_BRIDGE_REPOS = JSON.stringify({ "o/r": repo });
process.env.REMOTE_BRIDGE_LOCK_POLL_MS = "20";

const { executeAgentHandoff, pruneWorkspaces, lockWorkspace } = await import("./agentHandoff.mjs");
const { saveResult, deliverSaved, flushOutbox, outboxDir } = await import("./resultOutbox.mjs");

const ws = (t) => join(home, "threads", t);
const base = (thread, sha, extra = {}) => ({ handoff_id: `h-${thread}`, thread_id: thread, cli: "claude", purpose: "REVIEW", prompt: "p", repo: "o/r", commit_sha: sha, read_only: true, ...extra });
const keepBranches = () => g(repo, "branch", "--list", "agent-hub/keep/*", "--format=%(refname:short)").split("\n").filter(Boolean);

test("uncommitted work in a thread workspace is kept on a branch before switching revision", async () => {
  process.env.FAKE_EDIT = "important unsaved notes";
  const r1 = await executeAgentHandoff(base("t-dirty", sha1), "/x");
  assert.equal(r1.ok, true, r1.error);
  assert.equal(readFileSync(join(ws("t-dirty"), "agent-notes.txt"), "utf8").trim(), "important unsaved notes");
  delete process.env.FAKE_EDIT;

  const before = keepBranches();
  const r2 = await executeAgentHandoff(base("t-dirty", sha2), "/x");
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.body, `head=${sha2.slice(0, 7)}`);
  const kept = keepBranches().filter((b) => !before.includes(b));
  assert.equal(kept.length, 1, "one keep branch created");
  assert.match(kept[0], /^agent-hub\/keep\/t-dirty-/);
  assert.equal(g(repo, "show", `${kept[0]}:agent-notes.txt`), "important unsaved notes");
  assert.ok(r2.meta.notes.some((n) => n.includes(kept[0])), "the run reports where the work went");
});

test("commits made on a detached HEAD are kept before switching", async () => {
  await executeAgentHandoff(base("t-commit", sha1), "/x");
  writeFileSync(join(ws("t-commit"), "b.txt"), "agent commit\n");
  g(ws("t-commit"), "add", ".");
  g(ws("t-commit"), "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-qm", "agent work");
  const orphan = g(ws("t-commit"), "rev-parse", "HEAD");
  const r = await executeAgentHandoff(base("t-commit", sha2), "/x");
  assert.equal(r.ok, true, r.error);
  const holders = g(repo, "branch", "--all", "--contains", orphan, "--format=%(refname:short)");
  assert.match(holders, /agent-hub\/keep\/t-commit-/);
});

test("a clean workspace on a known commit switches without creating keep branches", async () => {
  await executeAgentHandoff(base("t-clean", sha1), "/x");
  const before = keepBranches().length;
  const r = await executeAgentHandoff(base("t-clean", sha2), "/x");
  assert.equal(r.ok, true, r.error);
  assert.equal(keepBranches().length, before);
});

test("checkout never uses --force", () => {
  const src = readFileSync(new URL("./agentHandoff.mjs", import.meta.url), "utf8");
  const forced = [...src.matchAll(/\[[^\]]*"(checkout|switch|worktree)"[^\]]*\]/g)].filter((m) => /"--force"|"-f"/.test(m[0]));
  assert.deepEqual(forced, []);
});

test("a second handoff for the same thread waits for the first instead of sharing the checkout", async () => {
  mkdirSync(join(home, "threads"), { recursive: true });
  const release = lockWorkspace(ws("t-lock"));
  assert.ok(release);
  let done = false;
  const pending = executeAgentHandoff(base("t-lock", sha1), "/x").then((r) => { done = true; return r; });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(done, false, "waits while the lock is held");
  release();
  const r = await pending;
  assert.equal(r.ok, true, r.error);
});

test("a lock left by a dead process is reclaimed", async () => {
  mkdirSync(`${ws("t-stale")}.lock`, { recursive: true });
  writeFileSync(join(`${ws("t-stale")}.lock`, "pid"), "999999");
  const r = await executeAgentHandoff(base("t-stale", sha1), "/x");
  assert.equal(r.ok, true, r.error);
});

test("cleanup removes only idle, clean, retained worktrees and reports the rest", async () => {
  // t-old-clean: clean, idle, HEAD on main -> removable
  await executeAgentHandoff(base("t-old-clean", sha1), "/x");
  // t-old-dirty: idle but has uncommitted changes -> kept
  await executeAgentHandoff(base("t-old-dirty", sha1), "/x");
  writeFileSync(join(ws("t-old-dirty"), "wip.txt"), "wip\n");
  // t-old-orphan: idle, clean, but HEAD only on a detached commit -> kept
  await executeAgentHandoff(base("t-old-orphan", sha1), "/x");
  writeFileSync(join(ws("t-old-orphan"), "c.txt"), "c\n");
  g(ws("t-old-orphan"), "add", ".");
  g(ws("t-old-orphan"), "-c", "user.name=a", "-c", "user.email=a@a", "commit", "-qm", "orphan");
  // plain directory with files, no repo -> kept
  mkdirSync(ws("t-plain"), { recursive: true });
  writeFileSync(join(ws("t-plain"), "note.md"), "x");
  writeFileSync(`${ws("t-plain")}.meta.json`, JSON.stringify({ last_used_at: "2026-01-01T00:00:00Z" }));
  // unknown directory without a last-used record -> kept
  mkdirSync(ws("t-unknown"), { recursive: true });

  const future = Date.now() + 30 * 86_400_000; // everything is "idle" 30 days from now
  const res = await pruneWorkspaces("/x", { now: future });
  const keptReason = (t) => res.kept.find((k) => k.dir === ws(t))?.reason;

  assert.ok(res.removed.includes(ws("t-old-clean")), "clean retained worktree removed");
  assert.equal(existsSync(ws("t-old-clean")), false);
  assert.equal(keptReason("t-old-dirty"), "uncommitted changes");
  assert.equal(readFileSync(join(ws("t-old-dirty"), "wip.txt"), "utf8"), "wip\n");
  assert.equal(keptReason("t-old-orphan"), "HEAD is not on any branch or remote");
  assert.equal(keptReason("t-plain"), "contains files and is not a git worktree");
  assert.match(keptReason("t-unknown"), /no last-used record/);
});

test("cleanup leaves recently used and running workspaces alone", async () => {
  await executeAgentHandoff(base("t-recent", sha1), "/x");
  const res = await pruneWorkspaces("/x");
  assert.equal(res.kept.find((k) => k.dir === ws("t-recent"))?.reason, "used recently");
  const release = lockWorkspace(ws("t-recent"));
  const later = await pruneWorkspaces("/x", { now: Date.now() + 30 * 86_400_000 });
  assert.equal(later.kept.find((k) => k.dir === ws("t-recent"))?.reason, "a handoff is running here");
  release();
});

// ---------------------------------------------------------------------------
// Result outbox
// ---------------------------------------------------------------------------
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const noSleep = { sleep: async () => {} };

test("an answer is saved before posting and survives a failed post", async () => {
  saveResult(home, "h-net", { ok: true, body: "the review" });
  const r = await deliverSaved(home, "h-net", async () => { throw new Error("network down"); }, noSleep);
  assert.equal(r, "pending");
  assert.ok(existsSync(join(outboxDir(home), "h-net.json")), "answer still on disk");
});

test("the next loop re-sends it, and the file is removed only after the hub accepts it", async () => {
  const sent = [];
  const out = await flushOutbox(home, async (b) => { sent.push(b); return { ok: true, duplicate: sent.length > 1 }; });
  assert.equal(out["h-net"], "delivered");
  assert.equal(sent[0].action, "bridge_result");
  assert.equal(sent[0].handoff_id, "h-net");
  assert.equal(sent[0].body, "the review");
  assert.equal(existsSync(join(outboxDir(home), "h-net.json")), false);
});

test("5xx and 429 are retried; a final refusal is kept as .rejected.json, never deleted", async () => {
  saveResult(home, "h-5xx", { ok: true, body: "x" });
  let calls = 0;
  assert.equal(await deliverSaved(home, "h-5xx", async () => { calls++; throw httpError(calls < 3 ? 503 : 429); }, noSleep), "pending");
  assert.equal(calls, 3);
  saveResult(home, "h-400", { ok: true, body: "y" });
  assert.equal(await deliverSaved(home, "h-400", async () => { throw httpError(400); }, noSleep), "rejected");
  assert.ok(readdirSync(outboxDir(home)).includes("h-400.rejected.json"));
  const flushed = await flushOutbox(home, async () => ({ ok: true }));
  assert.equal(flushed["h-400"], undefined, "rejected files are not re-sent automatically");
});

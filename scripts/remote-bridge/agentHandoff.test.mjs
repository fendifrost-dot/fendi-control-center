// node --test scripts/remote-bridge/agentHandoff.test.mjs
// Uses a stand-in `claude` CLI so it runs anywhere (no Claude login needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "bridge-test-"));
const bin = join(root, "bin");
const repo = join(root, "repo");
mkdirSync(bin);
mkdirSync(repo);
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
git("init", "-q");
git("config", "user.email", "t@t");
git("config", "user.name", "t");
writeFileSync(join(repo, "a.txt"), "v1\n");
git("add", ".");
git("commit", "-qm", "one");
const sha = git("rev-parse", "HEAD");
writeFileSync(join(repo, "a.txt"), "v2\n");
git("commit", "-qam", "two");

writeFileSync(join(bin, "claude"), `#!/usr/bin/env bash
input=$(cat)
if [[ -n "$ANTHROPIC_API_KEY" ]]; then echo '{"is_error":true,"result":"api key leaked"}'; exit 1; fi
resume=""; mode=""; while [[ $# -gt 0 ]]; do [[ "$1" == "--resume" ]] && resume="$2"; [[ "$1" == "--permission-mode" ]] && mode="$2"; shift; done
printf '{"type":"result","is_error":false,"result":"file=%s resume=%s mode=%s","session_id":"sess-1"}' "$(cat a.txt)" "$resume" "$mode"
`);
chmodSync(join(bin, "claude"), 0o755);

process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.ANTHROPIC_API_KEY = "sk-must-be-stripped";
process.env.REMOTE_BRIDGE_HOME = join(root, "home");
process.env.REMOTE_BRIDGE_REPOS = JSON.stringify({ "o/r": repo });

const { executeAgentHandoff } = await import("./agentHandoff.mjs");
const base = { handoff_id: "h1", thread_id: "t1", cli: "claude", purpose: "REVIEW", prompt: "review", repo: "o/r", commit_sha: sha, read_only: true };

test("review runs on the exact commit, read-only, on the Claude login (no API key)", async () => {
  const r = await executeAgentHandoff(base, "/nonexistent");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.body, "file=v1 resume= mode=plan");
  assert.equal(r.session_id, "sess-1");
});

test("a follow-up in the same thread resumes the stored session in the same directory", async () => {
  const r = await executeAgentHandoff({ ...base, resume_session_id: "sess-1" }, "/nonexistent");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.body, "file=v1 resume=sess-1 mode=plan");
});

test("unknown CLI fails cleanly instead of throwing", async () => {
  const r = await executeAgentHandoff({ ...base, cli: "nope" }, "/nonexistent");
  assert.equal(r.ok, false);
});

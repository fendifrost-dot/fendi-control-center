/**
 * Durable result outbox for the Mac bridge (review finding 3, bridge side).
 *
 * An agent run can take 20 minutes; its answer must not be lost because posting it back
 * failed once (network drop, edge function cold start, deploy in progress).
 *
 * - The answer is written to disk BEFORE the first post: <BRIDGE_HOME>/outbox/<handoff>.json
 * - Retryable failures (network, 5xx, 408, 429) leave the file for the next loop.
 * - agent-hub records answers idempotently, so re-posting the same answer is safe: a repeat
 *   comes back as `duplicate` instead of creating a second message.
 * - A final refusal (other 4xx) moves the file to <handoff>.rejected.json; it is never deleted.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function outboxDir(bridgeHome) {
  return join(bridgeHome, "outbox");
}

export function saveResult(bridgeHome, handoffId, payload) {
  const dir = outboxDir(bridgeHome);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${handoffId}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...payload, handoff_id: handoffId, saved_at: new Date().toISOString() }));
  renameSync(tmp, file); // atomic on the same filesystem
  return file;
}

function isRetryable(err) {
  const status = err?.status;
  if (status === undefined || status === null) return true; // network error, no HTTP response
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Try to post one saved result. `post(body)` throws an Error with `.status` on HTTP errors.
 * Returns "delivered" | "pending" | "rejected".
 */
export async function deliverSaved(bridgeHome, handoffId, post, { attempts = 3, backoffMs = 2000, sleep } = {}) {
  const file = join(outboxDir(bridgeHome), `${handoffId}.json`);
  if (!existsSync(file)) return "delivered";
  const payload = JSON.parse(readFileSync(file, "utf8"));
  const { saved_at: _saved, ...body } = payload;
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    try {
      await post({ action: "bridge_result", ...body });
      rmSync(file, { force: true });
      return "delivered";
    } catch (e) {
      if (!isRetryable(e)) {
        renameSync(file, join(outboxDir(bridgeHome), `${handoffId}.rejected.json`));
        return "rejected";
      }
      if (i < attempts - 1) await wait(backoffMs * 2 ** i);
    }
  }
  return "pending";
}

/** Re-send everything still waiting. One attempt each per call; the poll loop calls it again. */
export async function flushOutbox(bridgeHome, post, opts = {}) {
  const dir = outboxDir(bridgeHome);
  if (!existsSync(dir)) return {};
  const out = {};
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name.endsWith(".rejected.json")) continue;
    const id = name.slice(0, -".json".length);
    out[id] = await deliverSaved(bridgeHome, id, post, { attempts: 1, ...opts });
  }
  return out;
}

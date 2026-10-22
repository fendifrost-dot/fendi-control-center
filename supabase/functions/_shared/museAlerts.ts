/**
 * Muse workboard alerts.
 *
 * The board row is the source of truth. Grok hears a post by pulling it:
 * a schedule routine calls GET muse-alerts. No webhook URL is required.
 * Desktop 0.75.0 still shows only the routine's on/off toggle, so a URL
 * copied from that panel is not part of the setup. Webhook delivery stays
 * available for a host that already has an https endpoint.
 *
 * Mail to a Grok address is not a wake. New mail does not start a routine
 * on its own, spam drops the body, and a send still waits for a person to
 * press Send. This module does not call Resend.
 *
 * Claude's cloud session cannot be woken. A board assignment tagged for
 * Claude is also copied into the agent-hub inbox Claude already checks.
 */

export const ALERT_ROLES = ["audit", "coding", "testing", "execution"] as const;
export type AlertRole = (typeof ALERT_ROLES)[number];
export type AlertDelivery = "webhook" | "pull";
export type AlertSource =
  | "muse_work_updates"
  | "muse_improvement_tasks"
  | "muse_daily_reports";

const AGENT_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export interface AlertEvent {
  source_table: AlertSource;
  source_id: string;
  created_at: string;
  actor: string;
  addressed_agent: string | null;
  addressed_role: AlertRole | null;
  /** Names pulled from @mentions, "ASSIGNED TO", and assignment "For" lines. */
  targets: string[];
  kind: string;
  message: string;
  mission_id: string | null;
  improvement_id: string | null;
  task_id: string | null;
  domain_key: string | null;
  evidence_ref: string | null;
}

export interface AlertSubscriber {
  id: string;
  agent_key: string;
  roles: AlertRole[];
  aliases: string[];
  delivery: AlertDelivery;
  enabled: boolean;
  /** Open-queue pulls start after this instant, so a new subscriber does not replay the archive. */
  created_at?: string;
}

/** Seeded roster. The migration inserts the same keys, roles, and aliases. */
export const BOARD_ROSTER: Array<{ agent_key: string; roles: AlertRole[]; aliases: string[] }> = [
  { agent_key: "grok-bot", roles: ["testing"], aliases: ["Grok Bot", "Grok"] },
  { agent_key: "claude-code", roles: ["coding"], aliases: ["Claude", "Cursor", "claude-code", "claude-code-cloud"] },
  { agent_key: "chatgpt", roles: ["audit"], aliases: ["ChatGPT"] },
  { agent_key: "enki", roles: ["execution"], aliases: ["Enki", "Muse"] },
];

export const CLAUDE_INBOX_AGENT = "claude-code-cloud";

const TAG_NAMES: string[] = (() => {
  const raw = [
    ...BOARD_ROSTER.flatMap((agent) => agent.aliases),
    ...BOARD_ROSTER.map((agent) => agent.agent_key),
  ];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of raw) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }
  return unique.sort((a, b) => b.length - a.length);
})();

export interface AlertCursor {
  at: string;
  id: string | null;
}

export interface SubscriberPublic {
  agent_key: string;
  roles: AlertRole[];
  aliases: string[];
  delivery: AlertDelivery;
  enabled: boolean;
  webhook_host: string | null;
  webhook_key_hint: string | null;
}

export interface AlertSummary {
  matched: number;
  pull: number;
  enqueued: number;
  delivered: number;
  pending: number;
  failed: number;
}

export function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

export function sameAgent(
  subscriber: Pick<AlertSubscriber, "agent_key" | "aliases">,
  label: string,
): boolean {
  const needle = normalizeLabel(label);
  if (!needle) return false;
  if (needle === subscriber.agent_key) return true;
  return subscriber.aliases.some((alias) => normalizeLabel(alias) === needle);
}

/**
 * True when this subscriber should hear about the event.
 * The actor never hears about their own post, even if they addressed
 * their own role. That is the loop break.
 */
export function eventAddresses(
  subscriber: AlertSubscriber,
  event: Pick<AlertEvent, "actor" | "addressed_agent" | "addressed_role" | "targets">,
): boolean {
  if (!subscriber.enabled) return false;
  if (sameAgent(subscriber, event.actor)) return false;
  const byAgent = Boolean(event.addressed_agent) && sameAgent(subscriber, event.addressed_agent as string);
  const byRole = Boolean(event.addressed_role) && subscriber.roles.includes(event.addressed_role as AlertRole);
  const byTag = (event.targets ?? []).some((tag) => sameAgent(subscriber, tag));
  return byAgent || byRole || byTag;
}

/**
 * True when this board post or task should land in Claude's agent-hub inbox.
 * Claude's cloud session already polls that inbox. It has no webhook to call.
 */
export function codingInboxWanted(event: AlertEvent, subscribers: AlertSubscriber[]): boolean {
  if (event.source_table !== "muse_work_updates" && event.source_table !== "muse_improvement_tasks") return false;
  const coding = subscribers.filter((row) => row.enabled && row.roles.includes("coding"));
  return coding.some((row) => eventAddresses(row, event));
}

function matchTagAt(text: string, index: number): string | null {
  const rest = text.slice(index);
  for (const name of TAG_NAMES) {
    if (rest.length < name.length) continue;
    if (rest.slice(0, name.length).toLowerCase() !== name.toLowerCase()) continue;
    const next = rest[name.length] ?? "";
    if (next && /[A-Za-z0-9_]/.test(next)) continue;
    return name;
  }
  return null;
}

function remember(found: string[], seen: Set<string>, name: string | null) {
  if (!name) return;
  const key = name.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  found.push(name);
}

/**
 * Names the board already uses. Instagram @handles are ignored because they
 * are not agent aliases. A bare "Claude" in a sentence is not a tag.
 * "For …" is only read on ASSIGNMENT rows, which is how the packs address Enki.
 */
export function extractBoardTags(message: string, kind: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < message.length; i++) {
    if (message[i] !== "@") continue;
    remember(found, seen, matchTagAt(message, i + 1));
  }
  const lead = /(?:assigned\s+to|reply\s+to)\s*:?\s+/gi;
  for (const hit of message.matchAll(lead)) {
    const at = (hit.index ?? 0) + hit[0].length;
    let cursor = at;
    while (cursor < message.length && /[\s*]/.test(message[cursor])) cursor++;
    remember(found, seen, matchTagAt(message, cursor));
  }
  if (kind === "ASSIGNMENT") {
    const forLine = /\bfor\s+([^\n:]{1,80})/gi;
    for (const hit of message.matchAll(forLine)) {
      const segment = hit[1] ?? "";
      for (const piece of segment.split("/")) {
        const cleaned = piece.replace(/[*_`]/g, "").trim();
        let cursor = 0;
        while (cursor < cleaned.length && /[\s*]/.test(cleaned[cursor])) cursor++;
        remember(found, seen, matchTagAt(cleaned, cursor));
      }
    }
    const shouted = /(?:^|\n)\s*([A-Za-z][A-Za-z0-9 ._-]{0,40})\s*:/g;
    for (const hit of message.matchAll(shouted)) {
      const label = (hit[1] ?? "").trim();
      remember(found, seen, matchTagAt(label, 0) === label || matchTagAt(label, 0)?.toLowerCase() === label.toLowerCase()
        ? matchTagAt(label, 0)
        : null);
    }
  }
  return found;
}

export function addressedAgent(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("addressed_agent_rejected");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!ALIAS.test(trimmed)) throw new Error("addressed_agent_rejected");
  return trimmed;
}

export function addressedRole(value: unknown): AlertRole | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !(ALERT_ROLES as readonly string[]).includes(value)) {
    throw new Error("addressed_role_rejected");
  }
  return value as AlertRole;
}

/** Only the fields that were set. An unaddressed write must not mention the new columns. */
export function addressPatch(
  agent: string | null,
  role: AlertRole | null,
): { addressed_agent?: string; addressed_role?: AlertRole } {
  const patch: { addressed_agent?: string; addressed_role?: AlertRole } = {};
  if (agent) patch.addressed_agent = agent;
  if (role) patch.addressed_role = role;
  return patch;
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function roleOrNull(value: unknown): AlertRole | null {
  return typeof value === "string" && (ALERT_ROLES as readonly string[]).includes(value)
    ? value as AlertRole
    : null;
}

function eventBase(row: Record<string, unknown>, source: AlertSource, actor: string, message: string): AlertEvent | null {
  const sourceId = textOrNull(row.id);
  const createdAt = textOrNull(row.created_at);
  if (!sourceId || !UUID.test(sourceId) || !createdAt || Number.isNaN(Date.parse(createdAt))) return null;
  return {
    source_table: source,
    source_id: sourceId,
    created_at: new Date(createdAt).toISOString(),
    actor,
    addressed_agent: null,
    addressed_role: null,
    targets: [],
    kind: "NOTE",
    message: message.slice(0, 8000),
    mission_id: textOrNull(row.mission_id),
    improvement_id: textOrNull(row.improvement_id),
    task_id: textOrNull(row.task_id),
    domain_key: textOrNull(row.domain_key),
    evidence_ref: textOrNull(row.evidence_ref),
  };
}

function addressedEvent(
  event: AlertEvent | null,
  agent: string | null,
  role: AlertRole | null,
  kind: string,
): AlertEvent | null {
  if (!event) return null;
  event.addressed_agent = agent;
  event.addressed_role = role;
  event.kind = kind;
  event.targets = extractBoardTags(event.message, event.kind);
  if (!agent && !role && event.targets.length === 0) return null;
  return event;
}

export function eventFromAction(action: string, row: unknown, actor: string): AlertEvent | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  if (action === "append_update") {
    const message = textOrNull(record.message);
    if (!message) return null;
    return addressedEvent(
      eventBase(record, "muse_work_updates", actor, message),
      textOrNull(record.addressed_agent),
      roleOrNull(record.addressed_role),
      textOrNull(record.update_type) ?? "NOTE",
    );
  }
  if (action === "record_daily_report") {
    const message = textOrNull(record.message);
    if (!message) return null;
    const event = addressedEvent(
      eventBase(record, "muse_daily_reports", actor, message),
      textOrNull(record.addressed_agent),
      roleOrNull(record.addressed_role),
      textOrNull(record.cadence) ?? "END_OF_DAY",
    );
    if (!event) return null;
    event.mission_id = null;
    event.improvement_id = null;
    event.task_id = null;
    return event;
  }
  if (action === "create_task") {
    const message = [record.title, record.objective, record.instructions]
      .map(textOrNull)
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
    if (!message) return null;
    const assigner = textOrNull(record.assigning_agent) ?? actor;
    const event = addressedEvent(
      eventBase(record, "muse_improvement_tasks", assigner, message),
      textOrNull(record.executor),
      roleOrNull(record.addressed_role),
      "TASK",
    );
    if (!event) return null;
    event.task_id = event.source_id;
    event.evidence_ref = textOrNull(record.source_ref);
    return event;
  }
  return null;
}

export interface PlannedWebhook {
  subscriber_id: string;
  agent_key: string;
  dedupe_key: string;
  payload: Record<string, unknown>;
}

export function alertBody(event: AlertEvent, outboxId: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = {
    event: "muse.alert",
    source_table: event.source_table,
    source_id: event.source_id,
    created_at: event.created_at,
    actor: event.actor,
    addressed_agent: event.addressed_agent,
    addressed_role: event.addressed_role,
    targets: event.targets,
    kind: event.kind,
    message: event.message,
    mission_id: event.mission_id,
    improvement_id: event.improvement_id,
    task_id: event.task_id,
    domain_key: event.domain_key,
    evidence_ref: event.evidence_ref,
    reply: {
      method: "POST",
      path: "/functions/v1/muse-workboard",
      action: "append_update",
      fields: ["mission_id", "task_id", "improvement_id", "update_type", "message", "addressed_agent", "addressed_role"],
    },
  };
  if (outboxId) body.outbox_id = outboxId;
  return body;
}

export function planFanout(event: AlertEvent, subscribers: AlertSubscriber[]): {
  pull: string[];
  webhook: PlannedWebhook[];
} {
  const pull: string[] = [];
  const webhook: PlannedWebhook[] = [];
  const seen = new Set<string>();
  for (const subscriber of subscribers) {
    if (!eventAddresses(subscriber, event) || seen.has(subscriber.id)) continue;
    seen.add(subscriber.id);
    if (subscriber.delivery === "pull") {
      pull.push(subscriber.agent_key);
      continue;
    }
    webhook.push({
      subscriber_id: subscriber.id,
      agent_key: subscriber.agent_key,
      dedupe_key: `${event.source_table}:${event.source_id}:${subscriber.id}`,
      payload: alertBody(event, null),
    });
  }
  return { pull, webhook };
}

export function compareEventOrder(
  a: Pick<AlertEvent, "created_at" | "source_id">,
  b: Pick<AlertEvent, "created_at" | "source_id">,
): number {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  if (ta !== tb) return ta - tb;
  if (a.source_id < b.source_id) return -1;
  if (a.source_id > b.source_id) return 1;
  return 0;
}

/** Exclusive cursor. No id means "after this instant", so a same-millisecond row waits for an id. */
export function isAfterCursor(
  row: Pick<AlertEvent, "created_at" | "source_id">,
  cursor: AlertCursor,
): boolean {
  const ta = Date.parse(row.created_at);
  const tc = Date.parse(cursor.at);
  if (Number.isNaN(ta) || Number.isNaN(tc)) return false;
  if (ta > tc) return true;
  if (ta < tc) return false;
  if (!cursor.id) return false;
  return row.source_id > cursor.id;
}

export function webhookEndpoint(raw: string): { url: string; host: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("webhook_url_rejected");
  }
  if (parsed.protocol !== "https:") throw new Error("webhook_url_rejected");
  if (parsed.username || parsed.password) throw new Error("webhook_url_rejected");
  if (parsed.port && parsed.port !== "443") throw new Error("webhook_url_rejected");
  if (parsed.search || parsed.hash) throw new Error("webhook_url_rejected");
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("webhook_url_rejected");
  if (host === "localhost" || host === "metadata.google.internal") throw new Error("webhook_url_rejected");
  if (isBlockedIp(host)) throw new Error("webhook_url_rejected");
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return { url: parsed.toString(), host: parsed.hostname.toLowerCase() };
}

function isBlockedIp(host: string): boolean {
  if (host === "::1" || host === "0.0.0.0") return true;
  const lower = host.toLowerCase();
  if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")) return true;
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!parts) return false;
  const nums = parts.slice(1).map((part) => Number(part));
  if (nums.some((n) => n > 255)) return true;
  const [a, b] = nums;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function parseWebhookKey(value: unknown): string {
  if (typeof value !== "string") throw new Error("webhook_key_rejected");
  const key = value.trim();
  if (key.length < 16 || key.length > 256) throw new Error("webhook_key_rejected");
  if (/\s/.test(key) || /^bearer\s+/i.test(key)) throw new Error("webhook_key_rejected");
  return key;
}

export function keyHint(key: string): string {
  return key.slice(-4);
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Copy into a fresh ArrayBuffer so WebCrypto accepts the view under Deno's stricter BufferSource. */
function tightBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function b64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function importSealKey(b64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = b64ToBytes(b64.trim());
  } catch {
    throw new Error("seal_key_invalid");
  }
  if (raw.byteLength !== 32) throw new Error("seal_key_invalid");
  return crypto.subtle.importKey("raw", tightBytes(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function readSealKey(raw: string | null | undefined): Promise<CryptoKey | null> {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  return importSealKey(trimmed);
}

export async function sealText(plain: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    tightBytes(new TextEncoder().encode(plain)),
  ));
  const out = new Uint8Array(1 + iv.byteLength + cipher.byteLength);
  out[0] = 1;
  out.set(iv, 1);
  out.set(cipher, 13);
  return bytesToB64(out);
}

export async function openText(sealed: string, key: CryptoKey): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = b64ToBytes(sealed);
  } catch {
    throw new Error("seal_corrupt");
  }
  if (bytes[0] !== 1 || bytes.byteLength < 14) throw new Error("seal_corrupt");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: tightBytes(bytes.slice(1, 13)) },
      key,
      tightBytes(bytes.slice(13)),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("seal_corrupt");
  }
}

export const RETRY_DELAYS_SECONDS = [30, 120, 600, 1800, 7200] as const;
export const MAX_ATTEMPTS = 5;

export function classifyDelivery(httpStatus: number | null, transportError: boolean): {
  outcome: "delivered" | "retry" | "fail";
  error_code: string | null;
} {
  if (transportError || httpStatus === null) return { outcome: "retry", error_code: "network" };
  if (httpStatus >= 200 && httpStatus < 300) return { outcome: "delivered", error_code: null };
  if (httpStatus === 401 || httpStatus === 403) return { outcome: "fail", error_code: "http_401" };
  if (httpStatus === 400) return { outcome: "fail", error_code: "rejected" };
  if (httpStatus === 404 || httpStatus === 410) return { outcome: "fail", error_code: "http_404" };
  if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) {
    return { outcome: "retry", error_code: `http_${httpStatus}` };
  }
  return { outcome: "fail", error_code: `http_${httpStatus}` };
}

export function nextAttemptIso(attemptsAfterFailure: number, nowMs: number): string | null {
  if (attemptsAfterFailure >= MAX_ATTEMPTS) return null;
  const delay = RETRY_DELAYS_SECONDS[attemptsAfterFailure - 1] ?? RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1];
  return new Date(nowMs + delay * 1000).toISOString();
}

export interface DeliveryDecision {
  status: "pending" | "delivered" | "failed";
  error_code: string | null;
  http_status: number | null;
  next_attempt_at: string;
  delivered_at: string | null;
}

export function decideDelivery(
  httpStatus: number | null,
  transportError: boolean,
  attempts: number,
  nowMs: number,
): DeliveryDecision {
  const classified = classifyDelivery(httpStatus, transportError);
  const nowIso = new Date(nowMs).toISOString();
  if (classified.outcome === "delivered") {
    return { status: "delivered", error_code: null, http_status: httpStatus, next_attempt_at: nowIso, delivered_at: nowIso };
  }
  if (classified.outcome === "fail") {
    return {
      status: "failed",
      error_code: classified.error_code,
      http_status: httpStatus,
      next_attempt_at: nowIso,
      delivered_at: null,
    };
  }
  const next = nextAttemptIso(attempts, nowMs);
  if (!next) {
    return {
      status: "failed",
      error_code: classified.error_code,
      http_status: httpStatus,
      next_attempt_at: nowIso,
      delivered_at: null,
    };
  }
  return {
    status: "pending",
    error_code: classified.error_code,
    http_status: httpStatus,
    next_attempt_at: next,
    delivered_at: null,
  };
}

export async function postWebhook(opts: {
  url: string;
  bearer: string;
  body: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ http_status: number | null; transportError: boolean }> {
  const endpoint = webhookEndpoint(opts.url);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 4000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint.url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${opts.bearer}`,
        "user-agent": "muse-alerts",
      },
      body: JSON.stringify(opts.body),
    });
    await response.body?.cancel().catch(() => undefined);
    return { http_status: response.status, transportError: false };
  } catch {
    return { http_status: null, transportError: true };
  } finally {
    clearTimeout(timer);
  }
}

export function parseAgentKey(value: unknown): string {
  if (typeof value !== "string" || !AGENT_KEY.test(value)) throw new Error("agent_key_rejected");
  return value;
}

export function parseRoles(value: unknown): AlertRole[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > ALERT_ROLES.length) throw new Error("roles_rejected");
  const out: AlertRole[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !(ALERT_ROLES as readonly string[]).includes(item)) throw new Error("roles_rejected");
    const role = item as AlertRole;
    if (!out.includes(role)) out.push(role);
  }
  return out;
}

export function parseAliases(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error("aliases_rejected");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw new Error("aliases_rejected");
    const trimmed = item.trim();
    if (!ALIAS.test(trimmed)) throw new Error("aliases_rejected");
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export interface RegisterInput {
  agent_key: string;
  roles: AlertRole[];
  aliases: string[];
  delivery: AlertDelivery;
  enabled: boolean;
  webhook_url: string | null;
  webhook_key: string | null;
}

function deliveryOf(value: unknown): AlertDelivery {
  if (value !== "webhook" && value !== "pull") throw new Error("delivery_rejected");
  return value;
}

export function parseRegister(payload: unknown): RegisterInput {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload_rejected");
  const raw = payload as Record<string, unknown>;
  const delivery = deliveryOf(raw.delivery);
  const hasUrl = raw.webhook_url !== undefined && raw.webhook_url !== null && raw.webhook_url !== "";
  const hasKey = raw.webhook_key !== undefined && raw.webhook_key !== null && raw.webhook_key !== "";
  if (delivery === "pull" && (hasUrl || hasKey)) throw new Error("pull_rejects_webhook");
  if (delivery === "webhook" && (!hasUrl || !hasKey)) throw new Error("webhook_incomplete");
  if (hasUrl && typeof raw.webhook_url !== "string") throw new Error("webhook_url_rejected");
  if (hasKey && typeof raw.webhook_key !== "string") throw new Error("webhook_key_rejected");
  const webhookUrl = hasUrl ? webhookEndpoint(raw.webhook_url as string).url : null;
  const webhookKey = hasKey ? parseWebhookKey(raw.webhook_key) : null;
  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof enabled !== "boolean") throw new Error("enabled_rejected");
  return {
    agent_key: parseAgentKey(raw.agent_key),
    roles: parseRoles(raw.roles),
    aliases: parseAliases(raw.aliases),
    delivery,
    enabled,
    webhook_url: webhookUrl,
    webhook_key: webhookKey,
  };
}

export interface UpdateInput {
  agent_key: string;
  roles?: AlertRole[];
  aliases?: string[];
  delivery?: AlertDelivery;
  enabled?: boolean;
  webhook_url?: string;
  webhook_key?: string;
}

export function parseUpdate(payload: unknown): UpdateInput {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload_rejected");
  const raw = payload as Record<string, unknown>;
  const update: UpdateInput = { agent_key: parseAgentKey(raw.agent_key) };
  if (raw.roles !== undefined) update.roles = parseRoles(raw.roles);
  if (raw.aliases !== undefined) update.aliases = parseAliases(raw.aliases);
  if (raw.delivery !== undefined) update.delivery = deliveryOf(raw.delivery);
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new Error("enabled_rejected");
    update.enabled = raw.enabled;
  }
  if (raw.webhook_url !== undefined && raw.webhook_url !== null) {
    if (typeof raw.webhook_url !== "string") throw new Error("webhook_url_rejected");
    update.webhook_url = webhookEndpoint(raw.webhook_url).url;
  }
  if (raw.webhook_key !== undefined && raw.webhook_key !== null) update.webhook_key = parseWebhookKey(raw.webhook_key);
  if ((update.webhook_url && !update.webhook_key) || (!update.webhook_url && update.webhook_key)) {
    throw new Error("webhook_incomplete");
  }
  const fields = ["roles", "aliases", "delivery", "enabled", "webhook_url", "webhook_key"] as const;
  if (!fields.some((field) => update[field] !== undefined)) throw new Error("update_empty");
  return update;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function subscriberFromToken(label: string, row: AlertSubscriber | null): AlertSubscriber {
  if (row) return row;
  const agentKey = AGENT_KEY.test(label) ? label : "unknown";
  return {
    id: "00000000-0000-4000-8000-000000000000",
    agent_key: agentKey,
    roles: [],
    aliases: agentKey === label ? [] : [label],
    delivery: "pull",
    enabled: true,
  };
}

export function parseCursor(since: string | null, sinceId: string | null): AlertCursor {
  if (since === null) throw new Error("since_required");
  const trimmed = since.trim();
  if (!ISO_Z.test(trimmed) || Number.isNaN(Date.parse(trimmed))) throw new Error("since_rejected");
  const at = new Date(trimmed).toISOString();
  if (sinceId === null || sinceId.trim() === "") return { at, id: null };
  const id = sinceId.trim();
  if (!UUID.test(id)) throw new Error("since_id_rejected");
  return { at, id };
}

export function errorMessage(code: string): string {
  const messages: Record<string, string> = {
    addressed_agent_rejected: "addressed_agent contains unsupported characters",
    addressed_role_rejected: "addressed_role must be audit, coding, testing, or execution",
    agent_key_rejected: "agent_key must be a lowercase slug",
    roles_rejected: "roles must be a list drawn from audit, coding, testing, execution",
    aliases_rejected: "aliases must be short display names",
    delivery_rejected: "delivery must be webhook or pull",
    webhook_url_rejected: "webhook_url must be https on port 443 with a public host and no query or credentials",
    webhook_key_rejected: "webhook_key must be 16 to 256 characters with no spaces",
    webhook_incomplete: "webhook delivery needs both webhook_url and webhook_key",
    pull_rejects_webhook: "pull delivery does not take a webhook url or key",
    enabled_rejected: "enabled must be true or false",
    payload_rejected: "payload must be an object",
    update_empty: "update_subscriber needs a field to change",
    since_required: "since is required",
    since_rejected: "since must be YYYY-MM-DDTHH:MM:SSZ",
    since_id_rejected: "since_id must be a UUID",
    ack_rejected: "ack needs source_table and source_id",
    ack_empty: "ack needs at least one item",
    seal_key_missing: "MUSE_ALERT_SEAL_KEY is not configured",
    seal_key_invalid: "MUSE_ALERT_SEAL_KEY is not a 32-byte base64 key",
    subscriber_not_found: "no subscriber with that agent_key",
  };
  return messages[code] ?? "request rejected";
}

const PULL_PAGE = 200;
const PULL_SCAN_LIMIT = 5;

export interface AlertStore {
  listEnabledSubscribers(): Promise<AlertSubscriber[]>;
  insertOutbox(rows: PlannedWebhook[], event: AlertEvent): Promise<Array<{ id: string; subscriber_id: string; agent_key: string; attempts: number; payload: Record<string, unknown> }>>;
  claim(limit: number, ids: string[] | null): Promise<Array<{ id: string; subscriber_id: string; agent_key: string; attempts: number; payload: Record<string, unknown> }>>;
  sealedFor(subscriberId: string): Promise<{ url_sealed: string; key_sealed: string } | null>;
  finish(id: string, decision: DeliveryDecision): Promise<void>;
  logDelivery(entry: { outbox_id: string; attempt: number; http_status: number | null; error_code: string | null }): Promise<void>;
  listEvents(cursor: AlertCursor, limit: number): Promise<AlertEvent[]>;
  listAcked(subscriberId: string): Promise<string[]>;
  ack(subscriberId: string, items: AckItem[]): Promise<{ acked: number; already: number }>;
}

export interface AckItem {
  source_table: AlertSource;
  source_id: string;
}

export function parseAck(payload: unknown): AckItem[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("ack_rejected");
  const raw = payload as Record<string, unknown>;
  const rows = Array.isArray(raw.items) ? raw.items : [raw];
  if (rows.length === 0 || rows.length > 50) throw new Error(rows.length === 0 ? "ack_empty" : "ack_rejected");
  const out: AckItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("ack_rejected");
    const item = row as Record<string, unknown>;
    const source = item.source_table;
    const sourceId = typeof item.source_id === "string" ? item.source_id.trim() : "";
    if (source !== "muse_work_updates" && source !== "muse_improvement_tasks" && source !== "muse_daily_reports") {
      throw new Error("ack_rejected");
    }
    if (!UUID.test(sourceId)) throw new Error("ack_rejected");
    const key = `${source}:${sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source_table: source, source_id: sourceId });
  }
  if (out.length === 0) throw new Error("ack_empty");
  return out;
}

export interface ClaimedAlert {
  id: string;
  subscriber_id: string;
  agent_key: string;
  attempts: number;
  payload: Record<string, unknown>;
}

export async function deliverClaimed(opts: {
  row: ClaimedAlert;
  sealed: { url_sealed: string; key_sealed: string } | null;
  sealKey: CryptoKey;
  nowMs: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<DeliveryDecision & { attempt: number }> {
  const attempt = opts.row.attempts;
  if (!opts.sealed) {
    return {
      status: "failed",
      error_code: "seal_missing",
      http_status: null,
      next_attempt_at: new Date(opts.nowMs).toISOString(),
      delivered_at: null,
      attempt,
    };
  }
  let url = "";
  let bearer = "";
  try {
    url = await openText(opts.sealed.url_sealed, opts.sealKey);
    bearer = await openText(opts.sealed.key_sealed, opts.sealKey);
    webhookEndpoint(url);
  } catch {
    return {
      status: "failed",
      error_code: "seal_corrupt",
      http_status: null,
      next_attempt_at: new Date(opts.nowMs).toISOString(),
      delivered_at: null,
      attempt,
    };
  }
  const body = { ...opts.row.payload, outbox_id: opts.row.id };
  const posted = await postWebhook({
    url,
    bearer,
    body,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
  return { ...decideDelivery(posted.http_status, posted.transportError, attempt, opts.nowMs), attempt };
}

async function settle(
  store: AlertStore,
  rows: ClaimedAlert[],
  sealKey: CryptoKey,
  nowMs: number,
  fetchImpl: typeof fetch | undefined,
  timeoutMs: number | undefined,
): Promise<{ delivered: number; pending: number; failed: number; results: Array<{ agent_key: string; status: string; http_status: number | null }> }> {
  let delivered = 0;
  let pending = 0;
  let failed = 0;
  const results: Array<{ agent_key: string; status: string; http_status: number | null }> = [];
  for (const row of rows) {
    const sealed = await store.sealedFor(row.subscriber_id);
    const decision = await deliverClaimed({ row, sealed, sealKey, nowMs, fetchImpl, timeoutMs });
    await store.finish(row.id, decision);
    await store.logDelivery({
      outbox_id: row.id,
      attempt: decision.attempt,
      http_status: decision.http_status,
      error_code: decision.error_code,
    });
    if (decision.status === "delivered") delivered += 1;
    else if (decision.status === "failed") failed += 1;
    else pending += 1;
    results.push({ agent_key: row.agent_key, status: decision.status, http_status: decision.http_status });
  }
  return { delivered, pending, failed, results };
}

export async function fanoutAndDeliver(opts: {
  store: AlertStore;
  event: AlertEvent;
  sealKey: CryptoKey | null;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  timeoutMs?: number;
}): Promise<AlertSummary> {
  const subscribers = await opts.store.listEnabledSubscribers();
  const plan = planFanout(opts.event, subscribers);
  const matched = plan.pull.length + plan.webhook.length;
  if (plan.webhook.length === 0) {
    return { matched, pull: plan.pull.length, enqueued: 0, delivered: 0, pending: 0, failed: 0 };
  }
  const inserted = await opts.store.insertOutbox(plan.webhook, opts.event);
  if (!opts.sealKey || inserted.length === 0) {
    return { matched, pull: plan.pull.length, enqueued: inserted.length, delivered: 0, pending: inserted.length, failed: 0 };
  }
  let claimed: ClaimedAlert[] = [];
  try {
    claimed = await opts.store.claim(inserted.length, inserted.map((row) => row.id));
  } catch {
    return { matched, pull: plan.pull.length, enqueued: inserted.length, delivered: 0, pending: inserted.length, failed: 0 };
  }
  const settled = await settle(opts.store, claimed, opts.sealKey, opts.nowMs ?? Date.now(), opts.fetchImpl, opts.timeoutMs);
  return {
    matched,
    pull: plan.pull.length,
    enqueued: inserted.length,
    delivered: settled.delivered,
    pending: settled.pending + (inserted.length - claimed.length),
    failed: settled.failed,
  };
}

export async function dispatchDue(opts: {
  store: AlertStore;
  sealKey: CryptoKey | null;
  limit: number;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  timeoutMs?: number;
}): Promise<{ claimed: number; delivered: number; pending: number; failed: number; results: Array<{ agent_key: string; status: string; http_status: number | null }> }> {
  if (!opts.sealKey) throw new Error("seal_key_missing");
  const claimed = await opts.store.claim(opts.limit, null);
  const settled = await settle(opts.store, claimed, opts.sealKey, opts.nowMs ?? Date.now(), opts.fetchImpl, opts.timeoutMs);
  return { claimed: claimed.length, ...settled };
}

export async function pullAlerts(opts: {
  store: AlertStore;
  subscriber: AlertSubscriber;
  cursor: AlertCursor;
  limit: number;
}): Promise<{ data: Record<string, unknown>[]; next_cursor: AlertCursor }> {
  const collected: AlertEvent[] = [];
  let scan = opts.cursor;
  for (let page = 0; page < PULL_SCAN_LIMIT && collected.length < opts.limit; page++) {
    const batch = await opts.store.listEvents(scan, PULL_PAGE);
    const fresh = batch.filter((row) => isAfterCursor(row, scan)).sort(compareEventOrder);
    if (fresh.length === 0) break;
    for (const row of fresh) {
      if (eventAddresses(opts.subscriber, row)) collected.push(row);
      if (collected.length >= opts.limit) break;
    }
    const last = fresh[fresh.length - 1];
    scan = { at: last.created_at, id: last.source_id };
    if (collected.length >= opts.limit || batch.length < PULL_PAGE) break;
  }
  const page = collected.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    data: page.map((event) => alertBody(event, null)),
    next_cursor: last ? { at: last.created_at, id: last.source_id } : opts.cursor,
  };
}

function openFloor(subscriber: AlertSubscriber): string {
  if (subscriber.created_at && !Number.isNaN(Date.parse(subscriber.created_at))) {
    return new Date(subscriber.created_at).toISOString();
  }
  return new Date().toISOString();
}

/** Posts for this subscriber since they were registered, skipping ones they already acked. */
export async function pullOpen(opts: {
  store: AlertStore;
  subscriber: AlertSubscriber;
  limit: number;
}): Promise<{ data: Record<string, unknown>[]; next_cursor: AlertCursor; floor: string }> {
  const floor = openFloor(opts.subscriber);
  const acked = new Set(await opts.store.listAcked(opts.subscriber.id));
  const collected: AlertEvent[] = [];
  let scan: AlertCursor = { at: floor, id: null };
  for (let page = 0; page < PULL_SCAN_LIMIT && collected.length < opts.limit; page++) {
    const batch = await opts.store.listEvents(scan, PULL_PAGE);
    const fresh = batch.filter((row) => isAfterCursor(row, scan)).sort(compareEventOrder);
    if (fresh.length === 0) break;
    for (const row of fresh) {
      const key = `${row.source_table}:${row.source_id}`;
      if (eventAddresses(opts.subscriber, row) && !acked.has(key)) collected.push(row);
      if (collected.length >= opts.limit) break;
    }
    const last = fresh[fresh.length - 1];
    scan = { at: last.created_at, id: last.source_id };
    if (collected.length >= opts.limit || batch.length < PULL_PAGE) break;
  }
  const page = collected.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    data: page.map((event) => alertBody(event, null)),
    next_cursor: last ? { at: last.created_at, id: last.source_id } : { at: floor, id: null },
    floor,
  };
}

export function outboxInsert(planned: PlannedWebhook, event: AlertEvent) {
  return {
    dedupe_key: planned.dedupe_key,
    subscriber_id: planned.subscriber_id,
    agent_key: planned.agent_key,
    source_table: event.source_table,
    source_id: event.source_id,
    actor: event.actor,
    addressed_agent: event.addressed_agent,
    addressed_role: event.addressed_role,
    kind: event.kind,
    payload: planned.payload,
  };
}

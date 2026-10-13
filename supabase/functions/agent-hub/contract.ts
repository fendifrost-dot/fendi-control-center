// Pure helpers for agent-hub. No I/O here so they can be unit tested with `deno test`.

export const PURPOSES = ["REVIEW", "FEEDBACK", "TASK", "REVISE", "QUESTION"] as const;
export type Purpose = (typeof PURPOSES)[number];

export const MESSAGE_KINDS = [
  "MESSAGE", "WORK", "REVIEW", "REVISION", "FEEDBACK", "DECISION", "SYSTEM", "IMPORT",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/**
 * Who may author which message kind (review finding 2).
 * - SYSTEM: written only by the hub itself (handoff lines, failures).
 * - DECISION: only Fendi, only through `decide`.
 * - IMPORT: only Fendi, only through `ingest`.
 * Agents may post work and conversation; Fendi may post work, messages and feedback.
 */
export const AGENT_AUTHORED_KINDS = ["MESSAGE", "WORK", "REVIEW", "REVISION", "FEEDBACK"] as const;
export const OWNER_AUTHORED_KINDS = ["MESSAGE", "WORK", "FEEDBACK"] as const;
export const RESERVED_KINDS = ["SYSTEM", "DECISION", "IMPORT"] as const;

export function authoredKind(
  actorType: "human" | "agent" | "bridge",
  requested: unknown,
  fallback: MessageKind,
): MessageKind {
  const allowed: readonly string[] = actorType === "human" ? OWNER_AUTHORED_KINDS : AGENT_AUTHORED_KINDS;
  const kind = requested === undefined || requested === null || requested === "" ? fallback : requested;
  if (typeof kind !== "string" || !(MESSAGE_KINDS as readonly string[]).includes(kind)) {
    throw new InputError(`kind must be one of ${allowed.join(", ")}`);
  }
  if (!allowed.includes(kind)) {
    const why = kind === "SYSTEM" ? "is written only by Control Center itself"
      : kind === "DECISION" ? "is recorded only by Fendi through decide"
      : kind === "IMPORT" ? "is recorded only by Fendi through ingest"
      : `is not allowed for ${actorType === "human" ? "Fendi" : "agents"}`;
    throw new InputError(`kind ${kind} ${why}`);
  }
  return kind as MessageKind;
}

export const ACTIONS = [
  "health", "agents", "threads", "thread", "create_thread", "post", "handoff", "return_to_origin",
  "inbox", "respond", "decide", "set_thread_status", "cancel_handoff", "retry_handoff", "ingest",
  "bridge_capabilities", "bridge_result", "imessage_send", "imessage_read",
] as const;
export type Action = (typeof ACTIONS)[number];

export const LIMITS = {
  body: 100_000,
  instructions: 8_000,
  sourceBody: 60_000,
  historyMessage: 1_500,
  historyCount: 12,
  attachmentsText: 120_000,
  attachmentsCount: 20,
} as const;

export class InputError extends Error {}

export function isAction(v: unknown): v is Action {
  return typeof v === "string" && (ACTIONS as readonly string[]).includes(v);
}

export function str(v: unknown, name: string, max: number, required = false): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw new InputError(`${name} is required`);
    return null;
  }
  if (typeof v !== "string") throw new InputError(`${name} must be a string`);
  const t = v.trim();
  if (!t && required) throw new InputError(`${name} is required`);
  if (t.length > max) throw new InputError(`${name} exceeds ${max} characters`);
  return t || null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(v: unknown, name: string, required = true): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw new InputError(`${name} is required`);
    return null;
  }
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new InputError(`${name} must be a uuid`);
  return v.toLowerCase();
}

export function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[], fallback?: T): T {
  if ((v === undefined || v === null || v === "") && fallback !== undefined) return fallback;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new InputError(`${name} must be one of ${allowed.join(", ")}`);
  }
  return v as T;
}

/** What kind of message a response to each purpose becomes. */
export function responseKindFor(purpose: Purpose): MessageKind {
  switch (purpose) {
    case "REVIEW": return "REVIEW";
    case "FEEDBACK":
    case "REVISE": return "REVISION";
    default: return "MESSAGE";
  }
}

export type Attachment = {
  name: string;
  mime?: string | null;
  text?: string | null;
  storage_path?: string | null;
  url?: string | null;
  bytes?: number | null;
  sha256?: string | null;
};

export function attachments(v: unknown): Attachment[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new InputError("attachments must be an array");
  if (v.length > LIMITS.attachmentsCount) throw new InputError(`at most ${LIMITS.attachmentsCount} attachments`);
  let textTotal = 0;
  return v.map((raw, i) => {
    if (!raw || typeof raw !== "object") throw new InputError(`attachments[${i}] must be an object`);
    const a = raw as Record<string, unknown>;
    const name = str(a.name, `attachments[${i}].name`, 300, true)!;
    const text = typeof a.text === "string" ? a.text : null;
    if (text) textTotal += text.length;
    if (textTotal > LIMITS.attachmentsText) throw new InputError(`attachment text exceeds ${LIMITS.attachmentsText} characters`);
    const storage_path = str(a.storage_path, `attachments[${i}].storage_path`, 500);
    if (storage_path && (storage_path.includes("..") || storage_path.startsWith("/"))) {
      throw new InputError(`attachments[${i}].storage_path is invalid`);
    }
    return {
      name,
      mime: str(a.mime, `attachments[${i}].mime`, 200),
      text,
      storage_path,
      url: str(a.url, `attachments[${i}].url`, 2000),
      bytes: typeof a.bytes === "number" ? a.bytes : (text ? text.length : null),
      sha256: str(a.sha256, `attachments[${i}].sha256`, 64),
    };
  });
}

/** Context = where the work lives: repo, exact revision, files, evidence, origin. */
export type WorkContext = {
  repo?: string | null;
  branch?: string | null;
  commit_sha?: string | null;
  pr_url?: string | null;
  files?: string[];
  evidence?: string[];
  source_app?: string | null;
  external_url?: string | null;
  [k: string]: unknown;
};

export function workContext(v: unknown): WorkContext {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new InputError("context must be an object");
  const c = v as Record<string, unknown>;
  const list = (x: unknown, name: string) => {
    if (x === undefined || x === null) return undefined;
    if (!Array.isArray(x) || x.some((s) => typeof s !== "string")) throw new InputError(`context.${name} must be a string array`);
    return (x as string[]).slice(0, 200).map((s) => s.slice(0, 1000));
  };
  const sha = str(c.commit_sha, "context.commit_sha", 64);
  if (sha && !/^[0-9a-f]{7,40}$/i.test(sha)) throw new InputError("context.commit_sha must be a git sha");
  const out: WorkContext = {
    repo: str(c.repo, "context.repo", 200),
    branch: str(c.branch, "context.branch", 200),
    commit_sha: sha,
    pr_url: str(c.pr_url, "context.pr_url", 500),
    files: list(c.files, "files"),
    evidence: list(c.evidence, "evidence"),
    source_app: str(c.source_app, "context.source_app", 100),
    external_url: str(c.external_url, "context.external_url", 2000),
  };
  for (const k of Object.keys(out)) if (out[k] === null || out[k] === undefined) delete out[k];
  return out;
}

export type PacketMessage = {
  id: string;
  author: string;
  kind: string;
  body: string;
  created_at: string;
  context?: WorkContext;
  attachments?: Attachment[];
};

export type Packet = {
  version: 1;
  handoff_id: string;
  purpose: Purpose;
  from_agent: string;
  to_agent: string;
  requested_by: string;
  instructions: string | null;
  thread: { id: string; title: string; project: string | null };
  source: PacketMessage | null;
  history: PacketMessage[];
  respond_with: { action: "respond"; handoff_id: string; kind: MessageKind };
};

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n…[truncated ${s.length - n} characters]`;
}

export function buildPacket(input: {
  handoff_id: string;
  purpose: Purpose;
  from_agent: string;
  to_agent: string;
  requested_by: string;
  instructions: string | null;
  thread: { id: string; title: string; project: string | null };
  source: PacketMessage | null;
  history: PacketMessage[];
}): Packet {
  const history = input.history
    .filter((m) => !input.source || m.id !== input.source.id)
    .slice(-LIMITS.historyCount)
    .map((m) => ({ ...m, body: clip(m.body, LIMITS.historyMessage), attachments: (m.attachments ?? []).map((a) => ({ ...a, text: null })) }));
  const source = input.source
    ? { ...input.source, body: clip(input.source.body, LIMITS.sourceBody) }
    : null;
  return {
    version: 1,
    handoff_id: input.handoff_id,
    purpose: input.purpose,
    from_agent: input.from_agent,
    to_agent: input.to_agent,
    requested_by: input.requested_by,
    instructions: input.instructions,
    thread: input.thread,
    source,
    history,
    respond_with: { action: "respond", handoff_id: input.handoff_id, kind: responseKindFor(input.purpose) },
  };
}

const PURPOSE_LINE: Record<Purpose, string> = {
  REVIEW: "Review the work below independently. Say what is correct, what is wrong or risky, and what you could not verify from what you were given.",
  FEEDBACK: "A reviewer responded to your work. Address the feedback: accept or push back on each point and describe your revision.",
  REVISE: "Revise the work below according to the instructions.",
  TASK: "Do the task below.",
  QUESTION: "Answer the question below.",
};

function renderContext(c?: WorkContext): string {
  if (!c || Object.keys(c).length === 0) return "";
  const lines: string[] = [];
  if (c.repo) lines.push(`- Repo: ${c.repo}`);
  if (c.branch) lines.push(`- Branch: ${c.branch}`);
  if (c.commit_sha) lines.push(`- Exact revision: ${c.commit_sha}`);
  if (c.pr_url) lines.push(`- Pull request: ${c.pr_url}`);
  if (c.files?.length) lines.push(`- Files: ${c.files.join(", ")}`);
  if (c.evidence?.length) lines.push(`- Evidence: ${c.evidence.join(" ; ")}`);
  if (c.source_app) lines.push(`- Imported from: ${c.source_app}`);
  if (c.external_url) lines.push(`- Link: ${c.external_url}`);
  return lines.join("\n");
}

function renderAttachments(list?: Attachment[]): string {
  if (!list?.length) return "";
  return list.map((a) => {
    const head = `### Attachment: ${a.name}${a.mime ? ` (${a.mime})` : ""}${a.sha256 ? ` sha256 ${a.sha256}` : ""}`;
    if (a.text) return `${head}\n\n\`\`\`\n${a.text}\n\`\`\``;
    if (a.url) return `${head}\n\n(link: ${a.url})`;
    return `${head}\n\n(binary file; not included as text)`;
  }).join("\n\n");
}

/** Markdown the receiving agent reads. Same text for CLI agents, model APIs and inbox readers. */
export function renderPacket(p: Packet): string {
  const out: string[] = [];
  out.push(`# Control Center handoff ${p.handoff_id}`);
  out.push(`Purpose: ${p.purpose}. From ${p.from_agent} to ${p.to_agent}, requested by ${p.requested_by}.`);
  out.push(`Thread: "${p.thread.title}"${p.thread.project ? ` (project: ${p.thread.project})` : ""} — ${p.thread.id}`);
  out.push("");
  out.push(PURPOSE_LINE[p.purpose]);
  if (p.instructions) out.push("", "## Instructions", "", p.instructions);
  if (p.source) {
    out.push("", `## ${p.source.kind} from ${p.source.author} (${p.source.created_at})`, "");
    const ctx = renderContext(p.source.context);
    if (ctx) out.push(ctx, "");
    out.push(p.source.body);
    const att = renderAttachments(p.source.attachments);
    if (att) out.push("", att);
  }
  if (p.history.length) {
    out.push("", "## Earlier in this thread (oldest first, shortened)");
    for (const m of p.history) {
      out.push("", `**${m.kind} — ${m.author}** (${m.created_at})`, m.body);
    }
  }
  out.push("", "## How to answer", "",
    `Reply with your ${p.respond_with.kind.toLowerCase()} as plain text. It is posted to the thread as your message and returned to whoever asked.`);
  return out.join("\n");
}

export type AgentRow = {
  key: string;
  kind: string;
  transport: string;
  availability: string;
  availability_note: string | null;
  secret_name: string | null;
  bridge_cli: string | null;
  last_seen_at: string | null;
  last_verified_at: string | null;
};

export type Effective = { state: "live" | "awaiting_setup" | "unverified" | "disabled"; reason: string };

/**
 * Effective availability, computed from evidence rather than declared:
 * - model APIs need their secret present; live only after a successful call.
 * - Mac CLI agents need a bridge heartbeat in the last 90s and the CLI reported present.
 * - Token agents are live only once they have answered through the hub.
 */
export function effectiveAvailability(
  a: AgentRow,
  env: { secretPresent: (name: string) => boolean; now: number },
  bridge: { lastSeenAt: string | null; capabilities: Record<string, unknown> | null },
): Effective {
  if (a.availability === "disabled") return { state: "disabled", reason: a.availability_note ?? "Disabled." };
  if (a.kind === "human") return { state: "live", reason: "You." };
  if (a.transport === "edge_model_call") {
    if (a.secret_name && !env.secretPresent(a.secret_name)) {
      return { state: "awaiting_setup", reason: `Secret ${a.secret_name} is not set in Lovable Cloud.` };
    }
    if (a.last_verified_at) return { state: "live", reason: `Last successful call ${a.last_verified_at}.` };
    return { state: "unverified", reason: "Key present; no successful call through the hub yet." };
  }
  if (a.transport === "mac_bridge") {
    const seen = bridge.lastSeenAt ? Date.parse(bridge.lastSeenAt) : NaN;
    const online = Number.isFinite(seen) && env.now - seen < 90_000;
    if (!online) {
      return {
        state: "awaiting_setup",
        reason: bridge.lastSeenAt ? `Mac bridge offline (last heartbeat ${bridge.lastSeenAt}).` : "Mac bridge has never connected.",
      };
    }
    const caps = bridge.capabilities ?? {};
    const cli = a.bridge_cli ? (caps as Record<string, unknown>)[`${a.bridge_cli}_cli`] : null;
    if (!cli) return { state: "awaiting_setup", reason: `Bridge online but ${a.bridge_cli ?? "CLI"} not reported (old bridge version or CLI not installed).` };
    if (a.last_verified_at) return { state: "live", reason: `Bridge online; last answered ${a.last_verified_at}.` };
    return { state: "unverified", reason: "Bridge online and CLI found; no completed handoff yet." };
  }
  if (a.transport === "token_inbox") {
    if (a.last_verified_at) return { state: "live", reason: `Last answered through the hub ${a.last_verified_at}.` };
    return { state: a.availability === "live" ? "unverified" : (a.availability as Effective["state"]), reason: a.availability_note ?? "Has not answered through the hub yet." };
  }
  return { state: a.availability as Effective["state"], reason: a.availability_note ?? "" };
}

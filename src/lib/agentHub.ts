import { supabase } from "@/integrations/supabase/client";

export type Effective = { state: "live" | "awaiting_setup" | "unverified" | "disabled"; reason: string };

export type HubAgent = {
  key: string;
  display_name: string;
  kind: "agent_session" | "cli_agent" | "model_api" | "connector" | "human";
  transport: "token_inbox" | "mac_bridge" | "edge_model_call" | "ui";
  connects_to: string;
  conversation_state: string;
  tool_access: string;
  auth: string;
  billing: string;
  availability_note: string | null;
  token_label: string | null;
  bridge_cli: string | null;
  model: string | null;
  last_seen_at: string | null;
  last_verified_at: string | null;
  effective: Effective;
};

export type WorkContext = {
  repo?: string;
  branch?: string;
  commit_sha?: string;
  pr_url?: string;
  files?: string[];
  evidence?: string[];
  source_app?: string;
  external_url?: string;
  decision?: string;
};

export type Attachment = {
  name: string;
  mime?: string | null;
  text?: string | null;
  storage_path?: string | null;
  url?: string | null;
  bytes?: number | null;
};

export type HubMessage = {
  id: string;
  thread_id: string;
  author: string;
  author_kind: "agent" | "human" | "system";
  kind: "MESSAGE" | "WORK" | "REVIEW" | "REVISION" | "FEEDBACK" | "DECISION" | "SYSTEM" | "IMPORT";
  body: string;
  reply_to: string | null;
  handoff_id: string | null;
  context: WorkContext;
  attachments: Attachment[];
  created_at: string;
};

export type HubHandoff = {
  id: string;
  thread_id: string;
  source_message_id: string | null;
  from_agent: string;
  to_agent: string;
  purpose: "REVIEW" | "FEEDBACK" | "TASK" | "REVISE" | "QUESTION";
  instructions: string | null;
  status: "QUEUED" | "DELIVERED" | "IN_PROGRESS" | "RESPONDED" | "FAILED" | "CANCELLED";
  delivery: Record<string, unknown>;
  response_message_id: string | null;
  error: string | null;
  requested_by: string;
  created_at: string;
  responded_at: string | null;
};

export type HubThread = {
  id: string;
  title: string;
  project: string | null;
  status: "OPEN" | "WAITING_ON_AGENT" | "WAITING_ON_FENDI" | "DONE" | "ARCHIVED";
  created_by: string;
  last_activity_at: string;
  created_at: string;
  last_message?: { author: string; kind: string; body: string; created_at: string } | null;
  waiting_on?: string[];
};

export class HubError extends Error {}

/** All writes and reads go through the agent-hub function, which enforces who may do what. */
export async function hub<T = Record<string, unknown>>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke("agent-hub", { body: { action, ...params } });
  if (error) {
    let message = error.message;
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const body = await ctx.json();
        message = body?.message ?? body?.error ?? message;
      } catch {
        /* keep message */
      }
    }
    if (/not found|404/i.test(message)) message = "agent-hub is not deployed yet.";
    // The brokered preview session can stay cached after it stops being valid,
    // so agent-hub keeps returning 401 "invalid session" and pages stall with
    // errors instead of returning to sign-in. Clear the dead session so
    // RequireSession sends the user to /login.
    if (/\b401\b|unauthorized|invalid session|missing token/i.test(message)) {
      void supabase.auth.signOut().catch(() => {});
      throw new HubError("Your session expired — signing you in again.");
    }
    throw new HubError(message);
  }
  return data as T;
}

export async function uploadAttachment(threadKey: string, file: File): Promise<Attachment> {
  const safe = file.name.replace(/[^\w.-]+/g, "_").slice(-120);
  const path = `${threadKey}/${crypto.randomUUID()}-${safe}`;
  const { error } = await supabase.storage.from("agent-hub").upload(path, file, { contentType: file.type || undefined });
  if (error) throw new HubError(`Upload failed: ${error.message}`);
  return { name: file.name, mime: file.type || null, storage_path: path, bytes: file.size };
}

export async function signedUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from("agent-hub").createSignedUrl(path, 60 * 60);
  return data?.signedUrl ?? null;
}

export const STATE_STYLE: Record<Effective["state"], { dot: string; label: string }> = {
  live: { dot: "bg-emerald-500", label: "Live" },
  unverified: { dot: "bg-amber-400", label: "Not yet verified" },
  awaiting_setup: { dot: "bg-zinc-400", label: "Awaiting setup" },
  disabled: { dot: "bg-red-500", label: "Disabled" },
};

export const KIND_LABEL: Record<HubAgent["kind"], string> = {
  agent_session: "Existing agent session",
  cli_agent: "Command-line agent on your Mac",
  model_api: "Model API",
  connector: "Connector",
  human: "You",
};

export const MESSAGE_KIND_STYLE: Record<HubMessage["kind"], string> = {
  MESSAGE: "bg-muted text-muted-foreground",
  WORK: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
  REVIEW: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
  REVISION: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  FEEDBACK: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  DECISION: "bg-yellow-500/20 text-yellow-800 dark:text-yellow-200",
  SYSTEM: "bg-transparent text-muted-foreground",
  IMPORT: "bg-pink-500/15 text-pink-700 dark:text-pink-300",
};

export const SOURCE_APPS = [
  { value: "chatgpt-app", label: "ChatGPT app" },
  { value: "claude-app", label: "Claude app" },
  { value: "grok-app", label: "Grok app" },
  { value: "cursor", label: "Cursor" },
  { value: "other", label: "Other" },
];

export function commitUrl(c: WorkContext): string | null {
  if (!c.repo || !c.commit_sha || !/^[\w.-]+\/[\w.-]+$/.test(c.repo)) return null;
  return `https://github.com/${c.repo}/commit/${c.commit_sha}`;
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

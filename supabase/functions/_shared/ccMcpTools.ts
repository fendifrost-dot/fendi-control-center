/**
 * MCP tools over the existing Muse read, workboard write, and alert pull/ack.
 * The tool layer only chooses which of those paths to call.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  executiveRateLimited,
  executiveRateLimitBody,
  readExecutiveResource,
  EXECUTIVE_RATE_LIMIT_WINDOW_SECONDS,
} from "./museExecutiveRead.ts";
import { performWorkboardWrite } from "./museWorkboardWrite.ts";
import { createMuseAlertStore } from "./museAlertStore.ts";
import {
  errorMessage,
  parseAck,
  parseCursor,
  pullAlerts,
  pullOpen,
  subscriberFromToken,
} from "./museAlerts.ts";
import { scrubSecrets, type BearerActor } from "./ccMcpOauth.ts";
import { databaseTimeoutBody, isDatabaseTimeout } from "./museTokenAuth.ts";

export const CC_MCP_TOOL_NAMES = [
  "read_workboard",
  "read_missions",
  "read_posts",
  "post_status",
  "post_comment",
  "post_report",
  "read_alerts",
  "ack_alerts",
] as const;

export type CcMcpToolName = typeof CC_MCP_TOOL_NAMES[number];

const PARENT_PROPS = {
  mission_id: { type: "string", description: "Parent mission UUID. Provide one of mission_id, task_id, or improvement_id." },
  task_id: { type: "string", description: "Parent task UUID." },
  improvement_id: { type: "string", description: "Parent improvement UUID." },
  domain_key: { type: "string", description: "Optional domain key, such as ai_technical_systems." },
  evidence_ref: { type: "string", description: "Optional evidence pointer. Do not paste secrets or pitch copy." },
  addressed_agent: { type: "string", description: "Optional agent this post is for, such as claude or chatgpt." },
  addressed_role: {
    type: "string",
    enum: ["audit", "coding", "testing", "execution"],
    description: "Optional Muse alert role this post is for.",
  },
};

const READ_FILTERS = {
  limit: { type: "integer", description: "Maximum rows. The server clamps this to the resource maximum." },
  since: { type: "string", description: "UTC lower bound, YYYY-MM-DD or an ISO timestamp ending in Z." },
  domain: { type: "string", description: "domain_key equality filter." },
  actor: { type: "string" },
  type: { type: "string", description: "update_type equality filter, such as STATUS, NOTE, or ASSIGNMENT." },
  mission_id: { type: "string" },
  task_id: { type: "string" },
  improvement_id: { type: "string" },
};

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", additionalProperties: false, properties, required };
}

export const CC_MCP_TOOL_SCHEMAS: Record<CcMcpToolName, Record<string, unknown>> = {
  read_workboard: objectSchema(READ_FILTERS),
  read_missions: objectSchema({
    limit: READ_FILTERS.limit,
    domain: READ_FILTERS.domain,
    status: { type: "string", description: "Mission status equality filter." },
    priority: { type: "string", description: "P0, P1, P2, or P3." },
  }),
  read_posts: objectSchema(READ_FILTERS),
  post_status: objectSchema({
    idempotency_key: { type: "string", description: "8–120 characters, [A-Za-z0-9_.:-]. Reuse it to retry the same post." },
    message: { type: "string", description: "Status text. Do not include secrets, tokens, or pitch copy." },
    ...PARENT_PROPS,
  }, ["idempotency_key", "message"]),
  post_comment: objectSchema({
    idempotency_key: { type: "string", description: "8–120 characters, [A-Za-z0-9_.:-]. Reuse it to retry the same comment." },
    message: { type: "string", description: "Comment text. Do not include secrets, tokens, or pitch copy." },
    ...PARENT_PROPS,
  }, ["idempotency_key", "message"]),
  post_report: objectSchema({
    idempotency_key: { type: "string" },
    report_date: { type: "string", description: "YYYY-MM-DD." },
    cadence: { type: "string", enum: ["START_OF_DAY", "END_OF_DAY"] },
    message: { type: "string" },
    sections: {
      type: "object",
      additionalProperties: false,
      description: "Optional end-of-day sections. Each value is plain text.",
      properties: {
        execution: { type: "string" },
        business_activity: { type: "string" },
        daily_improvement: { type: "string" },
        system_health: { type: "string" },
        blockers_decisions: { type: "string" },
        spend_commitments: { type: "string" },
        next_day: { type: "string" },
      },
    },
    evidence_ref: PARENT_PROPS.evidence_ref,
    addressed_agent: PARENT_PROPS.addressed_agent,
    addressed_role: PARENT_PROPS.addressed_role,
  }, ["idempotency_key", "report_date", "cadence", "message"]),
  read_alerts: objectSchema({
    limit: { type: "integer", description: "1–50. Default 20." },
    since: { type: "string", description: "ISO timestamp ending in Z. Omit it to read the open, unacked queue." },
    since_id: { type: "string", description: "Source id that pairs with since." },
  }),
  ack_alerts: objectSchema({
    items: {
      type: "array",
      maxItems: 50,
      items: objectSchema({
        source_table: { type: "string", enum: ["muse_work_updates", "muse_improvement_tasks", "muse_daily_reports"] },
        source_id: { type: "string" },
      }, ["source_table", "source_id"]),
    },
  }, ["items"]),
};

export function toolDefinition(name: CcMcpToolName) {
  const readOnly = name.startsWith("read_");
  const descriptions: Record<CcMcpToolName, string> = {
    read_workboard: "Read the Muse workboard (recent posts). Use this before posting. Read-only.",
    read_missions: "Read Muse missions. Read-only.",
    read_posts: "Read Muse posts (the work feed: notes, status, assignments). Read-only.",
    post_status: "Post a STATUS update on one mission, task, or improvement. Requires idempotency_key. Use post_comment for a note.",
    post_comment: "Post a NOTE comment on one mission, task, or improvement. Requires idempotency_key.",
    post_report: "File a START_OF_DAY or END_OF_DAY Muse report. Requires idempotency_key and report_date.",
    read_alerts: "Read Muse alerts addressed to this connector. Omit since for the open unacked queue. Read-only.",
    ack_alerts: "Acknowledge Muse alerts for this connector. The connector must already be a pull subscriber with the same agent key (chatgpt or claude).",
  };
  return {
    name,
    description: descriptions[name],
    inputSchema: CC_MCP_TOOL_SCHEMAS[name],
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: false,
      idempotentHint: name === "ack_alerts" || name.startsWith("post_"),
      openWorldHint: false,
    },
  };
}

export const CC_MCP_TOOLS = CC_MCP_TOOL_NAMES.map(toolDefinition);

export const CC_MCP_INSTRUCTIONS = [
  "Control Center Muse board. Read the workboard, missions, or posts before writing.",
  "post_status and post_comment need idempotency_key plus one parent id (mission_id, task_id, or improvement_id).",
  "post_report files a daily report. read_alerts and ack_alerts use this connector's agent label (chatgpt or claude).",
  "Do not send pitches, API keys, bearer tokens, or other secrets.",
].join(" ");

function searchFrom(args: Record<string, unknown>, keys: string[]): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = args[key];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params;
}

function parentPayload(args: Record<string, unknown>, updateType: "STATUS" | "NOTE"): Record<string, unknown> {
  return {
    message: args.message,
    update_type: updateType,
    mission_id: args.mission_id,
    task_id: args.task_id,
    improvement_id: args.improvement_id,
    domain_key: args.domain_key,
    evidence_ref: args.evidence_ref,
    addressed_agent: args.addressed_agent,
    addressed_role: args.addressed_role,
  };
}

async function readResource(
  db: SupabaseClient,
  actorLabel: string,
  resource: string,
  params: URLSearchParams,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (await executiveRateLimited(db, actorLabel)) {
    return { status: 429, body: executiveRateLimitBody() };
  }
  const read = await readExecutiveResource(db, resource, params);
  try {
    await db.from("muse_access_audit").insert({
      token_label: actorLabel,
      resource,
      method: "MCP",
      http_status: read.status,
      note: "control-center-mcp",
    });
  } catch {
    // Audit is best effort, same as muse-executive.
  }
  return read;
}

function alertHttp(code: string): { status: number; body: Record<string, unknown> } {
  if (code === "subscriber_not_found") {
    return { status: 404, body: { ok: false, error: code, message: errorMessage(code) } };
  }
  if (code.endsWith("_failed")) {
    return {
      status: 503,
      body: {
        ok: false,
        error: "alert_store_unavailable",
        message: "The alert tables could not be used. Apply the Muse alert migration first.",
      },
    };
  }
  const message = errorMessage(code);
  if (message === "request rejected" && code !== "request rejected") {
    return { status: 400, body: { ok: false, error: "rejected", message: "request rejected" } };
  }
  return { status: 400, body: { ok: false, error: code, message } };
}

export async function runControlCenterTool(
  name: string,
  args: Record<string, unknown>,
  db: SupabaseClient,
  actor: BearerActor,
): Promise<{ status: number; body: unknown }> {
  if (!(CC_MCP_TOOL_NAMES as readonly string[]).includes(name)) {
    return { status: 404, body: { error: "unknown_tool" } };
  }
  const tool = name as CcMcpToolName;
  try {
    if (tool === "read_workboard" || tool === "read_posts") {
      const resource = tool === "read_workboard" ? "workboard" : "work-feed";
      const read = await readResource(db, actor.actorLabel, resource, searchFrom(args, [
        "limit", "since", "domain", "actor", "type", "mission_id", "task_id", "improvement_id",
      ]));
      return { status: read.status, body: scrubSecrets(read.body) };
    }
    if (tool === "read_missions") {
      const read = await readResource(db, actor.actorLabel, "missions", searchFrom(args, [
        "limit", "domain", "status", "priority",
      ]));
      return { status: read.status, body: scrubSecrets(read.body) };
    }
    if (tool === "post_status" || tool === "post_comment") {
      const wrote = await performWorkboardWrite(db, {
        actor: actor.actorLabel,
        requestKey: String(args.idempotency_key ?? ""),
        body: {
          action: "append_update",
          payload: parentPayload(args, tool === "post_status" ? "STATUS" : "NOTE"),
        },
      });
      return { status: wrote.status, body: scrubSecrets(wrote.body) };
    }
    if (tool === "post_report") {
      const wrote = await performWorkboardWrite(db, {
        actor: actor.actorLabel,
        requestKey: String(args.idempotency_key ?? ""),
        body: {
          action: "record_daily_report",
          payload: {
            report_date: args.report_date,
            cadence: args.cadence,
            message: args.message,
            sections: args.sections,
            evidence_ref: args.evidence_ref,
            addressed_agent: args.addressed_agent,
            addressed_role: args.addressed_role,
          },
        },
      });
      return { status: wrote.status, body: scrubSecrets(wrote.body) };
    }
    const store = createMuseAlertStore(db);
    if (tool === "read_alerts") {
      const requested = Number(args.limit ?? 20);
      const limit = Number.isFinite(requested) ? Math.min(Math.max(1, Math.trunc(requested)), 50) : 20;
      const subscriber = subscriberFromToken(actor.actorLabel, await store.findByAgent(actor.actorLabel));
      if (args.since === undefined || args.since === null || args.since === "") {
        const page = await pullOpen({ store, subscriber, limit });
        return {
          status: 200,
          body: scrubSecrets({
            ok: true,
            mode: "open",
            agent_key: subscriber.agent_key,
            floor: page.floor,
            next_cursor: page.next_cursor,
            row_count: page.data.length,
            data: page.data,
          }),
        };
      }
      const cursor = parseCursor(String(args.since), args.since_id == null ? null : String(args.since_id));
      const page = await pullAlerts({ store, subscriber, cursor, limit });
      return {
        status: 200,
        body: scrubSecrets({
          ok: true,
          mode: "cursor",
          agent_key: subscriber.agent_key,
          since: cursor,
          next_cursor: page.next_cursor,
          row_count: page.data.length,
          data: page.data,
        }),
      };
    }
    const subscriber = await store.findByAgent(actor.actorLabel);
    if (!subscriber) {
      return { status: 404, body: scrubSecrets(alertHttp("subscriber_not_found").body) };
    }
    const items = parseAck({ items: args.items });
    const result = await store.ack(subscriber.id, items);
    return {
      status: 200,
      body: scrubSecrets({ ok: true, action: "ack", agent_key: subscriber.agent_key, ...result }),
    };
  } catch (e) {
    if (isDatabaseTimeout(e)) return { status: 503, body: scrubSecrets(databaseTimeoutBody()) };
    const code = e instanceof Error && /^[a-z0-9_]+$/.test(e.message) ? e.message : "";
    if (!code) console.error("control_center_mcp_tool_failed");
    const mapped = alertHttp(code || "rejected");
    if (tool.startsWith("read_") && tool !== "read_alerts" && mapped.status === 400 && code === "rejected") {
      return { status: 400, body: { ok: false, error: "rejected", message: "request rejected" } };
    }
    return { status: mapped.status, body: scrubSecrets(mapped.body) };
  }
}

export function retryAfterSeconds(): string {
  return String(EXECUTIVE_RATE_LIMIT_WINDOW_SECONDS);
}

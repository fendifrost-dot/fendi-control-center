/**
 * Service-role adapter for the alert tables.
 * Sealed webhook material is read only inside deliver, and error text from
 * Postgres is never surfaced: callers throw a stable code.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  ALERT_ROLES,
  type AlertCursor,
  type AlertEvent,
  type AlertRole,
  type AlertSource,
  type AlertSubscriber,
  type ClaimedAlert,
  type DeliveryDecision,
  type PlannedWebhook,
  type SubscriberPublic,
  outboxInsert,
} from "./museAlerts.ts";

const EVENT_COLUMNS = [
  "source_table",
  "source_id",
  "created_at",
  "actor",
  "addressed_agent",
  "addressed_role",
  "kind",
  "message",
  "mission_id",
  "improvement_id",
  "task_id",
  "domain_key",
  "evidence_ref",
].join(",");

const PUBLIC_COLUMNS = "agent_key,roles,aliases,delivery,enabled,webhook_host,webhook_key_hint";

const SOURCES: readonly AlertSource[] = [
  "muse_work_updates",
  "muse_improvement_tasks",
  "muse_daily_reports",
];

function asRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function asRoles(value: unknown): AlertRole[] {
  if (!Array.isArray(value)) return [];
  return value.filter((role): role is AlertRole =>
    typeof role === "string" && (ALERT_ROLES as readonly string[]).includes(role)
  );
}

function asSubscriber(row: Record<string, unknown>): AlertSubscriber {
  return {
    id: String(row.id),
    agent_key: String(row.agent_key),
    roles: asRoles(row.roles),
    aliases: Array.isArray(row.aliases) ? row.aliases.filter((alias): alias is string => typeof alias === "string") : [],
    delivery: row.delivery === "webhook" ? "webhook" : "pull",
    enabled: row.enabled !== false,
  };
}

function asPublic(row: Record<string, unknown>): SubscriberPublic {
  return {
    agent_key: String(row.agent_key),
    roles: asRoles(row.roles),
    aliases: Array.isArray(row.aliases) ? row.aliases.filter((alias): alias is string => typeof alias === "string") : [],
    delivery: row.delivery === "webhook" ? "webhook" : "pull",
    enabled: row.enabled !== false,
    webhook_host: textOrNull(row.webhook_host),
    webhook_key_hint: textOrNull(row.webhook_key_hint),
  };
}

function asEvent(row: Record<string, unknown>): AlertEvent | null {
  const source = row.source_table;
  const sourceId = textOrNull(row.source_id);
  const createdAt = textOrNull(row.created_at);
  const actor = textOrNull(row.actor);
  const message = textOrNull(row.message);
  if (
    typeof source !== "string" ||
    !(SOURCES as readonly string[]).includes(source) ||
    !sourceId ||
    !createdAt ||
    !actor ||
    !message ||
    Number.isNaN(Date.parse(createdAt))
  ) {
    return null;
  }
  const role = textOrNull(row.addressed_role);
  return {
    source_table: source as AlertSource,
    source_id: sourceId,
    created_at: new Date(createdAt).toISOString(),
    actor,
    addressed_agent: textOrNull(row.addressed_agent),
    addressed_role: role && (ALERT_ROLES as readonly string[]).includes(role) ? role as AlertRole : null,
    kind: textOrNull(row.kind) ?? "NOTE",
    message,
    mission_id: textOrNull(row.mission_id),
    improvement_id: textOrNull(row.improvement_id),
    task_id: textOrNull(row.task_id),
    domain_key: textOrNull(row.domain_key),
    evidence_ref: textOrNull(row.evidence_ref),
  };
}

function asClaimed(row: Record<string, unknown>): ClaimedAlert | null {
  const id = textOrNull(row.id);
  const subscriberId = textOrNull(row.subscriber_id);
  const agentKey = textOrNull(row.agent_key);
  if (!id || !subscriberId || !agentKey) return null;
  const payload = row.payload;
  return {
    id,
    subscriber_id: subscriberId,
    agent_key: agentKey,
    attempts: typeof row.attempts === "number" ? row.attempts : 0,
    payload: payload && typeof payload === "object" && !Array.isArray(payload)
      ? asRow(payload)
      : {},
  };
}

export interface SubscriberWrite {
  agent_key: string;
  roles: AlertRole[];
  aliases: string[];
  delivery: "webhook" | "pull";
  enabled: boolean;
  webhook_url_sealed: string | null;
  webhook_key_sealed: string | null;
  webhook_host: string | null;
  webhook_key_hint: string | null;
}

export interface StoredSubscriber extends SubscriberPublic {
  id: string;
  webhook_url_sealed: string | null;
  webhook_key_sealed: string | null;
}

export function createMuseAlertStore(db: SupabaseClient) {
  return {
    async listEnabledSubscribers(): Promise<AlertSubscriber[]> {
      const { data, error } = await db
        .from("muse_alert_subscribers")
        .select("id,agent_key,roles,aliases,delivery,enabled")
        .eq("enabled", true);
      if (error) throw new Error("subscribers_read_failed");
      return (data ?? []).map((row) => asSubscriber(asRow(row)));
    },

    async insertOutbox(rows: PlannedWebhook[], event: AlertEvent): Promise<ClaimedAlert[]> {
      const inserted: ClaimedAlert[] = [];
      for (const planned of rows) {
        const { data, error } = await db
          .from("muse_alert_outbox")
          .insert(outboxInsert(planned, event))
          .select("id,subscriber_id,agent_key,attempts,payload")
          .single();
        if (error?.code === "23505") continue;
        if (error || !data) throw new Error("outbox_insert_failed");
        const claimed = asClaimed(asRow(data));
        if (!claimed) throw new Error("outbox_insert_failed");
        inserted.push(claimed);
      }
      return inserted;
    },

    async claim(limit: number, ids: string[] | null): Promise<ClaimedAlert[]> {
      const { data, error } = await db.rpc("muse_alert_claim", { p_limit: limit, p_ids: ids });
      if (error) throw new Error("claim_failed");
      return (Array.isArray(data) ? data : [])
        .map((row) => asClaimed(asRow(row)))
        .filter((row): row is ClaimedAlert => row !== null);
    },

    async sealedFor(subscriberId: string): Promise<{ url_sealed: string; key_sealed: string } | null> {
      const { data, error } = await db
        .from("muse_alert_subscribers")
        .select("webhook_url_sealed,webhook_key_sealed")
        .eq("id", subscriberId)
        .maybeSingle();
      if (error || !data) return null;
      const url = textOrNull(data.webhook_url_sealed);
      const key = textOrNull(data.webhook_key_sealed);
      if (!url || !key) return null;
      return { url_sealed: url, key_sealed: key };
    },

    async finish(id: string, decision: DeliveryDecision): Promise<void> {
      const { error } = await db.from("muse_alert_outbox").update({
        status: decision.status,
        next_attempt_at: decision.next_attempt_at,
        last_error: decision.error_code,
        last_http_status: decision.http_status,
        delivered_at: decision.delivered_at,
        claimed_at: null,
      }).eq("id", id);
      if (error) throw new Error("finish_failed");
    },

    async logDelivery(entry: { outbox_id: string; attempt: number; http_status: number | null; error_code: string | null }): Promise<void> {
      const { error } = await db.from("muse_alert_deliveries").insert({
        outbox_id: entry.outbox_id,
        attempt: entry.attempt,
        http_status: entry.http_status,
        error_code: entry.error_code,
      });
      if (error) throw new Error("delivery_log_failed");
    },

    async listEvents(cursor: AlertCursor, limit: number): Promise<AlertEvent[]> {
      const { data, error } = await db
        .from("muse_alert_events")
        .select(EVENT_COLUMNS)
        .gte("created_at", cursor.at)
        .order("created_at", { ascending: true })
        .order("source_id", { ascending: true })
        .limit(limit);
      if (error) throw new Error("events_read_failed");
      return (data ?? [])
        .map((row) => asEvent(asRow(row)))
        .filter((row): row is AlertEvent => row !== null);
    },

    async listPublic(): Promise<SubscriberPublic[]> {
      const { data, error } = await db
        .from("muse_alert_subscribers")
        .select(PUBLIC_COLUMNS)
        .order("agent_key", { ascending: true });
      if (error) throw new Error("subscribers_read_failed");
      return (data ?? []).map((row) => asPublic(asRow(row)));
    },

    async find(agentKey: string): Promise<StoredSubscriber | null> {
      const { data, error } = await db
        .from("muse_alert_subscribers")
        .select(`id,${PUBLIC_COLUMNS},webhook_url_sealed,webhook_key_sealed`)
        .eq("agent_key", agentKey)
        .maybeSingle();
      if (error) throw new Error("subscribers_read_failed");
      if (!data) return null;
      const row = asRow(data);
      return {
        ...asPublic(row),
        id: String(row.id),
        webhook_url_sealed: textOrNull(row.webhook_url_sealed),
        webhook_key_sealed: textOrNull(row.webhook_key_sealed),
      };
    },

    async findByAgent(agentKey: string): Promise<AlertSubscriber | null> {
      const { data, error } = await db
        .from("muse_alert_subscribers")
        .select("id,agent_key,roles,aliases,delivery,enabled")
        .eq("agent_key", agentKey)
        .maybeSingle();
      if (error) throw new Error("subscribers_read_failed");
      if (!data) return null;
      return asSubscriber(asRow(data));
    },

    async save(row: SubscriberWrite): Promise<SubscriberPublic> {
      const { data, error } = await db
        .from("muse_alert_subscribers")
        .upsert(row, { onConflict: "agent_key" })
        .select(PUBLIC_COLUMNS)
        .single();
      if (error || !data) throw new Error("subscriber_write_failed");
      return asPublic(asRow(data));
    },
  };
}

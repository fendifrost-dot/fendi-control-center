export const ACTIONS = [
  'create_mission',
  'create_improvement',
  'create_task',
  'append_update',
  'record_measurement',
  'update_task_state',
  'update_task_verification',
  'update_improvement_state',
  'record_daily_report',
  'record_ig_dm_receipt',
] as const;

/**
 * Instagram send packs are posted on this mission. Receipt refusals land here
 * so they show on the same board as the packs.
 */
export const IG_DM_RECEIPT_BOARD_MISSION_ID = '6f14b53d-4c16-49ec-a475-a1bf94229499';

export const IG_DM_RECEIPT_REFUSED_PREFIX = 'IG_DM_RECEIPT_REFUSED';

const RECEIPT_ID = /^[A-Za-z0-9-]{1,80}$/;
const PITCH_MARKERS = [
  'muse_ig_send_brief',
  'exact paste',
  'ig_dm_draft',
  'pitch_body',
  'draft_body',
  'dm body:',
  'pitch:',
];

/** End-of-day sections. Keys match the seven items Grok Bot already reports. */
export const REPORT_SECTION_KEYS = [
  'execution',
  'business_activity',
  'daily_improvement',
  'system_health',
  'blockers_decisions',
  'spend_commitments',
  'next_day',
] as const;

export type WorkboardAction = typeof ACTIONS[number];

export function isAction(value: unknown): value is WorkboardAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

export function boundedString(value: unknown, name: string, max = 4000, required = false): string | null {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${name} is required`);
  if (trimmed.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return trimmed || null;
}

export function uuid(value: unknown, name: string, required = true): string | null {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }
  return value;
}

export function reportDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('report_date must be YYYY-MM-DD');
  }
  const [year, month, day] = value.split('-').map((part) => Number(part));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error('report_date must be a real calendar date');
  }
  return value;
}

export function reportSections(value: unknown): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('sections must be an object');
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(REPORT_SECTION_KEYS as readonly string[]).includes(key)) {
      throw new Error(`sections.${key} is not a report section`);
    }
    const text = boundedString(raw, `sections.${key}`, 4000, true);
    if (text) out[key] = text;
  }
  return out;
}

export interface IgDmReceipt {
  handoff_record_id: string;
  reference: string;
  notes: string;
  submitted_at: string;
}

export interface IgDmReceiptBoardNotice {
  update_type: 'BLOCKER' | 'STATUS';
  message: string;
  evidence_ref: string;
  mission_id: string;
}

/** Prefer the workboard payload. A flat body is accepted when payload is absent. */
export function receiptInputFrom(body: Record<string, unknown>): unknown {
  const payload = body.payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'action' || key === 'payload') continue;
    rest[key] = value;
  }
  return rest;
}

/**
 * Operator note only. The approved DM pitch stays on the send pack.
 * A pasted brief, pitch field, link, or multi-paragraph DM is refused here
 * and is never forwarded.
 */
export function receiptNotes(value: unknown): string {
  const notes = boundedString(value, 'notes', 500, true);
  if (!notes) throw new Error('notes is required');
  const lower = notes.toLowerCase();
  if (PITCH_MARKERS.some((marker) => lower.includes(marker)) || /https?:\/\//i.test(notes)) {
    throw new Error('notes must describe the send without pasting the pitch');
  }
  if (notes.split(/\n\s*\n/).length >= 3) {
    throw new Error('notes must describe the send without pasting the pitch');
  }
  return notes;
}

export function parseIgDmReceipt(input: unknown, now = Date.now()): IgDmReceipt {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('receipt fields are required');
  }
  const raw = input as Record<string, unknown>;
  const handoff = boundedString(raw.handoff_record_id, 'handoff_record_id', 80, true);
  if (!handoff || !RECEIPT_ID.test(handoff)) throw new Error('handoff_record_id is invalid');
  const reference = boundedString(raw.reference, 'reference', 200, true);
  if (!reference) throw new Error('reference is required');
  if (PITCH_MARKERS.some((marker) => reference.toLowerCase().includes(marker)) || /https?:\/\//i.test(reference)) {
    throw new Error('reference must identify the send without pasting the pitch');
  }
  const notes = receiptNotes(raw.notes);
  if (typeof raw.submitted_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(raw.submitted_at.trim())) {
    throw new Error('submitted_at must be an ISO timestamp ending in Z');
  }
  const parsed = Date.parse(raw.submitted_at.trim());
  if (!Number.isFinite(parsed)) throw new Error('submitted_at must be an ISO timestamp');
  if (parsed > now + 60_000) throw new Error('submitted_at must not be in the future');
  return {
    handoff_record_id: handoff,
    reference,
    notes,
    submitted_at: new Date(parsed).toISOString(),
  };
}

/** Fields other than the four receipt inputs are dropped, including pitch copy. */
export function hubReceiptBody(receipt: IgDmReceipt): {
  action: 'mark_manual_ig_dm_submitted';
  handoff_record_id: string;
  evidence: { result: 'submitted'; reference: string; notes: string; submitted_at: string };
} {
  return {
    action: 'mark_manual_ig_dm_submitted',
    handoff_record_id: receipt.handoff_record_id,
    evidence: {
      result: 'submitted',
      reference: receipt.reference,
      notes: receipt.notes,
      submitted_at: receipt.submitted_at,
    },
  };
}

export function hubControlCenterUrl(hubUrl: string): string {
  const base = hubUrl.trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) throw new Error('FANFUEL_HUB_URL must be https');
  return `${base}/functions/v1/control-center-api`;
}

export function receiptLeaksSecret(receipt: IgDmReceipt, secret: string): boolean {
  if (!secret) return false;
  return receipt.handoff_record_id.includes(secret)
    || receipt.reference.includes(secret)
    || receipt.notes.includes(secret)
    || receipt.submitted_at.includes(secret);
}

/**
 * Server-side request. The secret is a header only. redirect is "error" so a
 * redirect cannot carry the header to another host.
 */
export function hubReceiptRequest(opts: { hubUrl: string; secret: string; receipt: IgDmReceipt }): {
  url: string;
  init: { method: 'POST'; headers: Record<string, string>; body: string; redirect: 'error' };
} {
  const secret = opts.secret.trim();
  if (!secret) throw new Error('MUSE_IG_RECEIPT_SECRET is not configured');
  if (receiptLeaksSecret(opts.receipt, secret)) {
    throw new Error('receipt fields must not contain the receipt secret');
  }
  const body = hubReceiptBody(opts.receipt);
  const serialized = JSON.stringify(body);
  if (serialized.includes(secret)) throw new Error('receipt fields must not contain the receipt secret');
  return {
    url: hubControlCenterUrl(opts.hubUrl),
    init: {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'x-muse-ig-receipt-secret': secret,
      },
      body: serialized,
    },
  };
}

export function redactReceiptSecret(value: unknown, secret: string): unknown {
  if (!secret) return value;
  if (typeof value === 'string') return value.split(secret).join('[redacted]');
  if (Array.isArray(value)) return value.map((item) => redactReceiptSecret(item, secret));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/(secret|token|api[_-]?key|authorization|password|credential)/i.test(key)) {
        out[key] = '[redacted]';
        continue;
      }
      out[key] = redactReceiptSecret(item, secret);
    }
    return out;
  }
  return value;
}

function safeHubDetail(value: unknown, secret: string): string {
  if (typeof value !== 'string') return '';
  let text = secret ? value.split(secret).join('[redacted]') : value;
  text = text.trim();
  if (!text) return '';
  if (/muse_ig_send_brief|exact paste|ig_dm_draft|pitch_body/i.test(text)) return '[omitted]';
  return text.slice(0, 300);
}

/**
 * Hub 403 and 409 stay 403 and 409. Only those two become a board notice.
 * The notice names the handoff and the hub error. It does not include notes.
 */
export function receiptOutcome(
  hubStatus: number,
  hubBody: unknown,
  receipt: IgDmReceipt,
  secret = '',
): { status: number; body: Record<string, unknown>; board: IgDmReceiptBoardNotice | null } {
  const redacted = redactReceiptSecret(hubBody, secret);
  const body = redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : { ok: false, error: 'hub returned an unexpected body', hub_status: hubStatus };
  if (hubStatus !== 403 && hubStatus !== 409) {
    return { status: hubStatus, body, board: null };
  }
  const code = safeHubDetail(body.code, secret);
  const error = safeHubDetail(body.error, secret);
  const lines = [
    IG_DM_RECEIPT_REFUSED_PREFIX,
    `hub_status: ${hubStatus}`,
    `handoff_record_id: ${receipt.handoff_record_id}`,
    `reference: ${receipt.reference}`,
  ];
  if (code) lines.push(`code: ${code}`);
  if (error) lines.push(`error: ${error}`);
  return {
    status: hubStatus,
    body,
    board: {
      update_type: hubStatus === 403 ? 'BLOCKER' : 'STATUS',
      message: lines.join('\n'),
      evidence_ref: receipt.handoff_record_id,
      mission_id: IG_DM_RECEIPT_BOARD_MISSION_ID,
    },
  };
}

export function oneOf(value: unknown, name: string, values: readonly string[], fallback?: string): string {
  const candidate = value ?? fallback;
  if (typeof candidate !== 'string' || !values.includes(candidate)) {
    throw new Error(`${name} must be one of: ${values.join(', ')}`);
  }
  return candidate;
}

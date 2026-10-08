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
] as const;

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

export function oneOf(value: unknown, name: string, values: readonly string[], fallback?: string): string {
  const candidate = value ?? fallback;
  if (typeof candidate !== 'string' || !values.includes(candidate)) {
    throw new Error(`${name} must be one of: ${values.join(', ')}`);
  }
  return candidate;
}

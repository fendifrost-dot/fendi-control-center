export const ACTIONS = [
  'create_mission',
  'create_improvement',
  'create_task',
  'append_update',
  'record_measurement',
  'update_task_state',
  'update_task_verification',
  'update_improvement_state',
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

export function oneOf(value: unknown, name: string, values: readonly string[], fallback?: string): string {
  const candidate = value ?? fallback;
  if (typeof candidate !== 'string' || !values.includes(candidate)) {
    throw new Error(`${name} must be one of: ${values.join(', ')}`);
  }
  return candidate;
}

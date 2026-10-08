/**
 * Pure presentation helpers for the Muse module. No Supabase or React here, so
 * the display rules that carry Muse's honesty guarantees are unit-testable.
 */
import type {
  MuseBriefSection,
  MuseDataStatus,
  MuseSystemStatus,
  MuseVerificationState,
} from "./types";

export type BadgeTone = "default" | "secondary" | "destructive" | "outline";

/** Order the brief is read in: what must be decided before what is merely noted. */
export const BRIEF_SECTIONS: Array<{ key: MuseBriefSection; label: string; blurb: string }> = [
  { key: "priorities", label: "Top priorities", blurb: "P0 and P1 loops that are still real" },
  { key: "decisions_required", label: "Decisions required", blurb: "Owed by a human owner" },
  { key: "blockers", label: "Blockers", blurb: "Work that cannot move" },
  { key: "system_failures", label: "System & agent failures", blurb: "Derived from live telemetry" },
  { key: "waiting", label: "Waiting", blurb: "On someone or something else" },
  { key: "financial", label: "Material financial issues", blurb: "Money-affecting loops" },
  { key: "opportunities", label: "Opportunities", blurb: "Upside worth a decision" },
  { key: "commitments", label: "Upcoming commitments", blurb: "Promised to someone" },
];

/**
 * A status is never dressed up: only KNOWN reads as settled, and everything
 * softer reads as outstanding.
 */
export function dataStatusTone(status: MuseDataStatus | null | undefined): BadgeTone {
  switch (status) {
    case "KNOWN":
      return "default";
    case "NEEDS_VERIFICATION":
      return "secondary";
    case "SOURCE_EXISTS_ACCESS_NEEDED":
    case "AVAILABLE_NOT_CONNECTED":
      return "outline";
    case "NOT_MEASURED":
    case "UNKNOWN":
    default:
      return "outline";
  }
}

export function dataStatusLabel(status: MuseDataStatus | null | undefined): string {
  if (!status) return "UNKNOWN";
  return status.replace(/_/g, " ").toLowerCase();
}

export function systemStatusTone(status: MuseSystemStatus | null | undefined): BadgeTone {
  switch (status) {
    case "HEALTHY":
      return "default";
    case "FAILING":
      return "destructive";
    case "STALE":
      return "secondary";
    default:
      return "outline";
  }
}

/** Only a live check earns the strongest tone. An agent's claim does not. */
export function verificationTone(state: MuseVerificationState | null | undefined): BadgeTone {
  switch (state) {
    case "LIVE_VERIFIED":
      return "default";
    case "SYSTEM_VERIFIED":
      return "secondary";
    case "ARTIFACT_VERIFIED":
      return "outline";
    case "CLAIMED":
    default:
      return "outline";
  }
}

export function priorityTone(priority: string | null | undefined): BadgeTone {
  if (priority === "P0") return "destructive";
  if (priority === "P1") return "secondary";
  return "outline";
}

export function stateTone(state: string | null | undefined): BadgeTone {
  switch (state) {
    case "BLOCKED":
      return "destructive";
    case "WAITING":
      return "secondary";
    case "RESOLVED":
    case "CANCELLED":
      return "default";
    default:
      return "outline";
  }
}

/** Sort key so P0 comes first regardless of how a list arrives. */
export function priorityRank(priority: string | null | undefined): number {
  switch (priority) {
    case "P0":
      return 0;
    case "P1":
      return 1;
    case "P2":
      return 2;
    case "P3":
      return 3;
    default:
      return 9;
  }
}

/**
 * Human-readable age. Returns "never" for a missing timestamp rather than a
 * date that implies knowledge Muse does not have.
 */
export function formatAge(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const minutes = Math.floor((now - t) / 60000);
  if (minutes < 0) return "just now";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/** Due dates read as an urgency, not a raw timestamp. */
export function formatDue(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "no date";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const days = Math.round((t - now) / 86400000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days}d`;
}

export function formatKpiValue(value: number | null | undefined, unit: string | null | undefined): string {
  // No value means not measured. Never render a 0 that could be read as a fact.
  if (value === null || value === undefined) return "—";
  const rounded = Number.isInteger(value) ? value.toString() : value.toFixed(2);
  if (unit === "USD") return `$${rounded}`;
  if (!unit || unit === "count") return rounded;
  return `${rounded} ${unit}`;
}

/**
 * True when a read failed because the Muse schema is not in the database yet.
 * The module then tells Fendi to apply the migration instead of showing an
 * empty dashboard that looks like "nothing is happening".
 */
export function isMissingSchemaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; message?: string; details?: string };
  if (e.code === "42P01" || e.code === "PGRST205" || e.code === "PGRST202") return true;
  const haystack = `${e.message ?? ""} ${e.details ?? ""}`.toLowerCase();
  return (
    haystack.includes("does not exist") ||
    haystack.includes("could not find the table") ||
    haystack.includes("schema cache")
  );
}

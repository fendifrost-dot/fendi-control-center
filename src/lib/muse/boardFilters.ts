/**
 * Filter values accepted by muse-executive. The edge function compares them
 * for equality and rejects anything outside this set, so the signed-in board
 * uses the same rule.
 */
export const MUSE_FILTER_VALUE = /^[A-Za-z0-9_.:\- ]{1,100}$/;

export interface WorkFeedFilterInput {
  actor: string;
  type: string;
  domain: string;
  taskId: string;
  improvementId: string;
  missionId: string;
}

export interface WorkFeedQuery {
  actor?: string;
  type?: string;
  domain?: string;
  task_id?: string;
  improvement_id?: string;
  mission_id?: string;
}

export interface MuseWorkFeedLike {
  actor: string | null;
  update_type: string | null;
  domain_key: string | null;
  task_id: string | null;
  improvement_id: string | null;
  mission_id: string | null;
}

export const EMPTY_WORK_FEED_FILTER: WorkFeedFilterInput = {
  actor: "",
  type: "",
  domain: "",
  taskId: "",
  improvementId: "",
  missionId: "",
};

const WORK_FEED_FIELDS: Array<[keyof WorkFeedFilterInput, string]> = [
  ["actor", "agent"],
  ["type", "type"],
  ["domain", "area"],
  ["taskId", "task"],
  ["improvementId", "improvement"],
  ["missionId", "mission"],
];

export function workFeedFilterProblem(input: WorkFeedFilterInput): string | null {
  for (const [key, label] of WORK_FEED_FIELDS) {
    const value = input[key].trim();
    if (value && !MUSE_FILTER_VALUE.test(value)) {
      return `${label} filter contains unsupported characters`;
    }
  }
  return null;
}

export function appliedWorkFeedQuery(input: WorkFeedFilterInput): WorkFeedQuery {
  const query: WorkFeedQuery = {};
  const put = (key: keyof WorkFeedQuery, raw: string) => {
    const value = raw.trim();
    if (value) query[key] = value;
  };
  put("actor", input.actor);
  put("type", input.type);
  put("domain", input.domain);
  put("task_id", input.taskId);
  put("improvement_id", input.improvementId);
  put("mission_id", input.missionId);
  return query;
}

export function matchesWorkFeed(row: MuseWorkFeedLike, input: WorkFeedFilterInput): boolean {
  const eq = (filter: string, actual: string | null) => {
    const value = filter.trim();
    return !value || actual === value;
  };
  return (
    eq(input.actor, row.actor) &&
    eq(input.type, row.update_type) &&
    eq(input.domain, row.domain_key) &&
    eq(input.taskId, row.task_id) &&
    eq(input.improvementId, row.improvement_id) &&
    eq(input.missionId, row.mission_id)
  );
}

export interface DailyReportFilterInput {
  actor: string;
  cadence: "" | "START_OF_DAY" | "END_OF_DAY";
  reportDate: string;
}

export interface DailyReportQuery {
  actor?: string;
  cadence?: "START_OF_DAY" | "END_OF_DAY";
  report_date?: string;
}

export function dailyReportFilterProblem(input: DailyReportFilterInput): string | null {
  const actor = input.actor.trim();
  if (actor && !MUSE_FILTER_VALUE.test(actor)) return "actor filter contains unsupported characters";
  const date = input.reportDate.trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "date filter must be YYYY-MM-DD";
  return null;
}

export function appliedDailyReportQuery(input: DailyReportFilterInput): DailyReportQuery {
  const query: DailyReportQuery = {};
  const actor = input.actor.trim();
  const date = input.reportDate.trim();
  if (actor) query.actor = actor;
  if (input.cadence) query.cadence = input.cadence;
  if (date) query.report_date = date;
  return query;
}

/** Seven end-of-day items. Keys match muse-workboard REPORT_SECTION_KEYS. */
export const DAILY_REPORT_SECTIONS: Array<{ key: string; label: string }> = [
  { key: "execution", label: "Execution" },
  { key: "business_activity", label: "Business activity" },
  { key: "daily_improvement", label: "Daily improvement" },
  { key: "system_health", label: "System and agent health" },
  { key: "blockers_decisions", label: "Blockers and decisions" },
  { key: "spend_commitments", label: "Spend and commitments" },
  { key: "next_day", label: "Next day" },
];

import { describe, expect, it } from "vitest";
import {
  DAILY_REPORT_SECTIONS,
  appliedDailyReportQuery,
  appliedWorkFeedQuery,
  dailyReportFilterProblem,
  matchesWorkFeed,
  workFeedFilterProblem,
} from "./boardFilters";

const ROW = {
  actor: "grok-bot",
  update_type: "STATUS",
  domain_key: "ai_technical_systems",
  task_id: "8e32dd33-b1b6-4eb8-ba5f-d34330ca2a72",
  improvement_id: "92910903-0133-47bd-8b84-bc4aaf44e227",
  mission_id: null,
};

const BLANK = {
  actor: "",
  type: "",
  domain: "",
  taskId: "",
  improvementId: "",
  missionId: "",
};

describe("work feed filters", () => {
  it("matches a task id exactly and ignores other rows", () => {
    const input = { ...BLANK, taskId: ROW.task_id };
    expect(matchesWorkFeed(ROW, input)).toBe(true);
    expect(matchesWorkFeed({ ...ROW, task_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, input)).toBe(false);
    expect(appliedWorkFeedQuery(input)).toEqual({ task_id: ROW.task_id });
  });

  it("matches an improvement id the way acknowledgements are written", () => {
    const input = { ...BLANK, improvementId: ROW.improvement_id };
    expect(matchesWorkFeed(ROW, input)).toBe(true);
    expect(appliedWorkFeedQuery(input)).toEqual({ improvement_id: ROW.improvement_id });
  });

  it("keeps the existing agent, type, and area filters", () => {
    const input = { ...BLANK, actor: "grok-bot", type: "STATUS", domain: "ai_technical_systems" };
    expect(matchesWorkFeed(ROW, input)).toBe(true);
    expect(matchesWorkFeed({ ...ROW, actor: "enki" }, input)).toBe(false);
    expect(appliedWorkFeedQuery(input)).toEqual({
      actor: "grok-bot",
      type: "STATUS",
      domain: "ai_technical_systems",
    });
  });

  it("rejects characters the executive API would reject", () => {
    expect(workFeedFilterProblem({ ...BLANK, taskId: "id;drop" })).toMatch(/task/);
    expect(workFeedFilterProblem(BLANK)).toBeNull();
  });
});

describe("daily report filters", () => {
  it("maps cadence, actor, and report date onto the read query", () => {
    expect(appliedDailyReportQuery({
      actor: "grok-bot",
      cadence: "START_OF_DAY",
      reportDate: "2026-10-08",
    })).toEqual({
      actor: "grok-bot",
      cadence: "START_OF_DAY",
      report_date: "2026-10-08",
    });
  });

  it("requires a calendar date when a date is entered", () => {
    expect(dailyReportFilterProblem({ actor: "", cadence: "", reportDate: "10/08/2026" })).toMatch(/YYYY-MM-DD/);
    expect(dailyReportFilterProblem({ actor: "", cadence: "END_OF_DAY", reportDate: "" })).toBeNull();
  });

  it("names the seven end-of-day sections", () => {
    expect(DAILY_REPORT_SECTIONS.map((section) => section.key)).toEqual([
      "execution",
      "business_activity",
      "daily_improvement",
      "system_health",
      "blockers_decisions",
      "spend_commitments",
      "next_day",
    ]);
  });
});

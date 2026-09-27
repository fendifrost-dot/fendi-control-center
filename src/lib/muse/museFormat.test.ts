import { describe, expect, it } from "vitest";
import {
  BRIEF_SECTIONS,
  dataStatusLabel,
  dataStatusTone,
  formatAge,
  formatDue,
  formatDelta,
  formatKpiValue,
  IMPROVEMENT_FLOW,
  isMissingSchemaError,
  localIsoDate,
  meetsVerification,
  priorityRank,
  systemStatusTone,
  taskStateTone,
  verdictTone,
  verificationTone,
} from "./museFormat";

describe("brief sections", () => {
  it("leads with priorities and decisions", () => {
    expect(BRIEF_SECTIONS[0].key).toBe("priorities");
    expect(BRIEF_SECTIONS[1].key).toBe("decisions_required");
  });

  it("covers every section the brief view can return", () => {
    expect(BRIEF_SECTIONS.map((s) => s.key).sort()).toEqual([
      "blockers",
      "commitments",
      "decisions_required",
      "financial",
      "opportunities",
      "priorities",
      "system_failures",
      "waiting",
    ]);
  });
});

describe("status tones", () => {
  it("gives the settled tone only to KNOWN", () => {
    expect(dataStatusTone("KNOWN")).toBe("default");
    for (const s of ["NEEDS_VERIFICATION", "SOURCE_EXISTS_ACCESS_NEEDED", "NOT_MEASURED", "UNKNOWN"] as const) {
      expect(dataStatusTone(s)).not.toBe("default");
    }
  });

  it("treats a missing status as unknown, not as good news", () => {
    expect(dataStatusTone(undefined)).toBe("outline");
    expect(dataStatusLabel(undefined)).toBe("UNKNOWN");
  });

  it("marks a failing system destructively and an unobserved one merely outlined", () => {
    expect(systemStatusTone("FAILING")).toBe("destructive");
    expect(systemStatusTone("HEALTHY")).toBe("default");
    expect(systemStatusTone("NOT_OBSERVED")).toBe("outline");
    expect(systemStatusTone("NEVER_RAN")).toBe("outline");
  });

  it("does not let a CLAIMED verification look verified", () => {
    expect(verificationTone("LIVE_VERIFIED")).toBe("default");
    expect(verificationTone("CLAIMED")).toBe("outline");
    expect(verificationTone("ARTIFACT_VERIFIED")).toBe("outline");
  });
});

describe("priority ordering", () => {
  it("sorts P0 first and unknown last", () => {
    const sorted = ["P2", "P0", null, "P1", "P3"].sort((a, b) => priorityRank(a) - priorityRank(b));
    expect(sorted).toEqual(["P0", "P1", "P2", "P3", null]);
  });
});

describe("time formatting", () => {
  const now = Date.parse("2026-09-25T12:00:00.000Z");

  it("says never instead of inventing a date", () => {
    expect(formatAge(null, now)).toBe("never");
    expect(formatAge(undefined, now)).toBe("never");
    expect(formatAge("nonsense", now)).toBe("unknown");
  });

  it("scales the unit with the age", () => {
    expect(formatAge("2026-09-25T11:30:00.000Z", now)).toBe("30m ago");
    expect(formatAge("2026-09-25T06:00:00.000Z", now)).toBe("6h ago");
    expect(formatAge("2026-09-20T12:00:00.000Z", now)).toBe("5d ago");
    expect(formatAge("2026-06-25T12:00:00.000Z", now)).toBe("3mo ago");
    expect(formatAge("2026-09-25T12:05:00.000Z", now)).toBe("just now");
  });

  it("reports overdue work as overdue", () => {
    expect(formatDue("2026-09-20T12:00:00.000Z", now)).toBe("5d overdue");
    expect(formatDue("2026-09-25T12:00:00.000Z", now)).toBe("today");
    expect(formatDue("2026-09-26T12:00:00.000Z", now)).toBe("tomorrow");
    expect(formatDue("2026-10-05T12:00:00.000Z", now)).toBe("in 10d");
    expect(formatDue(null, now)).toBe("no date");
  });
});

describe("KPI rendering", () => {
  it("renders an unmeasured metric as a dash, never as zero", () => {
    expect(formatKpiValue(null, "count")).toBe("—");
    expect(formatKpiValue(undefined, "USD")).toBe("—");
    expect(formatKpiValue(0, "count")).toBe("0");
  });

  it("formats units", () => {
    expect(formatKpiValue(375.5, "USD")).toBe("$375.50");
    expect(formatKpiValue(12, "count")).toBe("12");
    expect(formatKpiValue(3, "days")).toBe("3 days");
  });
});

describe("missing schema detection", () => {
  it("recognises a database without the Muse views applied", () => {
    expect(isMissingSchemaError({ code: "42P01", message: 'relation "muse_portfolio_map" does not exist' })).toBe(true);
    expect(isMissingSchemaError({ code: "PGRST205", message: "Could not find the table 'public.muse_domains' in the schema cache" })).toBe(true);
  });

  it("does not mistake other failures for a missing schema", () => {
    expect(isMissingSchemaError({ code: "42501", message: "permission denied for view muse_executive_brief" })).toBe(false);
    expect(isMissingSchemaError(null)).toBe(false);
    expect(isMissingSchemaError("boom")).toBe(false);
  });
});

describe("mission board helpers", () => {
  it("an agent claim never meets a live requirement", () => {
    expect(meetsVerification("CLAIMED", "LIVE_VERIFIED")).toBe(false);
    expect(meetsVerification("ARTIFACT_VERIFIED", "LIVE_VERIFIED")).toBe(false);
    expect(meetsVerification("LIVE_VERIFIED", "LIVE_VERIFIED")).toBe(true);
    expect(meetsVerification("SYSTEM_VERIFIED", "ARTIFACT_VERIFIED")).toBe(true);
  });

  it("a missing requirement defaults to live, and a missing state meets nothing", () => {
    expect(meetsVerification("SYSTEM_VERIFIED", null)).toBe(false);
    expect(meetsVerification(null, "CLAIMED")).toBe(false);
  });

  it("the lifecycle reads PROPOSED to CLOSED with a named owner at each step", () => {
    expect(IMPROVEMENT_FLOW[0].status).toBe("PROPOSED");
    expect(IMPROVEMENT_FLOW[IMPROVEMENT_FLOW.length - 1].status).toBe("CLOSED");
    for (const step of IMPROVEMENT_FLOW) expect(step.owner.length).toBeGreaterThan(0);
  });

  it("only KEEP reads as settled; REVERSE reads as destructive", () => {
    expect(verdictTone("KEEP")).toBe("default");
    expect(verdictTone("REVERSE")).toBe("destructive");
    expect(verdictTone("PENDING")).toBe("outline");
  });

  it("a claimed task is not styled as complete", () => {
    expect(taskStateTone("IMPLEMENTED")).not.toBe("default");
    expect(taskStateTone("COMPLETE")).toBe("default");
    expect(taskStateTone("BLOCKED")).toBe("destructive");
  });

  it("an unmeasured delta is a dash, not zero", () => {
    expect(formatDelta(null)).toBe("—");
    expect(formatDelta(0.05)).toBe("+0.05");
    expect(formatDelta(-3)).toBe("-3");
  });

  it("dates the daily board in local time", () => {
    expect(localIsoDate(new Date(2026, 8, 7, 23, 30))).toBe("2026-09-07");
  });
});

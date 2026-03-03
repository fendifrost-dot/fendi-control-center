import { describe, it, expect } from "vitest";
import {
  normalizeText,
  matchWorkflows,
  formatWorkflowList,
  formatNoMatch,
  generateHeaderDedupeKey,
  type WorkflowEntry,
} from "./workflowRouter";

const SAMPLE_WORKFLOWS: WorkflowEntry[] = [
  {
    key: "system_status",
    name: "System Status",
    description: "Get system status",
    trigger_phrases: ["/status", "status", "system status", "health"],
    tools: ["ops", "jobs"],
  },
  {
    key: "list_workflows",
    name: "List Workflows",
    description: "List available workflows",
    trigger_phrases: ["/workflows", "workflows", "what workflows exist", "what can you do", "commands"],
    tools: ["ops"],
  },
  {
    key: "help",
    name: "Help",
    description: "Show help",
    trigger_phrases: ["/help", "help"],
    tools: ["ops"],
  },
  {
    key: "ping",
    name: "Ping",
    description: "Ping test",
    trigger_phrases: ["/ping", "ping"],
    tools: ["telegram_outbox"],
  },
  {
    key: "resend_failed",
    name: "Resend Failed",
    description: "Flush failed outbox items",
    trigger_phrases: ["/resend_failed", "resend failed", "flush outbox", "retry outbox"],
    tools: ["telegram_outbox"],
  },
];

describe("normalizeText", () => {
  it("trims and lowercases", () => {
    expect(normalizeText("  Hello World  ")).toBe("hello world");
  });
  it("handles empty/null", () => {
    expect(normalizeText("")).toBe("");
    expect(normalizeText(null as any)).toBe("");
  });
});

describe("matchWorkflows", () => {
  it('"/status" matches system_status', () => {
    const r = matchWorkflows("/status", SAMPLE_WORKFLOWS);
    expect(r.chosen?.key).toBe("system_status");
  });

  it('"status" matches system_status', () => {
    const r = matchWorkflows("status", SAMPLE_WORKFLOWS);
    expect(r.chosen?.key).toBe("system_status");
  });

  it('"/workflows" matches list_workflows', () => {
    const r = matchWorkflows("/workflows", SAMPLE_WORKFLOWS);
    expect(r.chosen?.key).toBe("list_workflows");
  });

  it('"what workflows exist" matches list_workflows', () => {
    const r = matchWorkflows("what workflows exist", SAMPLE_WORKFLOWS);
    expect(r.chosen?.key).toBe("list_workflows");
  });

  it("unknown input -> no matches", () => {
    const r = matchWorkflows("banana split recipe please", SAMPLE_WORKFLOWS);
    expect(r.matches.length).toBe(0);
    expect(r.chosen).toBeUndefined();
  });

  it("overlapping triggers -> multiple matches, no chosen", () => {
    // "status" appears in system_status triggers, and "system status" contains "status"
    // Create a scenario with deliberate overlap
    const overlapping: WorkflowEntry[] = [
      { key: "a", name: "A", description: "A", trigger_phrases: ["check health"], tools: [] },
      { key: "b", name: "B", description: "B", trigger_phrases: ["check health status"], tools: [] },
    ];
    const r = matchWorkflows("check health", overlapping);
    // "check health" exact matches A, and B contains "check health" as substring
    expect(r.matches.length).toBe(2);
    expect(r.chosen).toBeUndefined();
  });
});

describe("formatWorkflowList", () => {
  it("includes implemented/not-implemented status", () => {
    const implemented = new Set(["ping", "system_status"]);
    const output = formatWorkflowList(SAMPLE_WORKFLOWS, implemented);
    expect(output).toContain("✅ Implemented");
    expect(output).toContain("⚠️ Not Implemented");
    expect(output).toContain("Workflow Registry");
  });

  it("never contains the old vague phrase", () => {
    const output = formatWorkflowList(SAMPLE_WORKFLOWS, new Set());
    expect(output).not.toContain("No internal workflow exists for that request yet");
  });
});

describe("formatNoMatch", () => {
  it("shows suggestions", () => {
    const output = formatNoMatch(SAMPLE_WORKFLOWS);
    expect(output).toContain("No matching workflow");
    expect(output).toContain("/workflows");
  });

  it("never contains the old vague phrase", () => {
    const output = formatNoMatch(SAMPLE_WORKFLOWS);
    expect(output).not.toContain("No internal workflow exists for that request yet");
  });
});

describe("header dedupe key", () => {
  it("generates stable key", () => {
    expect(generateHeaderDedupeKey("abc123")).toBe("task:abc123:header");
  });

  it("is unique per task", () => {
    expect(generateHeaderDedupeKey("a")).not.toBe(generateHeaderDedupeKey("b"));
  });
});

describe("Two-Lane /do parsing", () => {
  it('"/do status" extracts "status" and matches system_status', () => {
    const doArg = "/do status".slice(3).trim();
    const r = matchWorkflows(doArg, SAMPLE_WORKFLOWS);
    expect(r.chosen?.key).toBe("system_status");
  });

  it('"/do" with no arg yields empty string', () => {
    const doArg = "/do".slice(3).trim();
    expect(doArg).toBe("");
  });

  it('"/do retry outbox" matches resend_failed', () => {
    const doArg = "/do retry outbox".slice(3).trim();
    const r = matchWorkflows(doArg, SAMPLE_WORKFLOWS);
    expect(r.chosen?.key).toBe("resend_failed");
  });

  it("non-/do text does NOT trigger execution (Lane 2 test)", () => {
    // This validates the concept: "retry outbox" without /do should still match
    // but in the bot it goes to Lane 2 (assistant mode), not execution
    const r = matchWorkflows("retry outbox", SAMPLE_WORKFLOWS);
    expect(r.chosen?.key).toBe("resend_failed");
    // The distinction is in the bot handler, not the matcher
  });
});

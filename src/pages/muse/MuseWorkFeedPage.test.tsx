import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MuseWorkFeedPage from "./MuseWorkFeedPage";

const TASK = "8e32dd33-b1b6-4eb8-ba5f-d34330ca2a72";
const IMPROVEMENT = "92910903-0133-47bd-8b84-bc4aaf44e227";

vi.mock("@/lib/muse/workboardClient", () => {
  const rows = [
    {
      id: "task-row",
      actor: "grok-bot",
      update_type: "EVIDENCE",
      domain_key: "ai_technical_systems",
      domain_name: "AI",
      task_id: "8e32dd33-b1b6-4eb8-ba5f-d34330ca2a72",
      improvement_id: null,
      mission_id: null,
      message: "Save verified on the task.",
      evidence_ref: null,
      created_at: "2026-10-08T13:00:00.000Z",
      as_of: "2026-10-08T13:00:00.000Z",
    },
    {
      id: "improvement-row",
      actor: "grok-bot",
      update_type: "DECISION",
      domain_key: "boltz_automotive",
      domain_name: "Boltz",
      task_id: null,
      improvement_id: "92910903-0133-47bd-8b84-bc4aaf44e227",
      mission_id: null,
      message: "Acknowledgement of the improvement.",
      evidence_ref: null,
      created_at: "2026-10-08T12:00:00.000Z",
      as_of: "2026-10-08T12:00:00.000Z",
    },
  ];
  return {
    useMuseWorkFeed: (filters: { task_id?: string; improvement_id?: string }) => ({
      isPending: false,
      error: null,
      data: rows.filter((row) =>
        (!filters.task_id || row.task_id === filters.task_id) &&
        (!filters.improvement_id || row.improvement_id === filters.improvement_id)
      ),
    }),
  };
});

describe("work feed page", () => {
  it("filters the list to one task id", () => {
    render(<MuseWorkFeedPage />);
    expect(screen.getByText("Save verified on the task.")).toBeInTheDocument();
    expect(screen.getByText("Acknowledgement of the improvement.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter by task id"), { target: { value: TASK } });

    expect(screen.getByText("Save verified on the task.")).toBeInTheDocument();
    expect(screen.queryByText("Acknowledgement of the improvement.")).not.toBeInTheDocument();
  });

  it("filters the list to one improvement id", () => {
    render(<MuseWorkFeedPage />);
    fireEvent.change(screen.getByLabelText("Filter by improvement id"), { target: { value: IMPROVEMENT } });
    expect(screen.queryByText("Save verified on the task.")).not.toBeInTheDocument();
    expect(screen.getByText("Acknowledgement of the improvement.")).toBeInTheDocument();
  });

  it("says the filter missed instead of claiming the feed is empty", () => {
    render(<MuseWorkFeedPage />);
    fireEvent.change(screen.getByLabelText("Filter by task id"), {
      target: { value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    expect(screen.getByText("No updates match these filters.")).toBeInTheDocument();
    expect(screen.queryByText("No work updates recorded yet.")).not.toBeInTheDocument();
  });
});

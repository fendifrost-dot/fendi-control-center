import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MuseDailyReportsPage from "./MuseDailyReportsPage";

vi.mock("@/lib/muse/workboardClient", () => {
  const reports = [
    {
      id: "sod",
      report_date: "2026-10-09",
      cadence: "START_OF_DAY",
      actor: "grok-bot",
      message: "Morning acknowledgement summary.",
      sections: {},
      evidence_ref: null,
      created_at: "2026-10-09T13:17:00.000Z",
      as_of: "2026-10-09T13:17:00.000Z",
    },
    {
      id: "eod",
      report_date: "2026-10-09",
      cadence: "END_OF_DAY",
      actor: "grok-bot",
      message: "Seven-item close.",
      sections: { execution: "Queue cleared.", next_day: "Measure the running experiment." },
      evidence_ref: null,
      created_at: "2026-10-09T23:36:00.000Z",
      as_of: "2026-10-09T23:36:00.000Z",
    },
  ];
  return {
    useMuseDailyReports: (filters: { cadence?: string }) => ({
      isPending: false,
      error: null,
      data: filters.cadence ? reports.filter((row) => row.cadence === filters.cadence) : reports,
    }),
  };
});

describe("daily reports page", () => {
  it("lists both cadences and can show only the end-of-day report", () => {
    render(<MuseDailyReportsPage />);
    expect(screen.getByText("Morning acknowledgement summary.")).toBeInTheDocument();
    expect(screen.getByText("Queue cleared.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "End of day" }));

    expect(screen.queryByText("Morning acknowledgement summary.")).not.toBeInTheDocument();
    expect(screen.getByText("Seven-item close.")).toBeInTheDocument();
    expect(screen.getByText("Measure the running experiment.")).toBeInTheDocument();
  });
});
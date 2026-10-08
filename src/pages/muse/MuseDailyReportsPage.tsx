import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MuseEmpty, MuseError, MuseLoading, MusePageHeader, Field } from "@/components/muse/MuseBits";
import {
  DAILY_REPORT_SECTIONS,
  appliedDailyReportQuery,
  dailyReportFilterProblem,
  type DailyReportFilterInput,
} from "@/lib/muse/boardFilters";
import { useMuseDailyReports } from "@/lib/muse/workboardClient";
import { formatAge } from "@/lib/muse/museFormat";
import type { DailyReportCadence } from "@/lib/muse/workboardTypes";

const CADENCES: Array<{ value: DailyReportFilterInput["cadence"]; label: string }> = [
  { value: "", label: "All" },
  { value: "START_OF_DAY", label: "Start of day" },
  { value: "END_OF_DAY", label: "End of day" },
];

function cadenceLabel(cadence: DailyReportCadence | string): string {
  return cadence === "START_OF_DAY" ? "Start of day" : cadence === "END_OF_DAY" ? "End of day" : cadence;
}

function sectionText(sections: Record<string, string> | null, key: string): string | null {
  const value = sections?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export default function MuseDailyReportsPage() {
  const [filters, setFilters] = useState<DailyReportFilterInput>({
    actor: "",
    cadence: "",
    reportDate: "",
  });
  const problem = dailyReportFilterProblem(filters);
  const query = problem ? {} : appliedDailyReportQuery(filters);
  const hasFilter = Object.keys(query).length > 0;
  const reports = useMuseDailyReports(query);

  return (
    <div>
      <MusePageHeader
        title="Daily reports"
        description="Start-of-day and end-of-day reports from Grok Bot and Enki. New reports are written with record_daily_report. They are not updates on a mission."
        right={reports.data && <div className="text-xs text-muted-foreground">{reports.data.length} shown</div>}
      />

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-1">
          {CADENCES.map((item) => (
            <Button
              key={item.label}
              type="button"
              size="sm"
              variant={filters.cadence === item.value ? "default" : "outline"}
              onClick={() => setFilters((current) => ({ ...current, cadence: item.value }))}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Report date</span>
          <Input
            value={filters.reportDate}
            onChange={(event) => setFilters((current) => ({ ...current, reportDate: event.target.value }))}
            placeholder="YYYY-MM-DD"
            aria-label="Filter by report date"
            className="mt-1 h-9 w-40 font-mono text-xs"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Actor</span>
          <Input
            value={filters.actor}
            onChange={(event) => setFilters((current) => ({ ...current, actor: event.target.value }))}
            placeholder="grok-bot"
            aria-label="Filter by actor"
            className="mt-1 h-9 w-40 font-mono text-xs"
          />
        </label>
      </div>

      {problem && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {problem}
        </div>
      )}
      {reports.isPending && <MuseLoading label="Reading daily reports" />}
      {reports.error && <MuseError error={reports.error} />}
      {!problem && !hasFilter && reports.data?.length === 0 && (
        <MuseEmpty>
          No daily reports yet. Reports filed before this home existed stay on the work feed under mission 6f14b53d-4c16-49ec-a475-a1bf94229499.
        </MuseEmpty>
      )}
      {!problem && hasFilter && !reports.isPending && !reports.error && reports.data?.length === 0 && (
        <MuseEmpty>No reports match these filters.</MuseEmpty>
      )}

      <div className="space-y-4">
        {!problem && reports.data?.map((report) => (
          <Card key={report.id}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base">{cadenceLabel(report.cadence)}</CardTitle>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{report.report_date}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary" className="font-mono text-[10px]">{report.actor}</Badge>
                  <span className="text-xs text-muted-foreground">{formatAge(report.created_at)}</span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="whitespace-pre-wrap text-sm">{report.message}</p>
              {DAILY_REPORT_SECTIONS.some((section) => sectionText(report.sections, section.key)) && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {DAILY_REPORT_SECTIONS.map((section) => {
                    const text = sectionText(report.sections, section.key);
                    if (!text) return null;
                    return <Field key={section.key} label={section.label}>{text}</Field>;
                  })}
                </div>
              )}
              {report.evidence_ref && <Field label="Evidence">{report.evidence_ref}</Field>}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

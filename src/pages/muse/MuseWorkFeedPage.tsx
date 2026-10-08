import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { MuseEmpty, MuseError, MuseLoading, MusePageHeader, Field } from "@/components/muse/MuseBits";
import {
  EMPTY_WORK_FEED_FILTER,
  appliedWorkFeedQuery,
  matchesWorkFeed,
  workFeedFilterProblem,
  type WorkFeedFilterInput,
} from "@/lib/muse/boardFilters";
import { useMuseWorkFeed } from "@/lib/muse/workboardClient";
import { formatAge } from "@/lib/muse/museFormat";

function FilterField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="mt-1 h-9 font-mono text-xs"
      />
    </label>
  );
}

export default function MuseWorkFeedPage() {
  const [filters, setFilters] = useState<WorkFeedFilterInput>(EMPTY_WORK_FEED_FILTER);
  const problem = workFeedFilterProblem(filters);
  const query = problem ? {} : appliedWorkFeedQuery(filters);
  const hasFilter = Object.keys(query).length > 0;
  const feed = useMuseWorkFeed(query);
  const rows = problem ? [] : (feed.data ?? []).filter((row) => matchesWorkFeed(row, filters));

  const set = (key: keyof WorkFeedFilterInput) => (value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));

  return (
    <div>
      <MusePageHeader
        title="Work feed"
        description="Append-only updates. Filter by the task or improvement id an acknowledgement was written against. Matches are exact."
        right={feed.data && !problem && <div className="text-xs text-muted-foreground">{rows.length} shown</div>}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <FilterField label="Filter by task id" value={filters.taskId} onChange={set("taskId")} placeholder="task UUID" />
        <FilterField label="Filter by improvement id" value={filters.improvementId} onChange={set("improvementId")} placeholder="improvement UUID" />
        <FilterField label="Filter by mission id" value={filters.missionId} onChange={set("missionId")} placeholder="mission UUID" />
        <FilterField label="Filter by agent" value={filters.actor} onChange={set("actor")} placeholder="grok-bot" />
        <FilterField label="Filter by type" value={filters.type} onChange={set("type")} placeholder="STATUS" />
        <FilterField label="Filter by area" value={filters.domain} onChange={set("domain")} placeholder="domain key" />
      </div>

      {problem && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {problem}
        </div>
      )}
      {feed.isPending && <MuseLoading label="Reading the work feed" />}
      {feed.error && <MuseError error={feed.error} />}
      {!problem && !hasFilter && feed.data?.length === 0 && <MuseEmpty>No work updates recorded yet.</MuseEmpty>}
      {!problem && hasFilter && !feed.isPending && !feed.error && rows.length === 0 && (
        <MuseEmpty>No updates match these filters.</MuseEmpty>
      )}

      <div className="space-y-3">
        {rows.map((row) => (
          <Card key={row.id}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <CardTitle className="text-base">{row.actor ?? "unknown actor"}</CardTitle>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="secondary" className="font-mono text-[10px]">{row.update_type ?? "NOTE"}</Badge>
                  {row.domain_key && <Badge variant="outline" className="font-mono text-[10px]">{row.domain_key}</Badge>}
                  <span className="text-xs text-muted-foreground">{formatAge(row.created_at)}</span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="whitespace-pre-wrap text-sm">{row.message}</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Task">{row.task_id}</Field>
                <Field label="Improvement">{row.improvement_id}</Field>
                <Field label="Mission">{row.mission_id}</Field>
                {row.evidence_ref && <Field label="Evidence">{row.evidence_ref}</Field>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

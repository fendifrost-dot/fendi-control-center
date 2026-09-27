/**
 * Mission board — portfolio objectives.
 *
 * A mission is an outcome with a metric, baseline and target. Implementation
 * work never hangs off a mission directly; it hangs off the improvements that
 * serve it, which are rolled up here.
 */
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useMuseMissions } from "@/lib/muse/museClient";
import { formatDue, formatKpiValue, priorityRank } from "@/lib/muse/museFormat";
import {
  DataStatusBadge,
  Field,
  MuseEmpty,
  MuseError,
  MuseLoading,
  MusePageHeader,
  PriorityBadge,
} from "@/components/muse/MuseBits";

type Filter = "live" | "all";

export default function MuseMissionsPage() {
  const missions = useMuseMissions();
  const [filter, setFilter] = useState<Filter>("live");

  const rows = useMemo(() => {
    const all = [...(missions.data ?? [])].sort(
      (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
    );
    if (filter === "all") return all;
    return all.filter((m) => m.status === "ACTIVE" || m.status === "PROPOSED" || m.status === "PAUSED");
  }, [missions.data, filter]);

  return (
    <div>
      <MusePageHeader
        title="Mission board"
        description="Portfolio objectives: the business outcome, the metric that proves it, where it started and where it should end. Missions are outcomes, not tasks — the work that serves them lives on the daily improvement board."
        right={
          <div className="flex flex-wrap gap-1">
            {(["live", "all"] as Filter[]).map((f) => (
              <Button
                key={f}
                type="button"
                size="sm"
                variant={filter === f ? "default" : "outline"}
                onClick={() => setFilter(f)}
                className="capitalize"
              >
                {f}
              </Button>
            ))}
          </div>
        }
      />

      {missions.isPending && <MuseLoading label="Reading missions" />}
      {missions.error && <MuseError error={missions.error} />}

      {missions.data && rows.length === 0 && (
        <MuseEmpty>
          No missions recorded. The board is wired — a mission appears when Fendi or Muse sets a
          portfolio objective with a metric. Nothing is invented to fill it.
        </MuseEmpty>
      )}

      {rows.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map((m) => (
            <Card key={m.id}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-mono text-[10px] uppercase text-muted-foreground">
                      {m.domain_name}
                    </div>
                    <CardTitle className="mt-0.5 text-base">{m.title}</CardTitle>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <PriorityBadge priority={m.priority} />
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {m.status}
                    </Badge>
                    <DataStatusBadge status={m.data_status} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm">{m.objective}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Metric">{m.metric}</Field>
                  <Field label="Now">
                    {m.current_value !== null
                      ? formatKpiValue(m.current_value, m.current_unit)
                      : <span className="text-muted-foreground">not measured</span>}
                  </Field>
                  <Field label="Baseline">{m.baseline}</Field>
                  <Field label="Target">{m.target}</Field>
                  <Field label="Owner / sponsor">
                    {m.owner} · {m.executive_sponsor}
                  </Field>
                  <Field label="Review">
                    {formatDue(m.review_date)}
                    {m.review_overdue && (
                      <span className="ml-2 font-mono text-[10px] text-amber-600 dark:text-amber-500">
                        overdue
                      </span>
                    )}
                  </Field>
                  {m.business_outcome && <Field label="Business outcome">{m.business_outcome}</Field>}
                  {m.owner_attention !== "NONE" && (
                    <Field label="Owner attention">{m.owner_attention.replace(/_/g, " ").toLowerCase()}</Field>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border/60 pt-2 font-mono text-[11px] text-muted-foreground">
                  <span>{m.improvements_active} active</span>
                  <span>{m.improvements_kept} kept</span>
                  <span>{m.improvements_reversed} reversed</span>
                  <span>{m.open_tasks} open tasks</span>
                  <span>{m.improvements_total} total improvements</span>
                </div>
                {m.dependencies?.length > 0 && (
                  <p className="text-xs text-muted-foreground">depends on: {m.dependencies.join(", ")}</p>
                )}
                {m.notes && <p className="text-xs leading-relaxed text-muted-foreground">{m.notes}</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

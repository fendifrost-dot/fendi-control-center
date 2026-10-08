import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MuseEmpty, MuseError, MuseLoading, MusePageHeader, Field, VerificationBadge } from "@/components/muse/MuseBits";
import { useMuseDailyImprovements } from "@/lib/muse/workboardClient";
import { formatDue } from "@/lib/muse/museFormat";

export default function MuseDailyImprovementPage() {
  const rows = useMuseDailyImprovements();

  return (
    <div>
      <MusePageHeader
        title="Daily improvement"
        description="One high-leverage, low-regret improvement at a time. Observe instead of changing when an active experiment still needs measurement."
        right={rows.data && <div className="text-xs text-muted-foreground">{rows.data.filter((r) => r.review_due).length} due for review</div>}
      />

      {rows.isPending && <MuseLoading label="Reading daily improvements" />}
      {rows.error && <MuseError error={rows.error} />}
      {rows.data?.length === 0 && <MuseEmpty>No daily improvements recorded yet.</MuseEmpty>}

      <div className="space-y-4">
        {rows.data?.map((r) => (
          <Card key={r.id}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base">{r.intervention}</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">{r.observation ?? r.problem}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {r.priority && <Badge variant="outline" className="font-mono text-[10px]">{r.priority}</Badge>}
                  <Badge variant="secondary" className="font-mono text-[10px]">{r.status}</Badge>
                  <Badge variant="outline" className="font-mono text-[10px]">{r.verdict}</Badge>
                  <VerificationBadge state={r.verification_state} />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Date">{r.improvement_date}</Field>
                <Field label="Domain">{r.domain_name}</Field>
                <Field label="Function">{r.function_name}</Field>
                <Field label="Mission">{r.mission_title}</Field>
                <Field label="Metric">{r.metric}</Field>
                <Field label="Baseline">{r.baseline}</Field>
                <Field label="Expected impact">{r.expected_impact}</Field>
                <Field label="Owner">{r.owner}</Field>
                <Field label="Recommended executor">{r.recommended_executor}</Field>
                <Field label="Owner attention">{r.owner_attention ?? "NONE"}</Field>
                <Field label="Review">{formatDue(r.review_at)}</Field>
                <Field label="Execution">{r.tasks_complete}/{r.task_count} tasks complete · {r.tasks_blocked} blocked</Field>
                <Field label="Measurements">{r.measurement_count}</Field>
              </div>
              {r.observe_only_reason && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                  <span className="font-medium">Observe — no change yet:</span> {r.observe_only_reason}
                </div>
              )}
              {r.definition_of_done && <Field label="Definition of done">{r.definition_of_done}</Field>}
              {r.actual_result && <Field label="Actual result">{r.actual_result}</Field>}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

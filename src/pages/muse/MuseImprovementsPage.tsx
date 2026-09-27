/**
 * Impact ledger — did the change improve the business?
 *
 * Completion is not the question here. Each implemented intervention is shown
 * against its baseline at the immediate, 7-day and 30-day checkpoints, with
 * money, time, side effects and the verdict. Below it, the full improvement
 * ledger (the v1 1% cycle), so nothing that was tried is lost.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useMuseImpact, useMuseImprovements } from "@/lib/muse/museClient";
import { formatAge, formatDelta, formatDue, formatKpiValue } from "@/lib/muse/museFormat";
import {
  DataStatusBadge,
  Field,
  MuseEmpty,
  MuseError,
  MuseLoading,
  MusePageHeader,
  VerdictBadge,
  VerificationBadge,
} from "@/components/muse/MuseBits";

const n = (v: number | null) => (v === null ? "—" : formatKpiValue(v, "count"));

export default function MuseImprovementsPage() {
  const impact = useMuseImpact();
  const ledger = useMuseImprovements();

  const due = (impact.data ?? []).filter((r) => r.d7_due || r.d30_due).length;

  return (
    <div>
      <MusePageHeader
        title="Impact ledger"
        description="Whether work improved the business, not whether it was finished. Deployment starts a measurement window; only measured, verified results justify KEEP — and every verdict becomes institutional memory."
        right={<div className="text-xs text-muted-foreground">{due} checkpoint(s) due</div>}
      />

      {impact.isPending && <MuseLoading label="Reading the impact ledger" />}
      {impact.error && <MuseError error={impact.error} />}

      {impact.data && impact.data.length === 0 && (
        <MuseEmpty>
          No intervention has been implemented and measured yet. Rows appear here once a verified
          change enters its measurement window.
        </MuseEmpty>
      )}

      {impact.data && impact.data.length > 0 && (
        <div className="space-y-4">
          {impact.data.map((r) => (
            <Card key={r.id}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-mono text-[10px] uppercase text-muted-foreground">
                      {r.domain_name}
                      {r.function_area && ` · ${r.function_area}`}
                    </div>
                    <CardTitle className="mt-0.5 text-base">{r.intervention}</CardTitle>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {r.status}
                    </Badge>
                    <VerdictBadge verdict={r.verdict} />
                    <DataStatusBadge status={r.data_status} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  <Field label="Baseline">{r.baseline_value !== null ? n(r.baseline_value) : r.baseline}</Field>
                  <Field label="Immediate">{n(r.immediate_value)}</Field>
                  <Field label="7-day">
                    {n(r.d7_value)}
                    {r.d7_due && <span className="ml-1 font-mono text-[10px] text-amber-600 dark:text-amber-500">due</span>}
                  </Field>
                  <Field label="30-day">
                    {n(r.d30_value)}
                    {r.d30_due && <span className="ml-1 font-mono text-[10px] text-amber-600 dark:text-amber-500">due</span>}
                  </Field>
                  <Field label="Delta">{formatDelta(r.metric_delta)}</Field>
                  <Field label="Implemented">{formatAge(r.implemented_at)}</Field>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Metric">{r.metric}</Field>
                  <Field label="Expected">{r.expected_result}</Field>
                  <Field label="Financial impact">
                    {r.financial_impact_usd !== null ? formatKpiValue(r.financial_impact_usd, "USD") : "not measured"}
                  </Field>
                  <Field label="Time saved">
                    {r.time_saved_minutes !== null ? `${r.time_saved_minutes} min` : "not measured"}
                  </Field>
                  {r.unintended_consequences && (
                    <Field label="Unintended consequences">{r.unintended_consequences}</Field>
                  )}
                  {r.next_iteration && <Field label="Next iteration">{r.next_iteration}</Field>}
                  <Field label="Review">{formatDue(r.review_at)}</Field>
                  <Field label="Measurements">{r.measurement_count}</Field>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <h2 className="mb-3 mt-8 text-sm font-semibold">All improvements</h2>
      {ledger.isPending && <MuseLoading label="Reading the ledger" />}
      {ledger.error && <MuseError error={ledger.error} />}
      {ledger.data && ledger.data.length === 0 && (
        <MuseEmpty>No improvements recorded yet.</MuseEmpty>
      )}
      {ledger.data && ledger.data.length > 0 && (
        <div className="space-y-2">
          {ledger.data.map((row) => (
            <div key={row.id} className="rounded-md border border-border/70 px-3 py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {row.kind === "OBSERVE" ? "OBSERVE — NO CHANGE YET" : row.intervention}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {row.domain_name} · {row.metric}
                    {row.improvement_date && ` · ${row.improvement_date}`}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {row.actual_result ??
                      (row.awaiting_measurement ? "awaiting measurement" : "not measured")}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {row.status}
                  </Badge>
                  <VerdictBadge verdict={row.verdict} />
                  <VerificationBadge state={row.verification_state} />
                  {row.review_due && (
                    <span className="font-mono text-[10px] text-amber-600 dark:text-amber-500">review due</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

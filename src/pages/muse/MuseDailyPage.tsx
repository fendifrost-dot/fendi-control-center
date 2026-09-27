/**
 * Daily improvement — the operational 1%.
 *
 * Today's primary outcome is either ONE intervention or an explicit
 * "OBSERVE — NO CHANGE YET". Active experiments and under-attended domains are
 * shown alongside so the choice is made with collisions and rotation in view.
 */
import { useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useMuseImprovements, useMusePortfolio } from "@/lib/muse/museClient";
import { formatAge, formatDue, IMPROVEMENT_FLOW, localIsoDate } from "@/lib/muse/museFormat";
import {
  DataStatusBadge,
  Field,
  MuseEmpty,
  MuseError,
  MuseLoading,
  MusePageHeader,
  PriorityBadge,
  VerdictBadge,
  VerificationBadge,
} from "@/components/muse/MuseBits";
import type { MuseImprovementRow } from "@/lib/muse/types";

function DailyCard({ row }: { row: MuseImprovementRow }) {
  const observe = row.kind === "OBSERVE";
  return (
    <Card className={observe ? "border-dashed" : undefined}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase text-muted-foreground">
              {row.domain_name}
              {row.function_area && ` · ${row.function_area}`}
              {row.improvement_date && ` · ${row.improvement_date}`}
            </div>
            <CardTitle className="mt-0.5 text-base">
              {observe ? "OBSERVE — NO CHANGE YET" : row.intervention}
            </CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {row.is_primary && (
              <Badge variant="default" className="font-mono text-[10px]">
                primary
              </Badge>
            )}
            <PriorityBadge priority={row.priority} />
            <Badge variant="outline" className="font-mono text-[10px]">
              {row.status}
            </Badge>
            <VerdictBadge verdict={row.verdict} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Observation">{row.observation}</Field>
          {!observe && <Field label="Problem">{row.problem}</Field>}
          {!observe && <Field label="Hypothesis">{row.hypothesis}</Field>}
          <Field label="Metric">
            {row.metric}
            {row.metric_data_status && (
              <span className="ml-2">
                <DataStatusBadge status={row.metric_data_status} />
              </span>
            )}
          </Field>
          <Field label="Baseline">{row.baseline}</Field>
          {!observe && <Field label="Expected impact">{row.expected_result}</Field>}
          {!observe && (
            <Field label="Risk / reversible / confidence">
              {(row.risk ?? "?").toLowerCase()} · {(row.reversibility ?? "?").toLowerCase().replace(/_/g, " ")} ·{" "}
              {(row.confidence ?? "?").toLowerCase()}
            </Field>
          )}
          <Field label="Owner → executor">
            {row.owner}
            {row.recommended_executor && ` → ${row.recommended_executor}`}
          </Field>
          <Field label="Selected">
            {row.selected_by ? `${row.selected_by}, ${formatAge(row.selected_at)}` : "not yet"}
          </Field>
          <Field label="Owner attention">
            {row.owner_attention.replace(/_/g, " ").toLowerCase()}
            {row.awaiting_owner && (
              <span className="ml-2 font-mono text-[10px] text-amber-600 dark:text-amber-500">
                awaiting Fendi
              </span>
            )}
          </Field>
          {!observe && (
            <Field label="Verification">
              <span className="inline-flex flex-wrap items-center gap-1">
                <VerificationBadge state={row.verification_state} />
                <span className="text-xs text-muted-foreground">needs</span>
                <VerificationBadge state={row.verification_requirement} />
              </span>
            </Field>
          )}
          {!observe && (
            <Field label="Measurement">
              {row.measurement_window_days !== null ? `${row.measurement_window_days} days` : "—"}
              {row.review_at && ` · review ${formatDue(row.review_at)}`}
            </Field>
          )}
          {!observe && (
            <Field label="Execution">
              {row.execution_state.replace(/_/g, " ").toLowerCase()} · {row.open_tasks} open ·{" "}
              {row.completed_tasks} done
            </Field>
          )}
          {row.mission_title && <Field label="Mission">{row.mission_title}</Field>}
        </div>

        {!observe && row.definition_of_done.length > 0 && (
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              Definition of done
            </div>
            <ul className="mt-1 list-inside list-disc text-sm">
              {row.definition_of_done.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </div>
        )}

        {(row.collision_count > 0 || row.same_function_open_tasks > 0) && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
            {row.collision_count > 0 && (
              <div>
                Collides with {row.collision_count} active experiment(s) on the same metric:{" "}
                {row.collision_with}
                {row.collision_override && <> — override: {row.collision_override}</>}
              </div>
            )}
            {row.same_function_open_tasks > 0 && (
              <div>
                {row.same_function_open_tasks} open task(s) elsewhere already work this function in
                this domain.
              </div>
            )}
          </div>
        )}
        {row.notes && <p className="text-xs leading-relaxed text-muted-foreground">{row.notes}</p>}
      </CardContent>
    </Card>
  );
}

export default function MuseDailyPage() {
  const ledger = useMuseImprovements();
  const portfolio = useMusePortfolio();
  const today = localIsoDate();

  const { todays, recent, active } = useMemo(() => {
    const rows = ledger.data ?? [];
    const daily = rows.filter((r) => r.improvement_date !== null);
    return {
      todays: daily
        .filter((r) => r.improvement_date === today && r.status !== "REJECTED")
        .sort((a, b) => Number(b.is_primary) - Number(a.is_primary)),
      recent: daily
        .filter((r) => r.improvement_date !== today)
        .sort((a, b) => (b.improvement_date ?? "").localeCompare(a.improvement_date ?? ""))
        .slice(0, 14),
      active: rows.filter((r) => r.is_active_experiment),
    };
  }, [ledger.data, today]);

  const underAttended = (portfolio.data ?? []).filter((d) => d.attention_flag === "UNDER_ATTENDED");
  const historyPending = (portfolio.data ?? []).every((d) => d.attention_flag === "INSUFFICIENT_HISTORY");

  return (
    <div>
      <MusePageHeader
        title="Daily improvement"
        description="The smallest high-confidence change that permanently improves the portfolio today — or a deliberate OBSERVE while an experiment measures. Selection, assignment and execution are separate states; a suggestion here never touches production by itself."
        right={<span className="font-mono text-xs text-muted-foreground">{today}</span>}
      />

      {ledger.isPending && <MuseLoading label="Reading the daily board" />}
      {ledger.error && <MuseError error={ledger.error} />}

      {ledger.data && (
        <div className="space-y-6">
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Today</h2>
            {todays.length === 0 ? (
              <MuseEmpty>
                No daily outcome recorded for today yet. Muse records either one intervention or
                OBSERVE — NO CHANGE YET. An empty day is not a day without a decision; it is a day the
                decision has not been written down.
              </MuseEmpty>
            ) : (
              todays.map((row) => <DailyCard key={row.id} row={row} />)
            )}
          </section>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Active experiments</CardTitle>
              <CardDescription>
                A metric listed here is being measured. A new change on it would contaminate the
                result — the database refuses a second selection unless an override is recorded.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {active.length === 0 ? (
                <MuseEmpty>No experiment is running, so no metric is protected right now.</MuseEmpty>
              ) : (
                <ul className="space-y-2">
                  {active.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{r.intervention}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {r.domain_name} · {r.metric}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {r.status}
                        </Badge>
                        {r.review_at && <span>review {formatDue(r.review_at)}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Portfolio rotation</CardTitle>
              <CardDescription>
                Work should flow to the highest-value constraint, not be spread evenly. A domain is
                flagged only when it has open problems and no improvement in 30 days — a flag for Muse,
                never a reason to invent work.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {portfolio.error && <MuseError error={portfolio.error} />}
              {historyPending ? (
                <MuseEmpty>
                  Less than 30 days of daily-board history. Rotation cannot be judged yet, so no domain is
                  flagged.
                </MuseEmpty>
              ) : underAttended.length === 0 ? (
                <MuseEmpty>No domain is under-attended.</MuseEmpty>
              ) : (
                <ul className="space-y-1 text-sm">
                  {underAttended.map((d) => (
                    <li key={d.domain_key} className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="font-mono text-[10px]">
                        UNDER-ATTENDED
                      </Badge>
                      <span>{d.name}</span>
                      <span className="text-xs text-muted-foreground">
                        last improvement {formatAge(d.last_improvement_at)} · {d.open_loops} open loops
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Lifecycle</CardTitle>
              <CardDescription>Who holds the pen at each state. Enforced by the database.</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {IMPROVEMENT_FLOW.map((step, i) => (
                  <li key={step.status} className="rounded-md border border-border/70 px-3 py-2">
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {i + 1}. {step.owner}
                    </div>
                    <div className="font-mono text-xs font-medium">{step.status}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{step.meaning}</div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Recent days</h2>
            {recent.length === 0 ? (
              <MuseEmpty>No earlier daily outcomes recorded.</MuseEmpty>
            ) : (
              recent.map((row) => <DailyCard key={row.id} row={row} />)
            )}
          </section>
        </div>
      )}
    </div>
  );
}

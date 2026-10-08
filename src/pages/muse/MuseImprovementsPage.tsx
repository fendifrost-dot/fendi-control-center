/**
 * 1% improvement ledger — surface 4.
 * A verdict is only meaningful next to a measured result and a verification
 * state, so both are shown on every row.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useMuseImprovements } from "@/lib/muse/museClient";
import { formatAge, formatDue } from "@/lib/muse/museFormat";
import {
  DataStatusBadge,
  Field,
  MuseEmpty,
  MuseError,
  MuseLoading,
  MusePageHeader,
  VerificationBadge,
} from "@/components/muse/MuseBits";

const verdictTone = (v: string) =>
  v === "KEEP" ? "default" : v === "REVERSE" ? "destructive" : v === "REVISE" ? "secondary" : "outline";

export default function MuseImprovementsPage() {
  const ledger = useMuseImprovements();

  return (
    <div>
      <MusePageHeader
        title="1% improvement ledger"
        description="One row per intervention: baseline, problem, what changed, the metric, and the keep/revise/reverse call. A result that has only been claimed is never shown as measured."
        right={
          ledger.data && (
            <div className="text-xs text-muted-foreground">
              {ledger.data.filter((r) => r.review_due).length} due for review
            </div>
          )
        }
      />

      {ledger.isPending && <MuseLoading label="Reading the ledger" />}
      {ledger.error && <MuseError error={ledger.error} />}

      {ledger.data && ledger.data.length === 0 && (
        <MuseEmpty>
          No interventions recorded. The ledger is ready — add a row when the next 1% change starts.
        </MuseEmpty>
      )}

      {ledger.data && ledger.data.length > 0 && (
        <div className="space-y-4">
          {ledger.data.map((row) => (
            <Card key={row.id}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <CardTitle className="text-base">{row.intervention}</CardTitle>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {row.status}
                    </Badge>
                    <Badge variant={verdictTone(row.verdict)} className="font-mono text-[10px]">
                      {row.verdict}
                    </Badge>
                    <VerificationBadge state={row.verification_state} />
                    <DataStatusBadge status={row.data_status} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Domain">{row.domain_name}</Field>
                  <Field label="Owner">{row.owner}</Field>
                  <Field label="Problem">{row.problem}</Field>
                  <Field label="Baseline">{row.baseline}</Field>
                  <Field label="Metric">{row.metric}</Field>
                  <Field label="Expected result">{row.expected_result}</Field>
                  <Field label="Actual result">
                    {row.actual_result ?? (
                      <span className="text-muted-foreground">
                        {row.awaiting_measurement ? "awaiting measurement" : "not measured"}
                      </span>
                    )}
                  </Field>
                  <Field label="Started">{formatAge(row.started_at)}</Field>
                  <Field label="Review">
                    {formatDue(row.review_at)}
                    {row.review_due && (
                      <span className="ml-2 font-mono text-[10px] text-amber-600 dark:text-amber-500">
                        due
                      </span>
                    )}
                  </Field>
                  {row.source_ref && <Field label="Reference">{row.source_ref}</Field>}
                </div>
                {row.notes && (
                  <p className="text-xs leading-relaxed text-muted-foreground">{row.notes}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

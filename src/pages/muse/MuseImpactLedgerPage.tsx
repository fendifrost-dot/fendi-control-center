import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MuseEmpty, MuseError, MuseLoading, MusePageHeader, Field, VerificationBadge } from "@/components/muse/MuseBits";
import { useMuseImprovementResults } from "@/lib/muse/workboardClient";
import { formatDue } from "@/lib/muse/museFormat";

const verdictVariant = (v: string) => v === "KEEP" ? "default" : v === "REVERSE" ? "destructive" : "secondary";

export default function MuseImpactLedgerPage() {
  const results = useMuseImprovementResults();

  return (
    <div>
      <MusePageHeader
        title="Impact ledger"
        description="Completion is not the same as improvement. This ledger records what changed, what the metric did, and whether the intervention should be kept, revised, or reversed."
        right={results.data && <div className="text-xs text-muted-foreground">{results.data.filter((r) => r.measurement_count > 0).length} measured</div>}
      />

      {results.isPending && <MuseLoading label="Reading impact ledger" />}
      {results.error && <MuseError error={results.error} />}
      {results.data?.length === 0 && <MuseEmpty>No measured improvements yet.</MuseEmpty>}

      <div className="space-y-4">
        {results.data?.map((r) => (
          <Card key={r.improvement_id}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base">{r.intervention}</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">{r.metric}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant={verdictVariant(r.verdict)} className="font-mono text-[10px]">{r.verdict}</Badge>
                  <VerificationBadge state={r.verification_state} />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Domain">{r.domain_name}</Field>
                <Field label="Baseline">{r.baseline}</Field>
                <Field label="Actual result">{r.actual_result}</Field>
                <Field label="Latest measurement">{r.latest_measurement_type ? `${r.latest_measurement_type}: ${r.latest_value ?? "—"}` : "not measured"}</Field>
                <Field label="Latest delta">{r.latest_delta}</Field>
                <Field label="Measurements">{r.measurement_count}</Field>
                <Field label="Recorded financial impact">{r.recorded_financial_impact || 0}</Field>
                <Field label="Recorded time saved">{r.recorded_time_saved_minutes || 0} min</Field>
                <Field label="Review">{formatDue(r.review_at)}</Field>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

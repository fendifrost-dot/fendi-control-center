/**
 * Portfolio map — surface 2. One card per domain: status, owner, systems,
 * source of truth, current KPI, bottleneck, initiative, next review.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useMuseKpis, useMusePortfolio } from "@/lib/muse/museClient";
import { formatAge, formatDue, formatKpiValue } from "@/lib/muse/museFormat";
import {
  DataStatusBadge,
  Field,
  MuseEmpty,
  MuseError,
  MuseLoading,
  MusePageHeader,
} from "@/components/muse/MuseBits";
import type { MuseKpiRow, MusePortfolioRow } from "@/lib/muse/types";

function Counter({ label, value, tone }: { label: string; value: number; tone?: "warn" | "bad" }) {
  const cls =
    value === 0
      ? "text-muted-foreground"
      : tone === "bad"
        ? "text-destructive"
        : tone === "warn"
          ? "text-amber-600 dark:text-amber-500"
          : "text-foreground";
  return (
    <div className="text-center">
      <div className={`text-lg font-semibold tabular-nums ${cls}`}>{value}</div>
      <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function DomainCard({ row, kpis }: { row: MusePortfolioRow; kpis: MuseKpiRow[] }) {
  const domainKpis = kpis.filter((k) => k.domain_key === row.domain_key);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-base">{row.name}</CardTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="font-mono text-[10px]">
              {row.status}
            </Badge>
            <DataStatusBadge status={row.data_status} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          <Counter label="loops" value={row.open_loops} tone="warn" />
          <Counter label="blocked" value={row.blocked_loops} tone="bad" />
          <Counter label="decisions" value={row.decisions_pending} tone="warn" />
          <Counter label="conflicts" value={row.open_conflicts} tone="bad" />
          <Counter label="unhealthy" value={row.unhealthy_systems} tone="bad" />
          <Counter label="1% active" value={row.active_improvements} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Owner">{row.owner}</Field>
          <Field label="Source of truth">
            {row.source_of_truth ?? (
              <span className="text-muted-foreground">Not identified — see Sources</span>
            )}
          </Field>
          <Field label="Current KPI">
            {row.primary_kpi_name ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {formatKpiValue(row.primary_kpi_value, row.primary_kpi_unit)}
                </span>
                <span className="text-xs text-muted-foreground">{row.primary_kpi_name}</span>
                <DataStatusBadge status={row.primary_kpi_status} />
              </span>
            ) : (
              <span className="text-muted-foreground">No metric defined</span>
            )}
          </Field>
          <Field label="Next review">
            {row.next_review_at ? formatDue(row.next_review_at) : "not scheduled"}
          </Field>
          <Field label="Current bottleneck">{row.current_bottleneck}</Field>
          <Field label="Current initiative">{row.current_initiative}</Field>
          <Field label="Systems">
            {row.systems && row.systems.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {row.systems.map((s) => (
                  <Badge key={s} variant="secondary" className="font-mono text-[10px]">
                    {s}
                  </Badge>
                ))}
              </span>
            ) : (
              <span className="text-muted-foreground">none registered</span>
            )}
          </Field>
          <Field label="Sources last verified">{formatAge(row.sources_last_verified_at)}</Field>
        </div>

        {domainKpis.length > 0 && (
          <div className="rounded-md border border-border/60">
            <table className="w-full text-sm">
              <tbody>
                {domainKpis.map((k) => (
                  <tr key={k.metric_key} className="border-b border-border/40 last:border-0">
                    <td className="px-3 py-1.5">{k.name}</td>
                    <td className="px-3 py-1.5 text-right font-medium tabular-nums">
                      {formatKpiValue(k.value, k.unit)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <DataStatusBadge status={k.data_status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {row.notes && <p className="text-xs leading-relaxed text-muted-foreground">{row.notes}</p>}
      </CardContent>
    </Card>
  );
}

export default function MusePortfolioPage() {
  const portfolio = useMusePortfolio();
  const kpis = useMuseKpis();

  return (
    <div>
      <MusePageHeader
        title="Portfolio map"
        description="Every domain Fendi runs, with the system that owns its truth. A domain with no connected source says so rather than showing zeros."
      />

      {portfolio.isPending && <MuseLoading label="Reading the portfolio" />}
      {portfolio.error && <MuseError error={portfolio.error} />}

      {portfolio.data && portfolio.data.length === 0 && (
        <MuseEmpty>No domains registered. Seed muse_domains to populate the portfolio map.</MuseEmpty>
      )}

      {portfolio.data && portfolio.data.length > 0 && (
        <div className="space-y-4">
          {portfolio.data.map((row) => (
            <DomainCard key={row.domain_key} row={row} kpis={kpis.data ?? []} />
          ))}
        </div>
      )}
    </div>
  );
}

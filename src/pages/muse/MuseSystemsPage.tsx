/**
 * System & agent health — surface 6.
 *
 * Observed systems are grouped apart from ones Muse cannot reach, so an
 * unconnected system is never mistaken for a quiet healthy one.
 */
import { useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useMuseSystems } from "@/lib/muse/museClient";
import { formatAge } from "@/lib/muse/museFormat";
import {
  ClassificationBadge,
  DataStatusBadge,
  MuseEmpty,
  MuseError,
  MuseLoading,
  MusePageHeader,
  SystemStatusBadge,
} from "@/components/muse/MuseBits";
import type { MuseSystemHealthRow } from "@/lib/muse/types";

function SystemTable({ rows, observed }: { rows: MuseSystemHealthRow[]; observed: boolean }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>System / role</TableHead>
            <TableHead className="w-[8rem]">Status</TableHead>
            <TableHead className="w-[9rem]">Cadence</TableHead>
            {observed && <TableHead className="w-[8rem]">Last success</TableHead>}
            {observed && <TableHead className="w-[8rem]">Last failure</TableHead>}
            <TableHead>{observed ? "Blocker / impact" : "Blocker"}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.system_key}>
              <TableCell className="max-w-[18rem]">
                <div className="text-sm font-medium">{row.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{row.role}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <ClassificationBadge value={row.classification} />
                  {row.waits_on_human && row.pending_count > 0 && (
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      {row.pending_count} awaiting Fendi
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <SystemStatusBadge status={row.status} />
                  <DataStatusBadge status={row.data_status} />
                  {!row.waits_on_human && row.pending_count > 0 && (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {row.pending_count} queued
                    </span>
                  )}
                  {row.failing_count > 0 && (
                    <span className="font-mono text-[10px] text-destructive">
                      {row.failing_count} errors / 7d
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {row.expected_cadence}
                {row.cadence_minutes !== null && (
                  <div className="mt-0.5 font-mono text-[10px]">{row.cadence_minutes}m</div>
                )}
              </TableCell>
              {observed && (
                <TableCell className="text-xs">{formatAge(row.last_success_at)}</TableCell>
              )}
              {observed && (
                <TableCell className="text-xs">
                  {formatAge(row.last_failure_at)}
                  {row.last_failure_detail && (
                    <div
                      className="mt-0.5 max-w-[12rem] truncate font-mono text-[10px] text-destructive"
                      title={row.last_failure_detail}
                    >
                      {row.last_failure_detail}
                    </div>
                  )}
                </TableCell>
              )}
              <TableCell className="max-w-[16rem]">
                {row.blocker && <div className="text-xs text-amber-600 dark:text-amber-500">{row.blocker}</div>}
                {row.downstream_impact && (
                  <div className="mt-0.5 text-xs text-muted-foreground">{row.downstream_impact}</div>
                )}
                {!row.blocker && !row.downstream_impact && <span className="text-xs">—</span>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function MuseSystemsPage() {
  const systems = useMuseSystems();

  const { observed, unobserved, failing } = useMemo(() => {
    const all = systems.data ?? [];
    return {
      observed: all.filter((s) => s.probe_key !== null),
      unobserved: all.filter((s) => s.probe_key === null),
      failing: all.filter((s) => s.status === "FAILING" || s.status === "STALE"),
    };
  }, [systems.data]);

  return (
    <div>
      <MusePageHeader
        title="System & agent health"
        description="Every agent, function, webhook and queue Muse watches, with its expected cadence, last success, last failure and downstream impact. Health is derived from the table that owns each fact — Muse stores no last-run state."
        right={
          systems.data && (
            <div className="flex flex-col items-end gap-1 text-xs text-muted-foreground">
              <span>
                {observed.length} observed · {unobserved.length} not connected
              </span>
              {failing.length > 0 && (
                <Badge variant="destructive" className="font-mono text-[10px]">
                  {failing.length} failing or stale
                </Badge>
              )}
            </div>
          )
        }
      />

      {systems.isPending && <MuseLoading label="Reading system health" />}
      {systems.error && <MuseError error={systems.error} />}

      {systems.data && (
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Observed by Control Hub</CardTitle>
              <CardDescription>
                Telemetry read live from the owning tables. A system with no runs on record reads{" "}
                <span className="font-mono">NEVER_RAN</span>, never healthy.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {observed.length === 0 ? (
                <MuseEmpty>No systems have a telemetry probe configured.</MuseEmpty>
              ) : (
                <SystemTable rows={observed} observed />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Known but not connected</CardTitle>
              <CardDescription>
                These systems exist and matter, but Control Hub cannot read their state yet. Coverage
                is not being faked — each row names what is missing.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {unobserved.length === 0 ? (
                <MuseEmpty>Every registered system is connected.</MuseEmpty>
              ) : (
                <SystemTable rows={unobserved} observed={false} />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

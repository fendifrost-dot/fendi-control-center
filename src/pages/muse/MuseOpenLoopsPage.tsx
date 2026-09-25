/**
 * Open loops — surface 3, plus the decision register.
 *
 * Shows the derived state alongside the stored one, so it is visible when the
 * authoritative system, rather than a person, closed a loop.
 */
import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useMuseDecisions, useMuseOpenLoops } from "@/lib/muse/museClient";
import { formatAge, formatDue, priorityRank } from "@/lib/muse/museFormat";
import {
  ClassificationBadge,
  DataStatusBadge,
  MuseEmpty,
  MuseError,
  MuseLoading,
  MusePageHeader,
  PriorityBadge,
  StateBadge,
} from "@/components/muse/MuseBits";

type Filter = "open" | "all" | "blocked" | "waiting";

export default function MuseOpenLoopsPage() {
  const loops = useMuseOpenLoops();
  const decisions = useMuseDecisions();
  const [filter, setFilter] = useState<Filter>("open");

  const rows = useMemo(() => {
    const all = [...(loops.data ?? [])].sort(
      (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
    );
    if (filter === "all") return all;
    if (filter === "blocked") return all.filter((r) => r.state === "BLOCKED");
    if (filter === "waiting") return all.filter((r) => r.state === "WAITING");
    return all.filter((r) => r.state !== "RESOLVED" && r.state !== "CANCELLED");
  }, [loops.data, filter]);

  const derivedClosures = (loops.data ?? []).filter(
    (r) => r.state === "RESOLVED" && r.stored_state !== "RESOLVED",
  ).length;

  return (
    <div>
      <MusePageHeader
        title="Open loops"
        description="Unfinished work with an owner, a dependency and a next action. Where a loop is tied to a system, its resolution comes from that system — an untouched row cannot stay open just because nobody updated it."
        right={
          <div className="flex flex-wrap gap-1">
            {(["open", "blocked", "waiting", "all"] as Filter[]).map((f) => (
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

      {loops.isPending && <MuseLoading label="Reading open loops" />}
      {loops.error && <MuseError error={loops.error} />}

      {loops.data && (
        <Card className="mb-6">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">Loops</CardTitle>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {derivedClosures > 0 && (
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {derivedClosures} closed by their system
                  </Badge>
                )}
                <Badge variant="outline" className="font-mono text-[10px]">
                  {rows.length}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <MuseEmpty>No loops match this filter.</MuseEmpty>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[3.5rem]">Pri</TableHead>
                      <TableHead>Loop</TableHead>
                      <TableHead className="w-[7rem]">State</TableHead>
                      <TableHead className="w-[9rem]">Owner / class</TableHead>
                      <TableHead className="w-[8rem]">Evidence</TableHead>
                      <TableHead className="w-[7rem]">Review</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>
                          <PriorityBadge priority={row.priority} />
                        </TableCell>
                        <TableCell className="max-w-[26rem]">
                          <div className="text-sm font-medium">{row.title}</div>
                          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                            {row.domain_name}
                            {row.category !== "OPERATIONAL" && ` · ${row.category.toLowerCase()}`}
                          </div>
                          {row.dependency && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              depends on: {row.dependency}
                            </div>
                          )}
                          {row.next_action && (
                            <div className="mt-1 text-xs">next: {row.next_action}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            <StateBadge state={row.state} />
                            {row.derive_resolution_from && (
                              <span
                                className="font-mono text-[10px] text-muted-foreground"
                                title={`Derived from ${row.derive_resolution_from} (${row.derived_system_status ?? "unknown"})`}
                              >
                                via {row.derive_resolution_from}
                              </span>
                            )}
                            {row.state !== row.stored_state && (
                              <span className="font-mono text-[10px] text-amber-600 dark:text-amber-500">
                                stored: {row.stored_state}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-xs">{row.owner ?? "—"}</div>
                          <div className="mt-1">
                            <ClassificationBadge value={row.classification} />
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-xs">{formatAge(row.last_evidence_at)}</div>
                          {row.evidence_stale && (
                            <div className="mt-1 font-mono text-[10px] text-amber-600 dark:text-amber-500">
                              stale
                            </div>
                          )}
                          <div className="mt-1">
                            <DataStatusBadge status={row.data_status} />
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-xs">{formatDue(row.review_at)}</div>
                          {row.review_overdue && (
                            <div className="mt-1 font-mono text-[10px] text-destructive">overdue</div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Decisions required</CardTitle>
          <CardDescription>
            Questions Muse cannot answer for Fendi. Options and evidence are recorded so the decision
            does not have to be reconstructed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {decisions.isPending && <MuseLoading label="Reading decisions" />}
          {decisions.error && <MuseError error={decisions.error} />}
          {decisions.data && decisions.data.length === 0 && (
            <MuseEmpty>No decisions are outstanding.</MuseEmpty>
          )}
          {decisions.data && decisions.data.length > 0 && (
            <ul className="space-y-3">
              {decisions.data.map((d) => (
                <li key={d.id} className="rounded-md border border-border/70 px-3 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{d.question}</div>
                      <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                        {d.domain_name} · owner {d.owner}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {d.overdue && (
                        <Badge variant="destructive" className="font-mono text-[10px]">
                          overdue
                        </Badge>
                      )}
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {formatDue(d.decision_required_by)}
                      </Badge>
                    </div>
                  </div>
                  {d.context && (
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{d.context}</p>
                  )}
                  {Array.isArray(d.options) && d.options.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {d.options.map((opt, i) => (
                        <li key={i} className="text-xs">
                          <span className="font-medium">{opt.option ?? `Option ${i + 1}`}</span>
                          {opt.pro && <span className="text-muted-foreground"> · pro: {opt.pro}</span>}
                          {opt.con && <span className="text-muted-foreground"> · con: {opt.con}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {Array.isArray(d.evidence) && d.evidence.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {d.evidence.map((e, i) => (
                        <Badge key={i} variant="secondary" className="max-w-full font-mono text-[10px]">
                          <span className="truncate">{String(e)}</span>
                        </Badge>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

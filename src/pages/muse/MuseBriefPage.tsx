/**
 * Executive brief — surface 1.
 * Every row is derived from muse_executive_brief; nothing here is hand-ranked.
 */
import { useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useMuseBrief, useMuseSystems } from "@/lib/muse/museClient";
import { BRIEF_SECTIONS, formatAge, formatDue } from "@/lib/muse/museFormat";
import {
  ClassificationBadge,
  DataStatusBadge,
  MuseEmpty,
  MuseError,
  MuseLoading,
  MusePageHeader,
  VerificationBadge,
} from "@/components/muse/MuseBits";
import type { MuseBriefRow } from "@/lib/muse/types";

function BriefItem({ row }: { row: MuseBriefRow }) {
  return (
    <li className="rounded-md border border-border/70 px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] text-muted-foreground">#{row.rank}</span>
            <span className="text-sm font-medium">{row.title}</span>
          </div>
          {row.detail && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{row.detail}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <ClassificationBadge value={row.classification} />
          <DataStatusBadge status={row.data_status} />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="font-mono">{row.domain_name}</span>
        {row.owner && <span>owner: {row.owner}</span>}
        {row.due_at && <span>{formatDue(row.due_at)}</span>}
        {row.source_ref && <span className="font-mono truncate max-w-[22rem]">{row.source_ref}</span>}
        <VerificationBadge state={row.verification_state} />
      </div>
    </li>
  );
}

export default function MuseBriefPage() {
  const brief = useMuseBrief();
  const systems = useMuseSystems();

  const bySection = useMemo(() => {
    const map = new Map<string, MuseBriefRow[]>();
    for (const row of brief.data ?? []) {
      const list = map.get(row.section) ?? [];
      list.push(row);
      map.set(row.section, list);
    }
    return map;
  }, [brief.data]);

  const observed = (systems.data ?? []).filter((s) => s.probe_key !== null).length;
  const unobserved = (systems.data ?? []).length - observed;

  return (
    <div>
      <MusePageHeader
        title="Executive brief"
        description="What needs Fendi, what is blocked, what is waiting, and what is broken — derived from the systems that own each fact, not restated by hand."
        right={
          brief.data && (
            <div className="flex flex-col items-end gap-1 text-xs text-muted-foreground">
              <span>read {formatAge(brief.data[0]?.as_of ?? new Date().toISOString())}</span>
              <span className="font-mono">
                {observed} systems observed · {unobserved} not connected
              </span>
            </div>
          )
        }
      />

      {brief.isPending && <MuseLoading label="Reading the brief" />}
      {brief.error && <MuseError error={brief.error} />}

      {brief.data && (
        <div className="space-y-5">
          {BRIEF_SECTIONS.map((section) => {
            const rows = bySection.get(section.key) ?? [];
            return (
              <Card key={section.key}>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base">{section.label}</CardTitle>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {rows.length}
                    </Badge>
                  </div>
                  <CardDescription>{section.blurb}</CardDescription>
                </CardHeader>
                <CardContent>
                  {rows.length === 0 ? (
                    <MuseEmpty>
                      Nothing recorded. This section is wired and empty because no real item exists
                      yet — not because everything here is fine.
                    </MuseEmpty>
                  ) : (
                    <ul className="space-y-2">
                      {rows.map((row) => (
                        <BriefItem key={`${row.section}-${row.item_id}-${row.rank}`} row={row} />
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

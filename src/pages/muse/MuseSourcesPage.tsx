/**
 * Source authority register — surface 5, with the conflict register beneath it.
 * Where two systems disagree, both sides stay visible and Muse only proposes an
 * authority.
 */
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
import { useMuseConflicts, useMuseSources } from "@/lib/muse/museClient";
import { formatAge } from "@/lib/muse/museFormat";
import {
  DataStatusBadge,
  Field,
  MuseEmpty,
  MuseError,
  MuseLoading,
  MusePageHeader,
} from "@/components/muse/MuseBits";

const freshnessTone = (f: string) =>
  f === "FRESH" ? "default" : f === "STALE" ? "destructive" : "outline";

export default function MuseSourcesPage() {
  const sources = useMuseSources();
  const conflicts = useMuseConflicts();

  return (
    <div>
      <MusePageHeader
        title="Source authority"
        description="Where truth lives for each domain, how fresh it is, and how confident Muse is. Muse consults this register instead of treating its own memory as the database."
      />

      {sources.isPending && <MuseLoading label="Reading the source register" />}
      {sources.error && <MuseError error={sources.error} />}

      {sources.data && (
        <Card className="mb-6">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">Register</CardTitle>
              <Badge variant="outline" className="font-mono text-[10px]">
                {sources.data.filter((s) => s.access_status === "KNOWN").length} of{" "}
                {sources.data.length} connected
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {sources.data.length === 0 ? (
              <MuseEmpty>No sources registered.</MuseEmpty>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Domain / subject</TableHead>
                      <TableHead>Authoritative system</TableHead>
                      <TableHead className="w-[10rem]">Secondary</TableHead>
                      <TableHead className="w-[11rem]">Access</TableHead>
                      <TableHead className="w-[8rem]">Freshness</TableHead>
                      <TableHead className="w-[6rem]">Confidence</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sources.data.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="max-w-[16rem]">
                          <div className="text-sm">{row.subject}</div>
                          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                            {row.domain_name}
                          </div>
                          {row.known_conflict && (
                            <Badge variant="destructive" className="mt-1 font-mono text-[10px]">
                              conflict
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="max-w-[18rem]">
                          <div className="text-xs">{row.authoritative_system}</div>
                          {row.reference && (
                            <div className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground">
                              {row.reference}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {row.secondary_system ?? "—"}
                        </TableCell>
                        <TableCell>
                          <DataStatusBadge status={row.access_status} />
                        </TableCell>
                        <TableCell>
                          <Badge variant={freshnessTone(row.freshness)} className="font-mono text-[10px]">
                            {row.freshness}
                          </Badge>
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            {formatAge(row.last_verified_at)}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-[10px]">
                            {row.confidence}
                          </Badge>
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
          <CardTitle className="text-base">Source conflicts</CardTitle>
          <CardDescription>
            Both readings are preserved with their references. The candidate authority is a proposal
            for Fendi, not a silent choice.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {conflicts.isPending && <MuseLoading label="Reading conflicts" />}
          {conflicts.error && <MuseError error={conflicts.error} />}
          {conflicts.data && conflicts.data.length === 0 && (
            <MuseEmpty>No open conflicts recorded.</MuseEmpty>
          )}
          {conflicts.data && conflicts.data.length > 0 && (
            <ul className="space-y-3">
              {conflicts.data.map((c) => (
                <li key={c.id} className="rounded-md border border-border/70 px-3 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="text-sm font-medium">{c.subject}</div>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      detected {formatAge(c.detected_at)}
                    </Badge>
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md bg-muted/40 px-3 py-2">
                      <Field label={c.system_a}>{c.value_a}</Field>
                      {c.reference_a && (
                        <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                          {c.reference_a}
                        </div>
                      )}
                    </div>
                    <div className="rounded-md bg-muted/40 px-3 py-2">
                      <Field label={c.system_b}>{c.value_b}</Field>
                      {c.reference_b && (
                        <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                          {c.reference_b}
                        </div>
                      )}
                    </div>
                  </div>
                  {c.candidate_authority && (
                    <div className="mt-2 text-xs">
                      <span className="font-mono text-[10px] uppercase text-muted-foreground">
                        candidate authority:{" "}
                      </span>
                      {c.candidate_authority}
                    </div>
                  )}
                  {c.resolution_notes && (
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {c.resolution_notes}
                    </p>
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

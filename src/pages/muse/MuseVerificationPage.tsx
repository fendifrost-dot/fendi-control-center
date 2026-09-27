/**
 * Verification queue — "an agent saying done is not completion".
 *
 * Every claim is listed with the level it must reach. Only a verifier other
 * than the claimant can promote it, and only with evidence for that level.
 */
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useMuseVerificationQueue } from "@/lib/muse/museClient";
import { formatAge } from "@/lib/muse/museFormat";
import {
  Field,
  MuseEmpty,
  MuseError,
  MuseLoading,
  MusePageHeader,
  TaskStateBadge,
  VerificationBadge,
} from "@/components/muse/MuseBits";
import type { MuseVerificationQueueRow } from "@/lib/muse/types";

type Filter = "PENDING" | "FAILED" | "PASSED" | "ALL";

const queueTone = (s: MuseVerificationQueueRow["queue_state"]) =>
  s === "PASSED" ? "default" : s === "FAILED" ? "destructive" : "secondary";

export default function MuseVerificationPage() {
  const queue = useMuseVerificationQueue();
  const [filter, setFilter] = useState<Filter>("PENDING");

  const counts = useMemo(() => {
    const c = { PENDING: 0, FAILED: 0, PASSED: 0, ALL: 0 };
    for (const r of queue.data ?? []) {
      c[r.queue_state] += 1;
      c.ALL += 1;
    }
    return c;
  }, [queue.data]);

  const rows = (queue.data ?? []).filter((r) => filter === "ALL" || r.queue_state === filter);

  return (
    <div>
      <MusePageHeader
        title="Verification"
        description="CLAIMED → ARTIFACT_VERIFIED → SYSTEM_VERIFIED → LIVE_VERIFIED. A claim stays pending until someone other than the claimant proves it at the required level; a failure sends the work back to its executor."
        right={
          <div className="flex flex-wrap gap-1">
            {(["PENDING", "FAILED", "PASSED", "ALL"] as Filter[]).map((f) => (
              <Button
                key={f}
                type="button"
                size="sm"
                variant={filter === f ? "default" : "outline"}
                onClick={() => setFilter(f)}
                className="font-mono text-xs"
              >
                {f.toLowerCase()} {counts[f]}
              </Button>
            ))}
          </div>
        }
      />

      {queue.isPending && <MuseLoading label="Reading the verification queue" />}
      {queue.error && <MuseError error={queue.error} />}

      {queue.data && rows.length === 0 && (
        <MuseEmpty>
          {filter === "PENDING"
            ? "Nothing is waiting on verification."
            : `No ${filter.toLowerCase()} verifications.`}
        </MuseEmpty>
      )}

      {rows.length > 0 && (
        <div className="space-y-3">
          {rows.map((r) => (
            <Card key={r.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-mono text-[10px] uppercase text-muted-foreground">
                      {r.subject_type.replace(/_/g, " ")}
                      {r.domain_key && ` · ${r.domain_key}`}
                    </div>
                    <CardTitle className="mt-0.5 text-sm">{r.subject_title}</CardTitle>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={queueTone(r.queue_state)} className="font-mono text-[10px]">
                      {r.queue_state}
                    </Badge>
                    <VerificationBadge state={r.verification_state} />
                    <span className="text-[10px] text-muted-foreground">needs</span>
                    <VerificationBadge state={r.required_state} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-sm">{r.claim}</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Claimant">
                    {r.claimant ?? "—"} · {formatAge(r.claimed_at)}
                  </Field>
                  <Field label="Verifier">
                    {r.verifier ? `${r.verifier} · ${formatAge(r.verified_at)}` : "not yet verified"}
                  </Field>
                  {r.task_state && (
                    <Field label="Task">
                      <TaskStateBadge state={r.task_state} />
                    </Field>
                  )}
                  {(r.evidence_url || r.commit_sha || r.artifact_ref) && (
                    <Field label="Artifact">
                      <span className="break-all font-mono text-xs">
                        {r.evidence_url ?? r.commit_sha ?? r.artifact_ref}
                      </span>
                    </Field>
                  )}
                  {r.system_evidence && <Field label="System evidence">{r.system_evidence}</Field>}
                  {r.live_evidence && <Field label="Live evidence">{r.live_evidence}</Field>}
                </div>
                {r.failure_reason && (
                  <p className="text-xs text-destructive">failed: {r.failure_reason}</p>
                )}
                {r.notes && <p className="text-xs text-muted-foreground">{r.notes}</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

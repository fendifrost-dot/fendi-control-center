/**
 * Agent queue — execution work per agent.
 *
 * Each agent reads only what is assigned to it. The same filter is available to
 * agents over the API: /executive/agent-queue?executor=<key>&open=true
 */
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useMuseAgentQueue } from "@/lib/muse/museClient";
import { formatAge, formatDue } from "@/lib/muse/museFormat";
import {
  MuseEmpty,
  MuseError,
  MuseLoading,
  MusePageHeader,
  PriorityBadge,
  TaskStateBadge,
  VerificationBadge,
} from "@/components/muse/MuseBits";

export default function MuseAgentQueuePage() {
  const queue = useMuseAgentQueue();
  const [executor, setExecutor] = useState<string>("all");
  const [openOnly, setOpenOnly] = useState(true);

  const executors = useMemo(
    () => Array.from(new Set((queue.data ?? []).map((t) => t.executor))).sort(),
    [queue.data],
  );

  const rows = useMemo(
    () =>
      (queue.data ?? [])
        .filter((t) => executor === "all" || t.executor === executor)
        .filter((t) => !openOnly || t.is_open)
        .sort((a, b) => a.priority_rank - b.priority_rank),
    [queue.data, executor, openOnly],
  );

  return (
    <div>
      <MusePageHeader
        title="Agent queue"
        description="Work assigned by Grok Bot to a named executor. An executor moves its own task to IMPLEMENTED with a claim; that opens a verification — it never closes the task."
        right={
          <div className="flex flex-wrap items-center gap-1">
            {["all", ...executors].map((e) => (
              <Button
                key={e}
                type="button"
                size="sm"
                variant={executor === e ? "default" : "outline"}
                onClick={() => setExecutor(e)}
                className="font-mono text-xs"
              >
                {e}
              </Button>
            ))}
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpenOnly((v) => !v)}>
              {openOnly ? "open only" : "all states"}
            </Button>
          </div>
        }
      />

      {queue.isPending && <MuseLoading label="Reading the agent queue" />}
      {queue.error && <MuseError error={queue.error} />}

      {queue.data && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">
                {executor === "all" ? "All executors" : executor}
              </CardTitle>
              <Badge variant="outline" className="font-mono text-[10px]">
                {rows.length}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <MuseEmpty>
                Nothing assigned{executor === "all" ? "" : ` to ${executor}`}. Tasks appear only after
                Muse selects an improvement and Grok Bot assigns it.
              </MuseEmpty>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[3.5rem]">Pri</TableHead>
                      <TableHead>Task</TableHead>
                      <TableHead className="w-[8rem]">Executor</TableHead>
                      <TableHead className="w-[9rem]">State</TableHead>
                      <TableHead className="w-[9rem]">Verification</TableHead>
                      <TableHead className="w-[7rem]">Due</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell>
                          <PriorityBadge priority={t.priority} />
                        </TableCell>
                        <TableCell className="max-w-[28rem]">
                          <div className="text-sm font-medium">{t.title}</div>
                          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                            {t.domain_name}
                            {t.function_area && ` · ${t.function_area}`} · for: {t.improvement_title}
                          </div>
                          {t.objective && <div className="mt-1 text-xs">{t.objective}</div>}
                          {t.expected_artifact && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              artifact: {t.expected_artifact}
                            </div>
                          )}
                          {t.blocker && (
                            <div className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                              {t.state === "WAITING" ? "waiting on" : "blocked by"}: {t.blocker}
                            </div>
                          )}
                          {t.claimed_completion && (
                            <div className="mt-1 text-xs">
                              <span className="text-muted-foreground">claimed:</span> {t.claimed_completion}
                            </div>
                          )}
                          {t.verification_failed && t.verification_failure_reason && (
                            <div className="mt-1 text-xs text-destructive">
                              verification failed: {t.verification_failure_reason}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="font-mono text-xs">{t.executor}</div>
                          <div className="mt-0.5 text-[10px] text-muted-foreground">by {t.assigned_by}</div>
                        </TableCell>
                        <TableCell>
                          <TaskStateBadge state={t.state} />
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            {formatAge(t.updated_at)}
                            {t.updated_by && ` · ${t.updated_by}`}
                          </div>
                        </TableCell>
                        <TableCell>
                          {t.verification_state ? (
                            <VerificationBadge state={t.verification_state} />
                          ) : (
                            <span className="text-xs text-muted-foreground">no claim yet</span>
                          )}
                          {t.verification_requirement && (
                            <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                              needs {t.verification_requirement}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="text-xs">{formatDue(t.due_at)}</div>
                          {t.is_overdue && (
                            <div className="mt-1 font-mono text-[10px] text-amber-600 dark:text-amber-500">
                              overdue
                            </div>
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
    </div>
  );
}

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MuseEmpty, MuseError, MuseLoading, MusePageHeader, Field, VerificationBadge } from "@/components/muse/MuseBits";
import { useMuseAgentQueue, useMuseVerificationQueue } from "@/lib/muse/workboardClient";
import { formatDue } from "@/lib/muse/museFormat";

export default function MuseAgentQueuePage() {
  const queue = useMuseAgentQueue();
  const verify = useMuseVerificationQueue();

  return (
    <div className="space-y-8">
      <section>
        <MusePageHeader
          title="Agent queue"
          description="Structured assignments for Grok, Claude, and specialist agents. Agents work state, evidence, and definition-of-done — not free-form chat."
          right={queue.data && <div className="text-xs text-muted-foreground">{queue.data.filter((r) => r.state !== "COMPLETE" && r.state !== "CANCELLED").length} active</div>}
        />
        {queue.isPending && <MuseLoading label="Reading agent queue" />}
        {queue.error && <MuseError error={queue.error} />}
        {queue.data?.length === 0 && <MuseEmpty>No agent tasks recorded yet.</MuseEmpty>}
        <div className="space-y-4">
          {queue.data?.map((r) => (
            <Card key={r.id}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">{r.title}</CardTitle>
                    <p className="mt-1 text-xs text-muted-foreground">{r.improvement}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline" className="font-mono text-[10px]">{r.priority}</Badge>
                    <Badge variant={r.state === "BLOCKED" ? "destructive" : "secondary"} className="font-mono text-[10px]">{r.state}</Badge>
                    <VerificationBadge state={r.verification_state} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Domain">{r.domain_name}</Field>
                  <Field label="Executor">{r.executor}</Field>
                  <Field label="Assigned by">{r.assigning_agent}</Field>
                  <Field label="Objective">{r.objective}</Field>
                  <Field label="Expected artifact">{r.expected_artifact}</Field>
                  <Field label="Due">{formatDue(r.due_at)}{r.overdue ? " · overdue" : ""}</Field>
                </div>
                {r.instructions && <Field label="Instructions">{r.instructions}</Field>}
                {r.definition_of_done && <Field label="Definition of done">{r.definition_of_done}</Field>}
                {r.blocker && <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><span className="font-medium">Blocker:</span> {r.blocker}</div>}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <MusePageHeader
          title="Verification queue"
          description="A claimed completion is not complete. Items remain here until artifact, system, or live evidence supports the claim."
          right={verify.data && <div className="text-xs text-muted-foreground">{verify.data.length} awaiting verification</div>}
        />
        {verify.isPending && <MuseLoading label="Reading verification queue" />}
        {verify.error && <MuseError error={verify.error} />}
        {verify.data?.length === 0 && <MuseEmpty>No claims awaiting verification.</MuseEmpty>}
        <div className="space-y-3">
          {verify.data?.map((r) => (
            <Card key={r.task_id}>
              <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Task">{r.title}</Field>
                <Field label="Claimant">{r.claimant}</Field>
                <Field label="Domain">{r.domain_name}</Field>
                <Field label="Expected artifact">{r.expected_artifact}</Field>
                <Field label="Verification required">{r.verification_requirement}</Field>
                <div><VerificationBadge state={r.verification_state} /></div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}

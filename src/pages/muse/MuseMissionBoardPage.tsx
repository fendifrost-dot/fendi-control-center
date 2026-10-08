import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MuseEmpty, MuseError, MuseLoading, MusePageHeader, Field } from "@/components/muse/MuseBits";
import { useMuseMissions } from "@/lib/muse/workboardClient";
import { formatDue } from "@/lib/muse/museFormat";

export default function MuseMissionBoardPage() {
  const missions = useMuseMissions();

  return (
    <div>
      <MusePageHeader
        title="Mission board"
        description="Objectives sit above implementation tasks. Muse sets the business outcome; Grok coordinates execution; specialists work the assigned task."
        right={missions.data && <div className="text-xs text-muted-foreground">{missions.data.filter((m) => m.status === "ACTIVE").length} active</div>}
      />

      {missions.isPending && <MuseLoading label="Reading missions" />}
      {missions.error && <MuseError error={missions.error} />}
      {missions.data?.length === 0 && <MuseEmpty>No missions recorded yet.</MuseEmpty>}

      <div className="space-y-4">
        {missions.data?.map((m) => (
          <Card key={m.id}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base">{m.title}</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">{m.objective}</p>
                </div>
                <div className="flex gap-1.5">
                  <Badge variant="outline" className="font-mono text-[10px]">{m.priority}</Badge>
                  <Badge variant={m.status === "ACTIVE" ? "default" : "secondary"} className="font-mono text-[10px]">{m.status}</Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Domain">{m.domain_name}</Field>
                <Field label="Owner">{m.owner}</Field>
                <Field label="Executive sponsor">{m.executive_sponsor}</Field>
                <Field label="Business outcome">{m.business_outcome}</Field>
                <Field label="Metric">{m.metric}</Field>
                <Field label="Baseline">{m.baseline}</Field>
                <Field label="Target">{m.target}</Field>
                <Field label="Review">{formatDue(m.review_at)}</Field>
                <Field label="Active work">{m.active_improvements} improvements · {m.active_tasks} tasks · {m.blocked_tasks} blocked</Field>
              </div>
              {m.notes && <p className="text-xs leading-relaxed text-muted-foreground">{m.notes}</p>}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

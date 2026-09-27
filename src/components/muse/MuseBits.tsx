/**
 * Small shared pieces for the Muse module.
 *
 * These carry Muse's honesty rules into the UI: an unavailable source says so,
 * an empty list says why it is empty, and a missing schema is never rendered as
 * a calm empty dashboard.
 */
import type { ReactNode } from "react";
import { AlertTriangle, DatabaseZap, Info, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  dataStatusLabel,
  dataStatusTone,
  isMissingSchemaError,
  systemStatusTone,
  verificationTone,
  priorityTone,
  stateTone,
  taskStateTone,
  verdictTone,
} from "@/lib/muse/museFormat";
import type { MuseDataStatus, MuseSystemStatus, MuseVerificationState } from "@/lib/muse/types";

export function DataStatusBadge({ status }: { status: MuseDataStatus | null | undefined }) {
  return (
    <Badge variant={dataStatusTone(status)} className="font-mono text-[10px] uppercase">
      {dataStatusLabel(status)}
    </Badge>
  );
}

export function SystemStatusBadge({ status }: { status: MuseSystemStatus | null | undefined }) {
  return (
    <Badge variant={systemStatusTone(status)} className="font-mono text-[10px]">
      {status ?? "UNKNOWN"}
    </Badge>
  );
}

export function VerificationBadge({ state }: { state: MuseVerificationState | null | undefined }) {
  return (
    <Badge variant={verificationTone(state)} className="font-mono text-[10px]">
      {state ?? "CLAIMED"}
    </Badge>
  );
}

export function PriorityBadge({ priority }: { priority: string | null | undefined }) {
  return (
    <Badge variant={priorityTone(priority)} className="font-mono text-[10px]">
      {priority ?? "—"}
    </Badge>
  );
}

export function StateBadge({ state }: { state: string | null | undefined }) {
  return (
    <Badge variant={stateTone(state)} className="font-mono text-[10px]">
      {state ?? "—"}
    </Badge>
  );
}

export function TaskStateBadge({ state }: { state: string | null | undefined }) {
  return (
    <Badge variant={taskStateTone(state)} className="font-mono text-[10px]">
      {state ?? "—"}
    </Badge>
  );
}

export function VerdictBadge({ verdict }: { verdict: string | null | undefined }) {
  return (
    <Badge variant={verdictTone(verdict)} className="font-mono text-[10px]">
      {verdict ?? "PENDING"}
    </Badge>
  );
}

export function ClassificationBadge({ value }: { value: string | null | undefined }) {
  return (
    <Badge variant="outline" className="font-mono text-[10px]">
      {(value ?? "—").replace(/_/g, " ").toLowerCase()}
    </Badge>
  );
}

export function MuseLoading({ label = "Reading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}…
    </div>
  );
}

/**
 * Distinguishes "Muse is not deployed here yet" from a real read failure. The
 * first is an instruction, not an error, and must never look like healthy
 * emptiness.
 */
export function MuseError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);

  if (isMissingSchemaError(error)) {
    return (
      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <DatabaseZap className="h-4 w-4 text-amber-500" />
            Muse schema is not in this database yet
          </CardTitle>
          <CardDescription>
            The code is deployed but the executive views do not exist, so there is nothing to read.
            This is <span className="font-mono">CODED</span>, not{" "}
            <span className="font-mono">LIVE</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            Apply <code className="rounded bg-muted px-1 py-0.5 text-xs">
              supabase/migrations/20260925120000_muse_executive_layer.sql
            </code>{" "}
            in the Lovable SQL editor for this project, then reload.
          </p>
          <p className="font-mono text-xs text-muted-foreground/80">{message}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          Could not read this Muse view
        </CardTitle>
        <CardDescription>
          Nothing is being guessed in its place — treat this section as unknown, not empty.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="font-mono text-xs text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  );
}

/** An empty list states what the emptiness means. */
export function MuseEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function MusePageHeader({
  title,
  description,
  right,
}: {
  title: string;
  description: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
      </div>
      {right}
    </div>
  );
}

/** Small labelled value used across the portfolio and system cards. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 break-words text-sm">{children ?? "—"}</div>
    </div>
  );
}

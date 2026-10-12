import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { hub, MESSAGE_KIND_STYLE, timeAgo, type HubMessage, type HubThread } from "@/lib/agentHub";
import { AgentHubShell, StateDot, agentName, useAgents } from "@/components/agents/bits";
import { AgentCard } from "@/components/agents/AgentCard";
import { MacPanel } from "@/components/agents/MacPanel";
import { ComposeSheet, type ComposeResult } from "@/components/agents/ComposeSheet";
import { useToast } from "@/hooks/use-toast";

const TABS = [
  { key: "threads", label: "Threads" },
  { key: "agents", label: "Agents" },
  { key: "mac", label: "Mac" },
] as const;

const STATUS_LABEL: Record<HubThread["status"], string> = {
  OPEN: "Open",
  WAITING_ON_AGENT: "Waiting on agent",
  WAITING_ON_FENDI: "Your turn",
  DONE: "Done",
  ARCHIVED: "Archived",
};

export default function AgentHubPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") ?? "threads") as (typeof TABS)[number]["key"];
  const agentFilter = params.get("agent");
  const navigate = useNavigate();
  const { toast } = useToast();
  const qc = useQueryClient();
  const agents = useAgents();
  const [compose, setCompose] = useState<"new" | "import" | null>(null);

  const threads = useQuery({
    queryKey: ["agent-hub", "threads", agentFilter],
    queryFn: async () => (await hub<{ threads: HubThread[] }>("threads", { agent: agentFilter ?? undefined })).threads,
    refetchInterval: 10_000,
    enabled: tab === "threads",
  });

  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };

  const submit = async (r: ComposeResult) => {
    let threadId: string;
    if (r.kind === "IMPORT") {
      const res = await hub<{ thread_id: string }>("ingest", {
        source_app: r.source_app, title: r.title || undefined, project: r.project || undefined, body: r.body, url: r.url,
        context: r.context, attachments: r.attachments, to_agent: r.to_agent ?? undefined,
        purpose: r.purpose, instructions: r.instructions || undefined,
      });
      threadId = res.thread_id;
    } else {
      const res = await hub<{ thread: { id: string }; message: HubMessage }>("create_thread", {
        title: r.title, project: r.project || undefined, body: r.body, kind: r.kind, context: r.context, attachments: r.attachments,
        primary_agent: r.to_agent ?? undefined,
      });
      threadId = res.thread.id;
      if (r.to_agent) {
        await hub("handoff", {
          thread_id: threadId, source_message_id: res.message.id, to_agent: r.to_agent, purpose: r.purpose,
          instructions: r.instructions || undefined,
        });
      }
    }
    void qc.invalidateQueries({ queryKey: ["agent-hub"] });
    toast({ title: r.to_agent ? `Sent to ${agentName(agents.data, r.to_agent)}` : "Saved" });
    navigate(`/agents/t/${threadId}`);
  };

  const visibleAgents = (agents.data ?? []).filter((a) => a.kind !== "human");

  return (
    <AgentHubShell
      title="Agent Hub"
      actions={
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" aria-label="Bring in from another app" onClick={() => setCompose("import")}>
            <Download className="h-5 w-5" />
          </Button>
          <Button size="icon" aria-label="New thread" onClick={() => setCompose("new")}>
            <Plus className="h-5 w-5" />
          </Button>
        </div>
      }
    >
      <div className="mb-3 flex gap-1 rounded-lg bg-muted p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => set("tab", t.key === "threads" ? null : t.key)}
            className={cn(
              "flex-1 rounded-md py-1.5 text-sm",
              tab === t.key ? "bg-background font-medium shadow-sm" : "text-muted-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "threads" && (
        <>
          <div className="-mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
            <button type="button" onClick={() => set("agent", null)}
              className={cn("shrink-0 rounded-full border px-3 py-1 text-xs", !agentFilter ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
              All
            </button>
            {visibleAgents.map((a) => (
              <button key={a.key} type="button" onClick={() => set("agent", a.key)}
                className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs", agentFilter === a.key ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
                <StateDot state={a.effective.state} /> {a.display_name}
              </button>
            ))}
          </div>

          {threads.isLoading && <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>}
          {threads.error && <p className="py-8 text-center text-sm text-destructive">{(threads.error as Error).message}</p>}
          {threads.data && threads.data.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <p>No threads{agentFilter ? ` with ${agentName(agents.data, agentFilter)}` : ""} yet.</p>
              <p className="mt-1">Start one with + or bring in something from another app.</p>
            </div>
          )}
          <ul className="divide-y divide-border">
            {threads.data?.map((t) => (
              <li key={t.id}>
                <Link to={`/agents/t/${t.id}`} className="block py-3 active:bg-muted/50">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">{t.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(t.last_activity_at)}</span>
                  </div>
                  {t.last_message && (
                    <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                      <span className="text-foreground">{agentName(agents.data, t.last_message.author)}:</span> {t.last_message.body}
                    </p>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className={cn("rounded px-1.5 py-0.5", t.status === "WAITING_ON_FENDI" ? "bg-yellow-500/20 text-yellow-800 dark:text-yellow-200" : "bg-muted text-muted-foreground")}>
                      {STATUS_LABEL[t.status]}
                    </span>
                    {t.last_message && (
                      <span className={cn("rounded px-1.5 py-0.5", MESSAGE_KIND_STYLE[t.last_message.kind as HubMessage["kind"]])}>
                        {t.last_message.kind.toLowerCase()}
                      </span>
                    )}
                    {(t.waiting_on ?? []).map((k) => (
                      <span key={k} className="text-muted-foreground">⏳ {agentName(agents.data, k)}</span>
                    ))}
                    {t.project && <span className="text-muted-foreground">· {t.project}</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {tab === "agents" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Green is verified working through Control Center. Amber is connected but not yet proven. Grey needs setup.
          </p>
          {agents.error && <p className="text-sm text-destructive">{(agents.error as Error).message}</p>}
          {visibleAgents.map((a) => <AgentCard key={a.key} agent={a} />)}
        </div>
      )}

      {tab === "mac" && <MacPanel />}

      <ComposeSheet
        open={compose !== null}
        onOpenChange={(o) => !o && setCompose(null)}
        mode={compose ?? "new"}
        agents={agents.data ?? []}
        onSubmit={submit}
      />
    </AgentHubShell>
  );
}

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { KIND_LABEL, STATE_STYLE, timeAgo, type HubAgent } from "@/lib/agentHub";
import { StateDot } from "./bits";

type MuseTask = { id: string; title: string; state: string; priority: string; updated_at: string };
type FeedRow = { id: string; update_type: string; message: string; created_at: string };

/** Everything true about one integration, plus the Muse work it already has. */
export function AgentCard({ agent }: { agent: HubAgent }) {
  const tasks = useQuery({
    queryKey: ["agent-hub", "muse-tasks", agent.key],
    enabled: agent.kind !== "human",
    queryFn: async () => {
      // Muse tasks name executors in prose ("Claude", "Grok Bot"); match on the first word.
      const word = agent.display_name.split(/[\s(]/)[0];
      const { data } = await (supabase as any)
        .from("muse_agent_queue")
        .select("id,title,state,priority,updated_at")
        .ilike("executor", `%${word}%`)
        .not("state", "in", "(COMPLETE,CANCELLED)")
        .order("updated_at", { ascending: false })
        .limit(5);
      return (data ?? []) as MuseTask[];
    },
  });
  const feed = useQuery({
    queryKey: ["agent-hub", "muse-feed", agent.token_label],
    enabled: Boolean(agent.token_label),
    queryFn: async () => {
      const { data } = await (supabase as any)
        .from("muse_work_feed")
        .select("id,update_type,message,created_at")
        .eq("actor", agent.token_label)
        .order("created_at", { ascending: false })
        .limit(3);
      return (data ?? []) as FeedRow[];
    },
  });

  const rows: Array<[string, string]> = [
    ["Connects to", agent.connects_to],
    ["Conversation", agent.conversation_state],
    ["Tools", agent.tool_access],
    ["Sign-in", agent.auth],
    ["Billing", agent.billing],
  ];

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex items-start gap-3">
        <StateDot state={agent.effective.state} className="mt-2" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 className="font-semibold">{agent.display_name}</h3>
            <span className="text-xs text-muted-foreground">{KIND_LABEL[agent.kind]}</span>
          </div>
          <p className="mt-0.5 text-xs">
            <span className="font-medium">{STATE_STYLE[agent.effective.state].label}.</span>{" "}
            <span className="text-muted-foreground">{agent.effective.reason}</span>
          </p>
        </div>
      </div>
      {agent.kind !== "human" && (
        <dl className="mt-3 space-y-1.5 text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[5.5rem_1fr] gap-2">
              <dt className="text-muted-foreground">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
          {agent.model && (
            <div className="grid grid-cols-[5.5rem_1fr] gap-2">
              <dt className="text-muted-foreground">Model</dt>
              <dd className="font-mono">{agent.model}</dd>
            </div>
          )}
        </dl>
      )}
      {(tasks.data?.length ?? 0) > 0 && (
        <div className="mt-3 border-t border-border pt-2">
          <div className="text-xs font-medium text-muted-foreground">Open Muse tasks</div>
          {tasks.data!.map((t) => (
            <div key={t.id} className="mt-1 flex items-center justify-between gap-2 text-xs">
              <span className="truncate">{t.title}</span>
              <span className="shrink-0 text-muted-foreground">{t.state.toLowerCase()} · {t.priority}</span>
            </div>
          ))}
        </div>
      )}
      {(feed.data?.length ?? 0) > 0 && (
        <div className="mt-3 border-t border-border pt-2">
          <div className="text-xs font-medium text-muted-foreground">Latest on the Muse workboard</div>
          {feed.data!.map((f) => (
            <p key={f.id} className="mt-1 line-clamp-2 text-xs">
              <span className="text-muted-foreground">{timeAgo(f.created_at)} · {f.update_type.toLowerCase()} · </span>
              {f.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageSquare, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { hub, timeAgo } from "@/lib/agentHub";
import { useToast } from "@/hooks/use-toast";

type Health = {
  bridge: { device_name: string; last_seen_at: string | null; capabilities: Record<string, any> | unknown[] | null } | null;
};
type Cmd = { id: string; command_type: string; status: string; payload: any; result_json: any; error: string | null; created_at: string };

function Row({ label, ok, detail }: { label: string; ok: boolean | null; detail?: string | null }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span>{label}</span>
      <span className={ok ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
        {ok === null ? "unknown" : ok ? "yes" : "no"}
        {detail ? <span className="block max-w-[14rem] truncate text-right text-xs text-muted-foreground">{detail}</span> : null}
      </span>
    </div>
  );
}

/** Mac bridge status, what this Mac reported it can do, and iMessage. */
export function MacPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const health = useQuery({ queryKey: ["agent-hub", "health"], queryFn: () => hub<Health>("health"), refetchInterval: 15_000 });
  const cmds = useQuery({
    queryKey: ["agent-hub", "mac-cmds"],
    refetchInterval: 5_000,
    queryFn: async () => {
      const { data } = await (supabase as any)
        .from("remote_command_queue")
        .select("id,command_type,status,payload,result_json,error,created_at")
        .in("command_type", ["imessage_send", "imessage_read", "agent_handoff", "capabilities"])
        .order("created_at", { ascending: false })
        .limit(10);
      return (data ?? []) as Cmd[];
    },
  });
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const bridge = health.data?.bridge;
  const caps = bridge?.capabilities && !Array.isArray(bridge.capabilities) ? (bridge.capabilities as Record<string, any>) : null;
  const seen = bridge?.last_seen_at ? Date.parse(bridge.last_seen_at) : NaN;
  const online = Number.isFinite(seen) && Date.now() - seen < 90_000;

  const run = async (action: string, params: Record<string, unknown>) => {
    setBusy(action);
    try {
      await hub(action, params);
      toast({ title: online ? "Sent to your Mac" : "Queued — your Mac bridge is offline", description: online ? undefined : "It runs when the bridge reconnects (expires in 10 minutes)." });
      void qc.invalidateQueries({ queryKey: ["agent-hub", "mac-cmds"] });
    } catch (e) {
      toast({ title: "Failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">{bridge?.device_name ?? "Mac bridge"}</h3>
          <span className={`text-xs ${online ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
            {online ? "online" : bridge?.last_seen_at ? `offline · last seen ${timeAgo(bridge.last_seen_at)} ago` : "never connected"}
          </span>
        </div>
        {!caps && (
          <p className="mt-2 text-xs text-muted-foreground">
            This Mac has not reported capabilities yet. Update and restart the bridge (docs/AGENT_HUB.md → “Mac setup”).
          </p>
        )}
        {caps && (
          <div className="mt-2 divide-y divide-border">
            <Row label="Claude Code CLI" ok={Boolean(caps.claude_cli)} detail={caps.claude_cli?.version} />
            <Row label="Cursor agent CLI" ok={Boolean(caps.cursor_cli)} detail={caps.cursor_cli?.version} />
            <Row label="Codex CLI" ok={Boolean(caps.codex_cli)} detail={caps.codex_cli?.version} />
            <Row label="Send iMessage" ok={caps.imessage_send ?? null} detail="macOS asks for Automation permission on first send" />
            <Row label="Read iMessage history" ok={caps.imessage_read ?? null} detail={caps.imessage_read ? null : caps.imessage_read_error} />
            <Row label="Agents may edit files" ok={caps.allow_edits ?? false} />
          </div>
        )}
        <Link to="/remote" className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
          <Terminal className="h-3.5 w-3.5" /> Shell, open URL and notification commands
        </Link>
      </div>

      <div className="rounded-xl border border-border p-4">
        <h3 className="flex items-center gap-2 font-semibold"><MessageSquare className="h-4 w-4" /> iMessage from your Mac</h3>
        <div className="mt-3 space-y-2">
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Phone number or Apple ID email" inputMode="email" />
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Message" />
          <div className="flex gap-2">
            <Button size="sm" disabled={!to.trim() || !text.trim() || busy !== null} onClick={() => run("imessage_send", { to: to.trim(), text })}>
              {busy === "imessage_send" && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Send
            </Button>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run("imessage_read", { handle: to.trim() || undefined, limit: 20 })}>
              {busy === "imessage_read" && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Read recent{to.trim() ? " with this contact" : ""}
            </Button>
          </div>
        </div>
      </div>

      {(cmds.data?.length ?? 0) > 0 && (
        <div className="rounded-xl border border-border p-4">
          <h3 className="text-sm font-semibold">Recent Mac jobs</h3>
          {cmds.data!.map((c) => (
            <details key={c.id} className="mt-2 text-xs">
              <summary className="cursor-pointer">
                <span className="font-mono">{c.command_type}</span> · {c.status} · {timeAgo(c.created_at)} ago
              </summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">
                {c.error ?? c.result_json?.message ?? ""}
                {c.result_json?.stdout ? `\n${c.result_json.stdout}` : ""}
                {c.result_json?.stderr ? `\n${c.result_json.stderr}` : ""}
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

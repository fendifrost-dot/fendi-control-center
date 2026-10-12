import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, CornerUpLeft, ExternalLink, GitCommit, Loader2, MoreHorizontal, Paperclip, Send, Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  commitUrl, hub, MESSAGE_KIND_STYLE, signedUrl, SOURCE_APPS, timeAgo, uploadAttachment,
  type Attachment, type HubAgent, type HubHandoff, type HubMessage, type HubThread,
} from "@/lib/agentHub";
import { AgentHubShell, Initial, StateDot, agentName, useAgents } from "@/components/agents/bits";
import { HandoffSheet } from "@/components/agents/HandoffSheet";
import { useToast } from "@/hooks/use-toast";

type ThreadData = { thread: HubThread; messages: HubMessage[]; handoffs: HubHandoff[] };

const HANDOFF_STATUS: Record<HubHandoff["status"], string> = {
  QUEUED: "queued",
  DELIVERED: "delivered, waiting for answer",
  IN_PROGRESS: "working",
  RESPONDED: "answered",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

function AttachmentView({ a }: { a: Attachment }) {
  const [open, setOpen] = useState(false);
  if (a.text) {
    return (
      <details className="rounded-md border border-border text-xs" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer px-2 py-1.5"><Paperclip className="mr-1 inline h-3 w-3" />{a.name}</summary>
        <pre className="max-h-80 overflow-auto whitespace-pre border-t border-border bg-muted/40 p-2 font-mono text-[11px] leading-snug">{a.text}</pre>
      </details>
    );
  }
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
      onClick={async () => {
        const url = a.storage_path ? await signedUrl(a.storage_path) : a.url;
        if (url) window.open(url, "_blank", "noopener");
      }}
    >
      <Paperclip className="h-3 w-3" /> {a.name}
    </button>
  );
}

/** Light formatting for agent replies: headings, **bold**, `code` and fenced blocks. No HTML is injected. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/```[\w-]*\n?/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="my-1.5 overflow-x-auto rounded bg-muted p-2 font-mono text-[11px] leading-snug">{part.replace(/\n$/, "")}</pre>
        ) : (
          part.split("\n").map((line, j) => {
            const h = /^#{1,6}\s+(.*)$/.exec(line);
            const content = (h ? h[1] : line).split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((seg, k) =>
              seg.startsWith("**") && seg.endsWith("**") && seg.length > 4 ? <strong key={k}>{seg.slice(2, -2)}</strong>
                : seg.startsWith("`") && seg.endsWith("`") && seg.length > 2 ? <code key={k} className="rounded bg-muted px-1 font-mono text-[12px]">{seg.slice(1, -1)}</code>
                : seg,
            );
            return <div key={`${i}-${j}`} className={cn(h && "mt-2 font-semibold", !line.trim() && "h-2")}>{content}</div>;
          })
        ),
      )}
    </>
  );
}

function Body({ text }: { text: string }) {
  const [more, setMore] = useState(false);
  const long = text.length > 1400;
  return (
    <div className="text-sm leading-relaxed">
      <div className={cn("whitespace-pre-wrap break-words", long && !more && "max-h-[26rem] overflow-hidden")}><Rich text={text} /></div>
      {long && (
        <button type="button" className="mt-1 text-xs text-muted-foreground underline" onClick={() => setMore((m) => !m)}>
          {more ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

export default function ThreadPage() {
  const { threadId } = useParams<{ threadId: string }>();
  const { toast } = useToast();
  const qc = useQueryClient();
  const agents = useAgents();
  const [handoffFor, setHandoffFor] = useState<HubMessage | null>(null);
  const [draft, setDraft] = useState("");
  const [to, setTo] = useState<string | null>(null);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const q = useQuery({
    queryKey: ["agent-hub", "thread", threadId],
    queryFn: () => hub<ThreadData>("thread", { thread_id: threadId }),
    refetchInterval: (query) => {
      const d = query.state.data as ThreadData | undefined;
      return d?.handoffs.some((h) => ["QUEUED", "DELIVERED", "IN_PROGRESS"].includes(h.status)) ? 4_000 : 20_000;
    },
  });
  const data = q.data;
  const count = data?.messages.length ?? 0;
  useEffect(() => {
    if (count) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [count]);

  const byId = useMemo(() => new Map((data?.messages ?? []).map((m) => [m.id, m])), [data]);
  const handoffById = useMemo(() => new Map((data?.handoffs ?? []).map((h) => [h.id, h])), [data]);
  const agentKeys = new Set((agents.data ?? []).map((a) => a.key));

  // Default the composer to the last agent who spoke here.
  useEffect(() => {
    if (to !== null || !data) return;
    const last = [...data.messages].reverse().find((m) => m.author_kind === "agent" && agentKeys.has(m.author));
    if (last) setTo(last.author);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["agent-hub"] });
  const act = async (id: string, fn: () => Promise<unknown>, done?: string) => {
    setBusyId(id);
    try {
      await fn();
      if (done) toast({ title: done });
      await refresh();
    } catch (e) {
      toast({ title: "Failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const originOf = (m: HubMessage): string | null => {
    if (!m.handoff_id) return null;
    const h = handoffById.get(m.handoff_id);
    const src = h?.source_message_id ? byId.get(h.source_message_id) : undefined;
    if (!src || src.author === "fendi" || src.author === m.author || !agentKeys.has(src.author)) return null;
    return src.author;
  };

  const pending = (data?.handoffs ?? []).filter((h) => ["QUEUED", "DELIVERED", "IN_PROGRESS", "FAILED"].includes(h.status));
  const targets: HubAgent[] = (agents.data ?? []).filter((a) => a.kind !== "human" && a.effective.state !== "disabled");

  const send = async () => {
    if (!draft.trim() || !threadId) return;
    setSending(true);
    try {
      await hub("post", { thread_id: threadId, body: draft, kind: "MESSAGE", attachments: files, to_agent: to ?? undefined, purpose: "TASK" });
      setDraft("");
      setFiles([]);
      await refresh();
    } catch (e) {
      toast({ title: "Not sent", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  return (
    <AgentHubShell
      back="/agents"
      title={data?.thread.title ?? "Thread"}
      actions={
        data && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label="Thread options"><MoreHorizontal className="h-5 w-5" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {data.thread.status !== "DONE" && (
                <DropdownMenuItem onClick={() => act("status", () => hub("set_thread_status", { thread_id: threadId, status: "DONE" }), "Marked done")}>Mark done</DropdownMenuItem>
              )}
              {data.thread.status === "DONE" && (
                <DropdownMenuItem onClick={() => act("status", () => hub("set_thread_status", { thread_id: threadId, status: "OPEN" }), "Reopened")}>Reopen</DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => act("status", () => hub("set_thread_status", { thread_id: threadId, status: "ARCHIVED" }), "Archived")}>Archive</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      }
      footer={
        <div className="space-y-1.5">
          <div className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none]">
            <span className="shrink-0 self-center pr-1 text-xs text-muted-foreground">To</span>
            <button type="button" onClick={() => setTo(null)}
              className={cn("shrink-0 rounded-full border px-2.5 py-0.5 text-xs", to === null ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
              Note only
            </button>
            {targets.map((a) => (
              <button key={a.key} type="button" onClick={() => setTo(a.key)}
                className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs", to === a.key ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
                <StateDot state={a.effective.state} /> {a.display_name}
              </button>
            ))}
          </div>
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {files.map((f, i) => (
                <span key={f.storage_path} className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs">
                  {f.name}<button type="button" aria-label="Remove" onClick={() => setFiles((c) => c.filter((_, j) => j !== i))}><X className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-1.5">
            <input ref={fileRef} type="file" multiple className="hidden" onChange={async (e) => {
              const list = Array.from(e.target.files ?? []);
              if (!list.length || !threadId) return;
              try {
                const up = await Promise.all(list.map((f) => uploadAttachment(threadId, f)));
                setFiles((c) => [...c, ...up]);
              } catch (err) {
                toast({ title: "Upload failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
              } finally {
                if (fileRef.current) fileRef.current.value = "";
              }
            }} />
            <Button size="icon" variant="ghost" className="shrink-0" aria-label="Attach" onClick={() => fileRef.current?.click()}>
              <Paperclip className="h-5 w-5" />
            </Button>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={1}
              placeholder={to ? "Message" : "Add a note"}
              className="max-h-40 min-h-[40px] flex-1 resize-none text-base sm:text-sm"
            />
            <Button size="icon" className="shrink-0" aria-label="Send" disabled={!draft.trim() || sending} onClick={send}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      }
    >
      {q.isLoading && <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>}
      {q.error && <p className="py-8 text-center text-sm text-destructive">{(q.error as Error).message}</p>}

      {pending.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {pending.map((h) => (
            <div key={h.id} className={cn("flex items-center gap-2 rounded-lg border px-3 py-2 text-xs", h.status === "FAILED" ? "border-destructive/50" : "border-border")}>
              {h.status === "FAILED" ? <X className="h-3.5 w-3.5 text-destructive" /> : <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              <span className="min-w-0 flex-1">
                <span className="font-medium">{agentName(agents.data, h.to_agent)}</span> · {h.purpose.toLowerCase()} · {HANDOFF_STATUS[h.status]}
                {h.status === "FAILED" && h.error && <span className="block truncate text-destructive">{h.error}</span>}
                {h.status !== "FAILED" && (h.delivery as any)?.transport === "mac_bridge" && <span className="block text-muted-foreground">Runs on your Mac when the bridge picks it up.</span>}
                {h.status !== "FAILED" && (h.delivery as any)?.transport === "token_inbox" && <span className="block text-muted-foreground">In {agentName(agents.data, h.to_agent)}'s inbox{(h.delivery as any)?.workboard_update_id ? " and on the Muse workboard" : ""}.</span>}
              </span>
              {h.status === "FAILED" ? (
                <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busyId === h.id} onClick={() => act(h.id, () => hub("retry_handoff", { handoff_id: h.id }), "Retrying")}>Retry</Button>
              ) : (
                <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busyId === h.id} onClick={() => act(h.id, () => hub("cancel_handoff", { handoff_id: h.id }), "Cancelled")}>Cancel</Button>
              )}
            </div>
          ))}
        </div>
      )}

      <ol className="space-y-3">
        {data?.messages.map((m) => {
          if (m.kind === "SYSTEM") {
            return <li key={m.id} className="px-2 text-center text-xs text-muted-foreground">{m.body} · {timeAgo(m.created_at)}</li>;
          }
          const name = agentName(agents.data, m.author);
          const h = m.handoff_id ? handoffById.get(m.handoff_id) : undefined;
          const delivery = (h?.delivery ?? {}) as Record<string, any>;
          const origin = originOf(m);
          const cUrl = commitUrl(m.context);
          const reply = m.reply_to ? byId.get(m.reply_to) : undefined;
          return (
            <li key={m.id} className="rounded-xl border border-border p-3">
              <div className="flex items-center gap-2">
                <Initial name={name} human={m.author_kind === "human"} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-1.5 text-sm">
                    <span className="font-medium">{name}</span>
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide", MESSAGE_KIND_STYLE[m.kind])}>{m.kind.toLowerCase()}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {timeAgo(m.created_at)} ago
                    {reply && <> · re {agentName(agents.data, reply.author)}'s {reply.kind.toLowerCase()}</>}
                    {m.kind === "IMPORT" && m.context.source_app && <> · from {SOURCE_APPS.find((s) => s.value === m.context.source_app)?.label ?? m.context.source_app}</>}
                    {delivery.model && <> · {String(delivery.model)}{delivery.latency_ms ? ` · ${(Number(delivery.latency_ms) / 1000).toFixed(1)}s` : ""}</>}
                    {delivery.responded_via === "mac-bridge" && <> · ran on your Mac</>}
                  </div>
                </div>
              </div>

              {(cUrl || m.context.pr_url || m.context.files?.length || m.context.external_url || m.context.decision) && (
                <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                  {m.context.decision && <span className="rounded bg-yellow-500/20 px-1.5 py-0.5 font-medium">{m.context.decision.replace("_", " ").toLowerCase()}</span>}
                  {cUrl && (
                    <a href={cUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono">
                      <GitCommit className="h-3 w-3" />{m.context.commit_sha!.slice(0, 7)}
                    </a>
                  )}
                  {m.context.pr_url && (
                    <a href={m.context.pr_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5">
                      PR <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {m.context.external_url && (
                    <a href={m.context.external_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5">
                      original <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {m.context.files?.map((f) => <span key={f} className="rounded bg-muted px-1.5 py-0.5 font-mono">{f}</span>)}
                </div>
              )}

              <div className="mt-2"><Body text={m.body} /></div>
              {m.attachments.length > 0 && <div className="mt-2 flex flex-col gap-1.5">{m.attachments.map((a, i) => <AttachmentView key={i} a={a} />)}</div>}

              <div className="mt-2 flex flex-wrap gap-1">
                <Button size="sm" variant="secondary" className="h-7 gap-1 text-xs" onClick={() => setHandoffFor(m)}>
                  <Share2 className="h-3.5 w-3.5" /> Send for review
                </Button>
                {origin && (
                  <Button size="sm" variant="secondary" className="h-7 gap-1 text-xs" disabled={busyId === m.id}
                    onClick={() => act(m.id, () => hub("return_to_origin", { message_id: m.id }), `Returned to ${agentName(agents.data, origin)}`)}>
                    {busyId === m.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CornerUpLeft className="h-3.5 w-3.5" />} Return to {agentName(agents.data, origin)}
                  </Button>
                )}
                {m.author_kind === "agent" && ["WORK", "REVISION", "REVIEW", "MESSAGE"].includes(m.kind) && (
                  <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs"
                    onClick={() => act(`d-${m.id}`, () => hub("decide", { thread_id: m.thread_id, message_id: m.id, decision: "APPROVED" }), "Approved")}>
                    <Check className="h-3.5 w-3.5" /> Approve
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs"
                  onClick={async () => { await navigator.clipboard.writeText(m.body); toast({ title: "Copied" }); }}>
                  <Copy className="h-3.5 w-3.5" /> Copy
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <div ref={bottomRef} />

      <HandoffSheet
        open={handoffFor !== null}
        onOpenChange={(o) => !o && setHandoffFor(null)}
        agents={agents.data ?? []}
        exclude={handoffFor ? [handoffFor.author] : []}
        title="Send for review"
        subtitle={handoffFor ? `${agentName(agents.data, handoffFor.author)}'s ${handoffFor.kind.toLowerCase()}: ${handoffFor.body.slice(0, 120)}` : undefined}
        onSubmit={async (v) => {
          if (!handoffFor) return;
          await act(handoffFor.id, () => hub("handoff", { thread_id: handoffFor.thread_id, source_message_id: handoffFor.id, ...v, instructions: v.instructions || undefined }), `Sent to ${agentName(agents.data, v.to_agent)}`);
        }}
      />
    </AgentHubShell>
  );
}

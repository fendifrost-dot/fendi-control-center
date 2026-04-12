import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Link } from "react-router-dom";
import { Home, RefreshCw, Zap } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { RequireSession } from "@/components/auth/RequireSession";

const short = (id: string | null) => id ? id.slice(0, 8) : "—";

/** Strip characters that break PostgREST `.or()` / `ilike` filter strings. */
function sanitizeTaskSearchFilter(s: string): string {
  return s.trim().replace(/[%*,()]/g, "");
}
const truncate = (s: string | null, n = 120) => s ? (s.length > n ? s.slice(0, n) + "…" : s) : "—";
const fmtDate = (d: string | null) => d ? new Date(d).toLocaleString() : "—";
const fmtTime = (d: Date) => d.toLocaleTimeString();

type TaskRow = {
  id: string; created_at: string; updated_at: string; status: string;
  request_text: string; requested_model: string | null; selected_tools: any;
  selected_workflow: string | null; result_json: any; error: string | null;
  session_id: string;
};
type OutboxRow = {
  id: string; task_id: string; chat_id: string; kind: string; status: string;
  attempt_count: number; next_attempt_at: string; last_error: string | null;
  created_at: string; sent_at: string | null; last_attempt_at: string | null;
  payload: any; dedupe_key: string | null; updated_at: string;
};

const statusColor = (s: string) => {
  switch (s) {
    case "succeeded": case "sent": return "default" as const;
    case "running": case "sending": case "queued": return "secondary" as const;
    case "failed": return "destructive" as const;
    default: return "outline" as const;
  }
};

const countByStatus = <T extends { status: string }>(rows: T[], statuses: string[]) =>
  statuses.map(s => ({ s, n: rows.filter(r => r.status === s).length }));

export default function Ops() {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [outbox, setOutbox] = useState<OutboxRow[]>([]);
  const [taskSearch, setTaskSearch] = useState("");
  const [taskStatusFilter, setTaskStatusFilter] = useState("all");
  const [outboxStatusFilter, setOutboxStatusFilter] = useState("all");
  const [selectedTask, setSelectedTask] = useState<TaskRow | null>(null);
  const [selectedOutbox, setSelectedOutbox] = useState<OutboxRow | null>(null);
  const [outboxTaskFilter, setOutboxTaskFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const drawerOpen = selectedTask !== null || selectedOutbox !== null;

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      let tq = supabase.from("tasks").select("*").order("created_at", { ascending: false }).limit(50);
      if (taskStatusFilter !== "all") tq = tq.eq("status", taskStatusFilter);
      const safeSearch = sanitizeTaskSearchFilter(taskSearch);
      if (safeSearch) tq = tq.or(`request_text.ilike.%${safeSearch}%,id.ilike.%${safeSearch}%`);
      const { data: tData } = await tq;
      setTasks((tData as TaskRow[]) || []);

      let oq = supabase.from("telegram_outbox").select("*").order("created_at", { ascending: false }).limit(100);
      if (outboxStatusFilter !== "all") oq = oq.eq("status", outboxStatusFilter);
      if (outboxTaskFilter) oq = oq.eq("task_id", outboxTaskFilter);
      const { data: oData } = await oq;
      setOutbox((oData as OutboxRow[]) || []);
      setLastRefreshed(new Date());
    } finally { setLoading(false); }
  }, [taskStatusFilter, outboxStatusFilter, outboxTaskFilter, taskSearch]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto-refresh: every 5s, paused when drawer open
  useEffect(() => {
    if (!autoRefresh || drawerOpen) return;
    const id = setInterval(fetchData, 5000);
    return () => clearInterval(id);
  }, [autoRefresh, drawerOpen, fetchData]);

  const handleFlushFailed = async () => {
    setFlushing(true);
    try {
      const { data, error } = await supabase.functions.invoke("telegram-outbox-flush", {
        body: { max: 10 },
      });
      if (error) throw error;
      toast({ title: "Flush complete", description: `Sent: ${data?.sent ?? 0}, Failed: ${data?.failed ?? 0}` });
      fetchData();
    } catch (e: any) {
      toast({ title: "Flush error", description: e.message, variant: "destructive" });
    } finally { setFlushing(false); }
  };

  const toolsDisplay = (tools: any) => {
    if (!tools) return "—";
    if (Array.isArray(tools)) return tools.join(", ");
    if (typeof tools === "object") return Object.keys(tools).join(", ");
    return String(tools);
  };

  const getResultField = (rj: any, field: string) => {
    if (!rj || typeof rj !== "object") return null;
    return rj[field] ?? null;
  };

  const taskStats = useMemo(() => countByStatus(tasks, ["queued", "running", "succeeded", "failed"]), [tasks]);
  const outboxStats = useMemo(() => countByStatus(outbox, ["queued", "sending", "sent", "failed"]), [outbox]);

  return (
    <RequireSession>
      <div className="min-h-screen bg-background p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <Home className="h-4 w-4" />
            Control Hub
          </Link>
          <span className="text-border hidden sm:inline">|</span>
          <h1 className="text-2xl font-bold text-foreground">Ops Dashboard</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">Last: {fmtTime(lastRefreshed)}</span>
          <div className="flex items-center gap-1.5">
            <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} className="h-4 w-8" />
            <span className="text-xs text-muted-foreground">Auto</span>
          </div>
          <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button variant="destructive" size="sm" onClick={handleFlushFailed} disabled={flushing}>
            <Zap className="h-4 w-4 mr-1" /> Flush Failed
          </Button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="flex flex-wrap gap-4 mb-3">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-semibold">Tasks:</span>
          {taskStats.map(({ s, n }) => (
            <Badge key={s} variant={statusColor(s)} className="text-[10px] px-1.5 py-0">{s} {n}</Badge>
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-semibold">Outbox:</span>
          {outboxStats.map(({ s, n }) => (
            <Badge key={s} variant={statusColor(s)} className="text-[10px] px-1.5 py-0">{s} {n}</Badge>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Tasks */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Tasks</CardTitle>
            <div className="flex gap-2 mt-2">
              <Input placeholder="Search by text or ID…" value={taskSearch} onChange={e => setTaskSearch(e.target.value)} onKeyDown={e => e.key === "Enter" && fetchData()} className="h-8 text-sm" />
              <Select value={taskStatusFilter} onValueChange={setTaskStatusFilter}>
                <SelectTrigger className="w-32 h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="queued">Queued</SelectItem>
                  <SelectItem value="running">Running</SelectItem>
                  <SelectItem value="succeeded">Succeeded</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[calc(100vh-280px)]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Time</TableHead>
                    <TableHead className="text-xs">ID</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs">Model</TableHead>
                    <TableHead className="text-xs">Tools</TableHead>
                    <TableHead className="text-xs">Step</TableHead>
                    <TableHead className="text-xs">Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tasks.map(t => (
                    <TableRow key={t.id} className="cursor-pointer text-xs" onClick={() => setSelectedTask(t)}>
                      <TableCell className="py-1.5">{fmtDate(t.created_at)}</TableCell>
                      <TableCell className="py-1.5 font-mono">{short(t.id)}</TableCell>
                      <TableCell className="py-1.5"><Badge variant={statusColor(t.status)} className="text-xs">{t.status}</Badge></TableCell>
                      <TableCell className="py-1.5">{t.requested_model || getResultField(t.result_json, "model_used") || "—"}</TableCell>
                      <TableCell className="py-1.5 max-w-[120px] truncate">{toolsDisplay(t.selected_tools)}</TableCell>
                      <TableCell className="py-1.5">{getResultField(t.result_json, "progress_step") || "—"}</TableCell>
                      <TableCell className="py-1.5 max-w-[120px] truncate text-destructive">{truncate(t.error)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Outbox */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Telegram Outbox</CardTitle>
              {outboxTaskFilter && (
                <Button variant="ghost" size="sm" onClick={() => setOutboxTaskFilter(null)} className="text-xs h-6">
                  Clear filter
                </Button>
              )}
            </div>
            <div className="flex gap-2 mt-2">
              <Select value={outboxStatusFilter} onValueChange={setOutboxStatusFilter}>
                <SelectTrigger className="w-32 h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="queued">Queued</SelectItem>
                  <SelectItem value="sending">Sending</SelectItem>
                  <SelectItem value="sent">Sent</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[calc(100vh-280px)]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Time</TableHead>
                    <TableHead className="text-xs">ID</TableHead>
                    <TableHead className="text-xs">Task</TableHead>
                    <TableHead className="text-xs">Kind</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs">Tries</TableHead>
                    <TableHead className="text-xs">Next</TableHead>
                    <TableHead className="text-xs">Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {outbox.map(o => (
                    <TableRow key={o.id} className="cursor-pointer text-xs" onClick={() => setSelectedOutbox(o)}>
                      <TableCell className="py-1.5">{fmtDate(o.created_at)}</TableCell>
                      <TableCell className="py-1.5 font-mono">{short(o.id)}</TableCell>
                      <TableCell className="py-1.5 font-mono">{short(o.task_id)}</TableCell>
                      <TableCell className="py-1.5">{o.kind}</TableCell>
                      <TableCell className="py-1.5"><Badge variant={statusColor(o.status)} className="text-xs">{o.status}</Badge></TableCell>
                      <TableCell className="py-1.5">{o.attempt_count}</TableCell>
                      <TableCell className="py-1.5">{fmtDate(o.next_attempt_at)}</TableCell>
                      <TableCell className="py-1.5 max-w-[120px] truncate text-destructive">{truncate(o.last_error)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* Task detail drawer */}
      <Sheet open={!!selectedTask} onOpenChange={() => setSelectedTask(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader><SheetTitle>Task {short(selectedTask?.id ?? "")}</SheetTitle></SheetHeader>
          {selectedTask && (
            <div className="mt-4 space-y-4 text-sm">
              <div><span className="font-semibold text-muted-foreground">Status:</span> <Badge variant={statusColor(selectedTask.status)}>{selectedTask.status}</Badge></div>
              <div><span className="font-semibold text-muted-foreground">Created:</span> {fmtDate(selectedTask.created_at)}</div>
              <div><span className="font-semibold text-muted-foreground">Updated:</span> {fmtDate(selectedTask.updated_at)}</div>
              <div><span className="font-semibold text-muted-foreground">Model:</span> {selectedTask.requested_model || "—"}</div>
              <div><span className="font-semibold text-muted-foreground">Workflow:</span> {selectedTask.selected_workflow || "—"}</div>
              <div><span className="font-semibold text-muted-foreground">Tools:</span> {toolsDisplay(selectedTask.selected_tools)}</div>
              <div>
                <span className="font-semibold text-muted-foreground">Request:</span>
                <pre className="mt-1 p-2 bg-muted rounded text-xs whitespace-pre-wrap">{selectedTask.request_text}</pre>
              </div>
              {selectedTask.error && (
                <div>
                  <span className="font-semibold text-destructive">Error:</span>
                  <pre className="mt-1 p-2 bg-destructive/10 rounded text-xs whitespace-pre-wrap">{selectedTask.error}</pre>
                </div>
              )}
              <div>
                <span className="font-semibold text-muted-foreground">Result JSON:</span>
                <pre className="mt-1 p-2 bg-muted rounded text-xs whitespace-pre-wrap max-h-60 overflow-auto">{JSON.stringify(selectedTask.result_json, null, 2)}</pre>
              </div>
              <Button variant="outline" size="sm" onClick={() => { setOutboxTaskFilter(selectedTask.id); setSelectedTask(null); }}>
                Show matching outbox messages
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Outbox detail drawer */}
      <Sheet open={!!selectedOutbox} onOpenChange={() => setSelectedOutbox(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader><SheetTitle>Outbox {short(selectedOutbox?.id ?? "")}</SheetTitle></SheetHeader>
          {selectedOutbox && (
            <div className="mt-4 space-y-4 text-sm">
              <div><span className="font-semibold text-muted-foreground">Status:</span> <Badge variant={statusColor(selectedOutbox.status)}>{selectedOutbox.status}</Badge></div>
              <div><span className="font-semibold text-muted-foreground">Kind:</span> {selectedOutbox.kind}</div>
              <div><span className="font-semibold text-muted-foreground">Task ID:</span> <span className="font-mono">{selectedOutbox.task_id}</span></div>
              <div><span className="font-semibold text-muted-foreground">Dedupe Key:</span> {selectedOutbox.dedupe_key || "—"}</div>
              <div><span className="font-semibold text-muted-foreground">Attempts:</span> {selectedOutbox.attempt_count}</div>
              <div><span className="font-semibold text-muted-foreground">Created:</span> {fmtDate(selectedOutbox.created_at)}</div>
              <div><span className="font-semibold text-muted-foreground">Sent:</span> {fmtDate(selectedOutbox.sent_at)}</div>
              <div><span className="font-semibold text-muted-foreground">Last Attempt:</span> {fmtDate(selectedOutbox.last_attempt_at)}</div>
              <div><span className="font-semibold text-muted-foreground">Next Attempt:</span> {fmtDate(selectedOutbox.next_attempt_at)}</div>
              {selectedOutbox.last_error && (
                <div>
                  <span className="font-semibold text-destructive">Error:</span>
                  <pre className="mt-1 p-2 bg-destructive/10 rounded text-xs whitespace-pre-wrap">{selectedOutbox.last_error}</pre>
                </div>
              )}
              <div>
                <span className="font-semibold text-muted-foreground">Payload:</span>
                <pre className="mt-1 p-2 bg-muted rounded text-xs whitespace-pre-wrap max-h-60 overflow-auto">{JSON.stringify(selectedOutbox.payload, null, 2)}</pre>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
    </RequireSession>
  );
}

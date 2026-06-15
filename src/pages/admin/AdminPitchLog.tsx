import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type PitchRow = {
  id: string;
  playlist_id: string | null;
  track_name: string;
  curator_email: string | null;
  method: string | null;
  status: string | null;
  pitched_at: string | null;
  sent_at: string | null;
  cooldown_until: string | null;
  reply_received: boolean | null;
  placed: boolean | null;
  placement_status: string | null;
  response_notes: string | null;
  follow_up_at: string | null;
};

type Stats = {
  sent: number;
  replied: number;
  placed: number;
  errored: number;
  pending: number;
  sent_last_24h: number;
  sent_last_7d: number;
  reply_rate_pct: number;
  placement_rate_pct: number;
};

type ResponseChoice = "awaiting" | "replied_no_place" | "placed" | "rejected";

function responseFromRow(r: PitchRow): ResponseChoice {
  if (r.placed === true || r.placement_status === "placed") return "placed";
  if (r.placement_status === "rejected") return "rejected";
  if (r.reply_received === true) return "replied_no_place";
  return "awaiting";
}

function patchForResponse(c: ResponseChoice): Record<string, unknown> {
  if (c === "placed") return { placed: true, reply_received: true, placement_status: "placed" };
  if (c === "replied_no_place") return { placed: false, reply_received: true, placement_status: "responded" };
  if (c === "rejected") return { placed: false, reply_received: true, placement_status: "rejected" };
  return { placed: false, reply_received: false, placement_status: null };
}

const AdminPitchLog: React.FC = () => {
  const [rows, setRows] = useState<PitchRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [trackFilter, setTrackFilter] = useState("Designed For Me (Control)");
  const [onlyPending, setOnlyPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editingNotesId, setEditingNotesId] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pitches, summary] = await Promise.all([
        callHubFn<{ rows: PitchRow[] }>("list_pitches", {
          track_name: trackFilter.trim() || undefined,
          only_pending_response: onlyPending,
          limit: 200,
        }),
        callHubFn<{ totals: Stats }>("pitch_stats_summary", {
          track_name: trackFilter.trim() || undefined,
        }),
      ]);
      setRows(pitches.rows ?? []);
      setStats(summary.totals ?? null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load pitch tracker");
    } finally {
      setLoading(false);
    }
  }, [trackFilter, onlyPending]);

  useEffect(() => { load(); }, [load]);

  const updateResponse = async (row: PitchRow, choice: ResponseChoice) => {
    setSavingId(row.id);
    try {
      const patch = patchForResponse(choice);
      await callHubFn("mark_pitch_response", { pitch_log_id: row.id, ...patch });
      toast.success(`Marked ${choice.replace(/_/g, " ")}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update");
    } finally {
      setSavingId(null);
    }
  };

  const saveNotes = async (rowId: string) => {
    setSavingId(rowId);
    try {
      await callHubFn("mark_pitch_response", { pitch_log_id: rowId, response_notes: notesDraft });
      toast.success("Notes saved");
      setEditingNotesId(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save notes");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <Link to="/admin" className="text-xs text-muted-foreground hover:underline">← Command center</Link>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">Pitch tracker</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Audit trail + response tracking for playlist pitches. Mark replied / placed / rejected to drive warm-pitch
          detection and reply-rate stats. Fan blasts live under{" "}
          <Link to="/admin/campaigns" className="underline">Campaigns</Link>.
        </p>
      </div>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Sent (total)</div>
            <div className="text-2xl font-semibold">{stats.sent}</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Replies</div>
            <div className="text-2xl font-semibold">
              {stats.replied} <span className="text-sm text-muted-foreground">({stats.reply_rate_pct}%)</span>
            </div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Placed</div>
            <div className="text-2xl font-semibold">
              {stats.placed} <span className="text-sm text-muted-foreground">({stats.placement_rate_pct}%)</span>
            </div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Last 24h</div>
            <div className="text-2xl font-semibold">{stats.sent_last_24h}</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Awaiting response</div>
            <div className="text-2xl font-semibold">{stats.pending}</div>
          </Card>
        </div>
      )}

      <Card className="p-4 flex flex-wrap gap-4 items-end">
        <div>
          <label className="text-xs text-muted-foreground">Filter by track</label>
          <Input className="mt-1 w-72" value={trackFilter} onChange={(e) => setTrackFilter(e.target.value)} />
        </div>
        <div className="flex items-center gap-2 pb-1">
          <input
            id="only-pending"
            type="checkbox"
            checked={onlyPending}
            onChange={(e) => setOnlyPending(e.target.checked)}
          />
          <label htmlFor="only-pending" className="text-sm">Only awaiting response</label>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>Refresh</Button>
      </Card>

      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Sent at</th>
              <th className="text-left p-3">Playlist</th>
              <th className="text-left p-3">Curator</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Response</th>
              <th className="text-left p-3">Notes</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="p-4 text-muted-foreground">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-6 text-muted-foreground text-center">
                  No pitches match. Send from{" "}
                  <Link to="/admin/pitch-composer" className="underline">Pitch Composer</Link>.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const choice = responseFromRow(r);
                return (
                  <tr key={r.id} className="border-t align-top">
                    <td className="p-3 text-xs whitespace-nowrap">
                      {r.sent_at ? new Date(r.sent_at).toLocaleString() : r.pitched_at ? new Date(r.pitched_at).toLocaleString() : "—"}
                    </td>
                    <td className="p-3 font-mono text-xs max-w-[200px] truncate" title={r.playlist_id ?? ""}>
                      {r.playlist_id ?? "—"}
                    </td>
                    <td className="p-3 text-xs">{r.curator_email ?? "—"}</td>
                    <td className="p-3">
                      <Badge variant={r.status === "sent" ? "default" : r.status === "error" ? "destructive" : "secondary"}>
                        {r.status ?? "—"}
                      </Badge>
                    </td>
                    <td className="p-3">
                      <Select
                        value={choice}
                        onValueChange={(v) => updateResponse(r, v as ResponseChoice)}
                        disabled={savingId === r.id || r.status !== "sent"}
                      >
                        <SelectTrigger className="w-44 h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="awaiting">Awaiting</SelectItem>
                          <SelectItem value="replied_no_place">Replied (no place)</SelectItem>
                          <SelectItem value="placed">Placed ✓</SelectItem>
                          <SelectItem value="rejected">Rejected</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="p-3 max-w-md">
                      {editingNotesId === r.id ? (
                        <div className="space-y-1">
                          <Textarea
                            value={notesDraft}
                            onChange={(e) => setNotesDraft(e.target.value)}
                            className="text-xs"
                            rows={3}
                          />
                          <div className="flex gap-1">
                            <Button size="sm" onClick={() => saveNotes(r.id)} disabled={savingId === r.id}>Save</Button>
                            <Button size="sm" variant="ghost" onClick={() => { setEditingNotesId(null); setNotesDraft(""); }}>Cancel</Button>
                          </div>
                        </div>
                      ) : (
                        <div
                          className="text-xs text-muted-foreground cursor-pointer hover:text-foreground"
                          onClick={() => { setEditingNotesId(r.id); setNotesDraft(r.response_notes ?? ""); }}
                        >
                          {r.response_notes || <span className="italic">click to add notes</span>}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default AdminPitchLog;

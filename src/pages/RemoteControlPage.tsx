import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Home, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { RequireSession } from "@/components/auth/RequireSession";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

type CommandRow = {
  id: string;
  command_type: string;
  status: string;
  payload: { text?: string };
  result_json: { stdout?: string; message?: string } | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

type BridgeHealth = {
  online?: boolean;
  queued_commands?: number;
  bridge_token_configured?: boolean;
};

export default function RemoteControlPage() {
  const { toast } = useToast();
  const [health, setHealth] = useState<BridgeHealth | null>(null);
  const [commands, setCommands] = useState<CommandRow[]>([]);
  const [commandType, setCommandType] = useState("shell");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const refresh = useCallback(async () => {
    const { data: h } = await supabase.functions.invoke("remote-bridge-api", {
      body: { action: "health" },
    });
    setHealth((h as BridgeHealth) ?? null);

    const { data: rows } = await supabase
      .from("remote_command_queue")
      .select("id, command_type, status, payload, result_json, error, created_at, completed_at")
      .order("created_at", { ascending: false })
      .limit(30);
    setCommands((rows as CommandRow[]) ?? []);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 8000);
    return () => clearInterval(t);
  }, [refresh]);

  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      const payload =
        commandType === "open_url"
          ? { url: text.trim() }
          : commandType === "notify"
            ? { text: text.trim() }
            : { text: text.trim() };
      const { data, error } = await supabase.functions.invoke("remote-bridge-api", {
        body: {
          action: "enqueue",
          command_type: commandType,
          payload,
          source: "web",
        },
      });
      if (error) throw error;
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
      toast({ title: "Queued for your Mac", description: `Command ${(data as { command?: { id: string } })?.command?.id?.slice(0, 8) ?? ""}` });
      setText("");
      await refresh();
    } catch (e) {
      toast({
        title: "Enqueue failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <RequireSession>
      <div className="min-h-screen bg-background p-4 pb-24">
        <div className="mx-auto flex max-w-lg flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-semibold">Remote Mac</h1>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="icon" onClick={() => void refresh()} aria-label="Refresh">
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button type="button" variant="outline" size="icon" asChild>
                <Link to="/" aria-label="Home">
                  <Home className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Bridge status</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2 text-sm">
              <Badge variant={health?.online ? "default" : "destructive"}>
                {health?.online ? "Mac online" : "Mac offline"}
              </Badge>
              <Badge variant="outline">Queued: {health?.queued_commands ?? "—"}</Badge>
              {!health?.bridge_token_configured && (
                <span className="text-xs text-muted-foreground">Set REMOTE_BRIDGE_TOKEN in Supabase secrets</span>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Send to Mac</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Select value={commandType} onValueChange={setCommandType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shell">Shell</SelectItem>
                  <SelectItem value="cursor_agent">Cursor agent</SelectItem>
                  <SelectItem value="claude">Claude CLI</SelectItem>
                  <SelectItem value="open_url">Open URL</SelectItem>
                  <SelectItem value="notify">macOS notify</SelectItem>
                </SelectContent>
              </Select>
              <Textarea
                placeholder={
                  commandType === "shell"
                    ? "git status"
                    : commandType === "open_url"
                      ? "https://github.com/..."
                      : "Your prompt or message"
                }
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                className="font-mono text-sm"
              />
              <Button type="button" className="w-full" disabled={sending} onClick={() => void send()}>
                <Send className="mr-2 h-4 w-4" />
                Queue command
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Recent commands</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {commands.length === 0 && (
                <p className="text-sm text-muted-foreground">No commands yet. Use Telegram /mac or queue above.</p>
              )}
              {commands.map((c) => (
                <div key={c.id} className="rounded-md border p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono">{c.command_type}</span>
                    <Badge variant="outline">{c.status}</Badge>
                  </div>
                  <p className="mt-1 truncate text-muted-foreground">{c.payload?.text ?? ""}</p>
                  {c.result_json?.message && <p className="mt-1">{c.result_json.message}</p>}
                  {c.result_json?.stdout && (
                    <pre className="mt-2 max-h-32 overflow-auto rounded bg-muted p-2">{c.result_json.stdout}</pre>
                  )}
                  {c.error && <p className="mt-1 text-destructive">{c.error}</p>}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </RequireSession>
  );
}

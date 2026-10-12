import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, Loader2, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { SOURCE_APPS, uploadAttachment, type Attachment, type HubAgent, type HubHandoff, type WorkContext } from "@/lib/agentHub";
import { StateDot } from "./bits";

export type ComposeResult = {
  title: string;
  project: string;
  body: string;
  kind: "MESSAGE" | "WORK" | "IMPORT";
  source_app?: string;
  url?: string;
  context: WorkContext;
  attachments: Attachment[];
  to_agent: string | null;
  purpose: HubHandoff["purpose"];
  instructions: string;
};

/** New thread, or bring in content from ChatGPT / Claude / Grok apps (mode="import"). */
export function ComposeSheet({ open, onOpenChange, mode, agents, onSubmit }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mode: "new" | "import";
  agents: HubAgent[];
  onSubmit: (r: ComposeResult) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<"MESSAGE" | "WORK">("WORK");
  const [sourceApp, setSourceApp] = useState("chatgpt-app");
  const [url, setUrl] = useState("");
  const [repo, setRepo] = useState("fendifrost-dot/fendi-control-center");
  const [sha, setSha] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [to, setTo] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<HubHandoff["purpose"]>("REVIEW");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(""); setProject(""); setBody(""); setUrl(""); setSha(""); setPrUrl(""); setFiles([]); setInstructions("");
    setTo(null); setError(null); setPurpose(mode === "import" ? "REVIEW" : "TASK");
  }, [open, mode]);

  const targets = agents.filter((a) => a.kind !== "human" && a.effective.state !== "disabled");

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setBody((b) => (b ? `${b}\n\n${text}` : text));
    } catch {
      setError("Clipboard access was blocked — long-press the box and choose Paste.");
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[94dvh]">
        <DrawerHeader className="text-left">
          <DrawerTitle>{mode === "import" ? "Bring in from another app" : "New thread"}</DrawerTitle>
          <DrawerDescription>
            {mode === "import"
              ? "Paste what ChatGPT, Claude or Grok produced. It is saved as an import, labelled with the app, and can go straight to a reviewer."
              : "Start a conversation with an agent, or post work for review."}
          </DrawerDescription>
        </DrawerHeader>
        <div className="space-y-3 overflow-y-auto px-4">
          {mode === "import" && (
            <div className="flex flex-wrap gap-1.5">
              {SOURCE_APPS.map((s) => (
                <button key={s.value} type="button" onClick={() => setSourceApp(s.value)}
                  className={cn("rounded-full border px-3 py-1 text-xs", sourceApp === s.value ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={mode === "import" ? "Title (optional)" : "Title"} />
          <div className="relative">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7}
              placeholder={mode === "import" ? "Paste the content here" : "Message or the work to review"} />
            <Button type="button" size="sm" variant="secondary" className="absolute bottom-2 right-2 h-7 gap-1 text-xs" onClick={paste}>
              <ClipboardPaste className="h-3.5 w-3.5" /> Paste
            </Button>
          </div>
          {mode === "new" && (
            <div className="flex gap-1.5">
              {(["WORK", "MESSAGE"] as const).map((k) => (
                <button key={k} type="button" onClick={() => setKind(k)}
                  className={cn("rounded-full border px-3 py-1 text-xs", kind === k ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
                  {k === "WORK" ? "This is work to review" : "Just a message"}
                </button>
              ))}
            </div>
          )}
          {mode === "import" && <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link to the original chat (optional)" inputMode="url" />}

          <Collapsible>
            <CollapsibleTrigger className="text-xs font-medium text-muted-foreground underline-offset-2 hover:underline">
              Add code revision, project, files
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-2">
              <Input value={project} onChange={(e) => setProject(e.target.value)} placeholder="Project (e.g. control-center)" />
              <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" />
              <Input value={sha} onChange={(e) => setSha(e.target.value.trim())} placeholder="Exact commit SHA" className="font-mono" />
              <Input value={prUrl} onChange={(e) => setPrUrl(e.target.value)} placeholder="Pull request URL" inputMode="url" />
              <div className="flex flex-wrap items-center gap-2">
                <input ref={fileRef} type="file" multiple className="hidden" onChange={async (e) => {
                  const list = Array.from(e.target.files ?? []);
                  if (!list.length) return;
                  setUploading(true);
                  try {
                    const key = `inbox/${new Date().toISOString().slice(0, 10)}`;
                    const up = await Promise.all(list.map((f) => uploadAttachment(key, f)));
                    setFiles((cur) => [...cur, ...up]);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setUploading(false);
                    if (fileRef.current) fileRef.current.value = "";
                  }
                }} />
                <Button type="button" size="sm" variant="outline" className="gap-1" onClick={() => fileRef.current?.click()} disabled={uploading}>
                  {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />} Attach
                </Button>
                {files.map((f, i) => (
                  <span key={f.storage_path} className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs">
                    {f.name}
                    <button type="button" aria-label="Remove" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}><X className="h-3 w-3" /></button>
                  </span>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">Send to (optional)</div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => setTo(null)}
                className={cn("rounded-full border px-3 py-1 text-xs", to === null ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
                Nobody yet
              </button>
              {targets.map((a) => (
                <button key={a.key} type="button" onClick={() => setTo(a.key)}
                  className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs", to === a.key ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
                  <StateDot state={a.effective.state} /> {a.display_name}
                </button>
              ))}
            </div>
            {to && (
              <>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {(["REVIEW", "TASK", "QUESTION"] as const).map((p) => (
                    <button key={p} type="button" onClick={() => setPurpose(p)}
                      className={cn("rounded-full border px-3 py-1 text-xs", purpose === p ? "border-foreground bg-muted" : "border-border text-muted-foreground")}>
                      {p.charAt(0) + p.slice(1).toLowerCase()}
                    </button>
                  ))}
                </div>
                <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={2} placeholder="Instructions for the agent (optional)" />
              </>
            )}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DrawerFooter>
          <Button
            disabled={busy || uploading || !body.trim() || (mode === "new" && !title.trim())}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const context: WorkContext = {};
                if (sha) { context.repo = repo; context.commit_sha = sha; }
                if (prUrl) context.pr_url = prUrl;
                await onSubmit({
                  title: title.trim(), project: project.trim(), body, kind: mode === "import" ? "IMPORT" : kind,
                  source_app: mode === "import" ? sourceApp : undefined, url: url.trim() || undefined, context, attachments: files,
                  to_agent: to, purpose, instructions: instructions.trim(),
                });
                onOpenChange(false);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {mode === "import" ? "Save import" : "Create thread"}{to ? " and send" : ""}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

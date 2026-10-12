import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { KIND_LABEL, STATE_STYLE, type HubAgent, type HubHandoff } from "@/lib/agentHub";
import { StateDot } from "./bits";

const PURPOSES: Array<{ value: HubHandoff["purpose"]; label: string; hint: string }> = [
  { value: "REVIEW", label: "Review", hint: "Independent check of this work" },
  { value: "TASK", label: "Task", hint: "Do something with it" },
  { value: "QUESTION", label: "Question", hint: "Ask about it" },
  { value: "REVISE", label: "Revise", hint: "Change it per your notes" },
];

/** Pick an agent and purpose; the hub builds the context packet from the selected message. */
export function HandoffSheet({ open, onOpenChange, agents, exclude, defaultPurpose = "REVIEW", title, subtitle, onSubmit }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  agents: HubAgent[];
  exclude?: string[];
  defaultPurpose?: HubHandoff["purpose"];
  title: string;
  subtitle?: string;
  onSubmit: (v: { to_agent: string; purpose: HubHandoff["purpose"]; instructions: string }) => Promise<void>;
}) {
  const choices = agents.filter((a) => a.kind !== "human" && !(exclude ?? []).includes(a.key) && a.effective.state !== "disabled");
  const [to, setTo] = useState<string>("");
  const [purpose, setPurpose] = useState<HubHandoff["purpose"]>(defaultPurpose);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPurpose(defaultPurpose);
    setInstructions("");
    const firstLive = choices.find((a) => a.effective.state === "live") ?? choices.find((a) => a.effective.state === "unverified");
    setTo((cur) => (cur && choices.some((c) => c.key === cur) ? cur : firstLive?.key ?? choices[0]?.key ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selected = choices.find((a) => a.key === to);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[90dvh]">
        <DrawerHeader className="text-left">
          <DrawerTitle>{title}</DrawerTitle>
          {subtitle && <DrawerDescription className="line-clamp-2">{subtitle}</DrawerDescription>}
        </DrawerHeader>
        <div className="space-y-4 overflow-y-auto px-4">
          <div className="space-y-1.5">
            {choices.map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={() => setTo(a.key)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                  to === a.key ? "border-foreground bg-muted/60" : "border-border hover:bg-muted/40",
                )}
              >
                <StateDot state={a.effective.state} className="mt-1.5" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{a.display_name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {KIND_LABEL[a.kind]} · {STATE_STYLE[a.effective.state].label}
                  </span>
                </span>
              </button>
            ))}
          </div>
          {selected && selected.effective.state !== "live" && (
            <p className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">
              {selected.effective.reason} It will be queued and delivered when available.
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {PURPOSES.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setPurpose(p.value)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs",
                  purpose === p.value ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground",
                )}
                title={p.hint}
              >
                {p.label}
              </button>
            ))}
          </div>
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Instructions (optional) — what to focus on"
            rows={3}
          />
          {selected && <p className="text-xs text-muted-foreground">Billing: {selected.billing}</p>}
        </div>
        <DrawerFooter>
          <Button
            disabled={!to || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit({ to_agent: to, purpose, instructions });
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Send to {selected?.display_name ?? "agent"}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

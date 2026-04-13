import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Plus, User, ChevronRight, FileSpreadsheet, Users, FolderOpen, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type ClientRow = {
  id: string;
  name: string;
  email: string | null;
  created_at: string | null;
};

export default function ClientsPage() {
  const { toast } = useToast();
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [returnCount, setReturnCount] = useState<Record<string, number>>({});
  const [lastActivity, setLastActivity] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    business_type: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    const { data: cRows, error: ce } = await supabase
      .from("clients")
      .select("id,name,email,created_at")
      .order("name");
    if (ce) {
      toast({ title: "Could not load clients", description: ce.message, variant: "destructive" });
      setLoading(false);
      return;
    }
    setClients((cRows as unknown as ClientRow[]) ?? []);

    const { data: tr } = await supabase.from("tax_returns").select("client_id,updated_at");
    const counts: Record<string, number> = {};
    const last: Record<string, string> = {};
    for (const r of tr || []) {
      const id = r.client_id as string;
      counts[id] = (counts[id] ?? 0) + 1;
      const u = r.updated_at as string | null;
      if (u && (!last[id] || u > last[id])) last[id] = u;
    }
    setReturnCount(counts);
    setLastActivity(last);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addClient(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    const drive_folder_id = `dashboard-${crypto.randomUUID()}`;
    const { error } = await supabase.from("clients").insert({
      name: form.name.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      business_type: form.business_type.trim() || null,
      drive_folder_id,
    });
    setSaving(false);
    if (error) {
      toast({ title: "Could not add client", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Client added" });
    setForm({ name: "", email: "", phone: "", business_type: "" });
    setOpen(false);
    void load();
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || (c.email && c.email.toLowerCase().includes(q)),
    );
  }, [clients, search]);

  const totalReturnRows = useMemo(
    () => Object.values(returnCount).reduce((a, n) => a + n, 0),
    [returnCount],
  );

  return (
    <div className="space-y-10">
      <section className="overflow-hidden rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.12] via-background to-background shadow-sm">
        <div className="p-6 sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                Tax preparation
              </p>
              <h1 className="text-3xl font-bold tracking-tight">Client workspace</h1>
              <p className="max-w-2xl text-muted-foreground">
                Add clients, open a tax year per client, upload source documents, run Drive ingestion and analysis, then
                generate worksheets, IRS drafts, and TurboTax (TXF) exports — all from the year workspace.
              </p>
            </div>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="lg" className="shrink-0 gap-2">
                  <Plus className="h-5 w-5" />
                  Add client
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <form onSubmit={addClient}>
                  <DialogHeader>
                    <DialogTitle>New client</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                      <Label htmlFor="name">Name</Label>
                      <Input
                        id="name"
                        value={form.name}
                        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                        placeholder="Jane Smith"
                        required
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email"
                        type="email"
                        value={form.email}
                        onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                        placeholder="optional"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="phone">Phone</Label>
                      <Input
                        id="phone"
                        value={form.phone}
                        onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                        placeholder="optional"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="biz">Business type</Label>
                      <Input
                        id="biz"
                        value={form.business_type}
                        onChange={(e) => setForm((f) => ({ ...f, business_type: e.target.value }))}
                        placeholder="e.g. Sole prop, W-2 only"
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button type="submit" disabled={saving}>
                      {saving ? "Saving…" : "Create client"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <Card className="border-emerald-500/15 bg-background/60">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  Clients
                </CardDescription>
                <CardTitle className="text-2xl tabular-nums">{loading ? "—" : clients.length}</CardTitle>
              </CardHeader>
            </Card>
            <Card className="border-emerald-500/15 bg-background/60">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <FileSpreadsheet className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  Tax return records
                </CardDescription>
                <CardTitle className="text-2xl tabular-nums">{loading ? "—" : totalReturnRows}</CardTitle>
              </CardHeader>
            </Card>
            <Card className="border-emerald-500/15 bg-background/60">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <FolderOpen className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  Showing
                </CardDescription>
                <CardTitle className="text-2xl tabular-nums">{loading ? "—" : filtered.length}</CardTitle>
              </CardHeader>
            </Card>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Your clients</h2>
            <p className="mt-1 text-sm text-muted-foreground">Select a client to view tax years, documents, and outputs.</p>
          </div>
          <Input
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-md"
          />
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading clients…</p>
        ) : clients.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                <User className="h-7 w-7 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium">No clients yet</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Create your first client, then open their profile to add tax years and upload documents.
                </p>
              </div>
              <Button onClick={() => setOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add client
              </Button>
            </CardContent>
          </Card>
        ) : filtered.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No clients match “{search.trim()}”.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {filtered.map((c) => (
              <Link key={c.id} to={`/clients/${c.id}`} className="group block">
                <Card className="h-full border-border/80 transition-all hover:border-primary/35 hover:shadow-md">
                  <CardHeader className="flex flex-row items-start gap-4 space-y-0 pb-2">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <User className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-lg leading-tight">{c.name}</CardTitle>
                        <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      </div>
                      {c.email && (
                        <p className="mt-1 truncate text-sm text-muted-foreground">{c.email}</p>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-1 text-sm text-muted-foreground">
                    <p>
                      <span className="text-foreground/80">Tax returns on file:</span> {returnCount[c.id] ?? 0}
                    </p>
                    <p>
                      <span className="text-foreground/80">Last activity:</span>{" "}
                      {lastActivity[c.id] ? new Date(lastActivity[c.id]).toLocaleString() : "—"}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border bg-muted/30 p-5 sm:p-6">
        <h3 className="text-sm font-semibold">Typical workflow</h3>
        <Separator className="my-3" />
        <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
          <li>
            <span className="text-foreground">Add a client</span> (or pick one above).
          </li>
          <li>
            <span className="text-foreground">Open a tax year</span> — create or select the year you are preparing.
          </li>
          <li>
            <span className="text-foreground">Upload documents</span> on the Documents tab, run analysis / Drive ingestion as
            needed, then <span className="text-foreground">generate</span> worksheets, PDFs, and TXF from the return
            workspace.
          </li>
        </ol>
      </section>
    </div>
  );
}

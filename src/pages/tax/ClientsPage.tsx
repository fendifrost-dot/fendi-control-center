import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Session } from "@supabase/supabase-js";
import { Plus, User } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type ClientRow = {
  id: string;
  name: string;
  email: string | null;
  created_at: string | null;
};

export default function ClientsPage() {
  const { toast } = useToast();
  const [session, setSession] = useState<Session | null>(null);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [returnCount, setReturnCount] = useState<Record<string, number>>({});
  const [lastActivity, setLastActivity] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    business_type: "",
  });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const load = useCallback(async () => {
    if (!session) return;
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
    setClients((cRows as ClientRow[]) ?? []);

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
  }, [session, toast]);

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

  if (!session) {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <p className="text-muted-foreground">Sign in to manage tax clients.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Clients</h1>
          <p className="mt-1 text-muted-foreground">
            Choose a client to open their returns and documents.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
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

      {loading ? (
        <p className="text-muted-foreground">Loading clients…</p>
      ) : clients.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No clients yet. Add one to start a return.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {clients.map((c) => (
            <Link key={c.id} to={`/clients/${c.id}`}>
              <Card className="h-full transition-colors hover:border-primary/40 hover:bg-muted/30">
                <CardHeader className="flex flex-row items-start gap-3 space-y-0 pb-2">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <User className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <CardTitle className="text-lg leading-tight">{c.name}</CardTitle>
                    {c.email && (
                      <p className="mt-1 truncate text-sm text-muted-foreground">{c.email}</p>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  <p>Returns: {returnCount[c.id] ?? 0}</p>
                  <p>
                    Last activity:{" "}
                    {lastActivity[c.id]
                      ? new Date(lastActivity[c.id]).toLocaleString()
                      : "—"}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

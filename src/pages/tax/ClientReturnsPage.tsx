import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { ArrowLeft, CalendarPlus } from "lucide-react";

const DEFAULT_YEARS = [2022, 2023, 2024, 2025];

function displayStatus(
  row: { status: string | null } | null,
  docCount: number,
): { label: string; variant: "default" | "secondary" | "outline" } {
  if (!row && docCount === 0) return { label: "Not started", variant: "outline" };
  if (!row && docCount > 0) return { label: "In progress", variant: "secondary" };
  const s = row?.status ?? "draft";
  if (s === "filed" || s === "review") return { label: "Complete", variant: "default" };
  if (s === "draft" || s === "gathering_docs") return { label: "Draft", variant: "secondary" };
  return { label: "In progress", variant: "secondary" };
}

export default function ClientReturnsPage() {
  const { clientId } = useParams<{ clientId: string }>();
  const [session, setSession] = useState<Session | null>(null);
  const [clientName, setClientName] = useState("");
  const [returnsMap, setReturnsMap] = useState<Record<number, Record<string, unknown>>>({});
  const [docCounts, setDocCounts] = useState<Record<number, number>>({});
  const [extraOpen, setExtraOpen] = useState(false);
  const [extraYear, setExtraYear] = useState("");
  const [extras, setExtras] = useState<number[]>([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const load = useCallback(async () => {
    if (!clientId) return;
    const { data: c } = await supabase.from("clients").select("name").eq("id", clientId).maybeSingle();
    setClientName((c as { name: string } | null)?.name ?? "Client");

    const { data: tr } = await supabase
      .from("tax_returns")
      .select("*")
      .eq("client_id", clientId);
    const rm: Record<number, Record<string, unknown>> = {};
    for (const r of tr || []) {
      rm[r.tax_year as number] = r as Record<string, unknown>;
    }
    setReturnsMap(rm);

    const { data: docs } = await supabase
      .from("documents")
      .select("tax_year")
      .eq("client_id", clientId)
      .eq("is_deleted", false)
      .not("tax_year", "is", null);
    const dc: Record<number, number> = {};
    for (const d of docs || []) {
      const y = d.tax_year as number | null;
      if (y != null) dc[y] = (dc[y] ?? 0) + 1;
    }
    setDocCounts(dc);
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const years = useMemo(() => {
    const fromReturns = Object.keys(returnsMap).map(Number);
    const fromDocs = Object.keys(docCounts).map(Number);
    const set = new Set([...DEFAULT_YEARS, ...fromReturns, ...fromDocs, ...extras]);
    return Array.from(set).filter((y) => Number.isFinite(y)).sort((a, b) => b - a);
  }, [returnsMap, docCounts, extras]);

  function addExtraYear() {
    const y = parseInt(extraYear, 10);
    if (!Number.isFinite(y) || y < 2000 || y > 2100) return;
    setExtras((e) => (e.includes(y) ? e : [...e, y]));
    setExtraYear("");
    setExtraOpen(false);
  }

  if (!session) {
    return <p className="text-muted-foreground">Sign in to continue.</p>;
  }

  if (!clientId) return null;

  return (
    <div className="space-y-8">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2 mb-4" asChild>
          <Link to="/clients">
            <ArrowLeft className="mr-2 h-4 w-4" />
            All clients
          </Link>
        </Button>
        <h1 className="text-3xl font-semibold tracking-tight">{clientName}</h1>
        <p className="mt-1 text-muted-foreground">Open a tax year to upload documents and run the return.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Dialog open={extraOpen} onOpenChange={setExtraOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              <CalendarPlus className="mr-2 h-4 w-4" />
              Add tax year
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add another year</DialogTitle>
            </DialogHeader>
            <div className="grid gap-2 py-2">
              <Label htmlFor="yr">Tax year</Label>
              <Input
                id="yr"
                type="number"
                value={extraYear}
                onChange={(e) => setExtraYear(e.target.value)}
                placeholder="2021"
              />
            </div>
            <DialogFooter>
              <Button type="button" onClick={addExtraYear}>
                Add
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {years.map((year) => {
          const row = returnsMap[year] ?? null;
          const dc = docCounts[year] ?? 0;
          const st = displayStatus(
            row ? { status: row.status as string | null } : null,
            dc,
          );
          const agi = row?.agi != null ? Number(row.agi) : null;
          return (
            <Link key={year} to={`/clients/${clientId}/${year}`}>
              <Card className="h-full transition-colors hover:border-primary/40 hover:bg-muted/30">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-xl">{year}</CardTitle>
                    <Badge variant={st.variant}>{st.label}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-1 text-sm text-muted-foreground">
                  <p>Documents: {dc}</p>
                  <p>AGI: {agi != null ? `$${agi.toLocaleString()}` : "—"}</p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

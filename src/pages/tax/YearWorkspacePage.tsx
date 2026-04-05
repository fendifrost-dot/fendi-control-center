import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { invokeTaxEdge, sha256Hex } from "@/lib/taxEdge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Session } from "@supabase/supabase-js";
import { ArrowLeft, FileText, Loader2, Trash2, Upload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Database } from "@/integrations/supabase/types";
import { ReturnReviewPanel } from "@/components/tax/ReturnReviewPanel";

type DocRow = Database["public"]["Tables"]["documents"]["Row"];

export default function YearWorkspacePage() {
  const { clientId, year: yearParam } = useParams<{ clientId: string; year: string }>();
  const year = yearParam ? parseInt(yearParam, 10) : NaN;
  const { toast } = useToast();

  const [session, setSession] = useState<Session | null>(null);
  const [clientName, setClientName] = useState("");
  const [taxReturnId, setTaxReturnId] = useState<string | null>(null);
  const [taxRow, setTaxRow] = useState<Record<string, unknown> | null>(null);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [analyzedJson, setAnalyzedJson] = useState("{}");
  const [settingsJson, setSettingsJson] = useState("{}");
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [savingAnalysis, setSavingAnalysis] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [lastGenerate, setLastGenerate] = useState<Record<string, unknown> | null>(null);
  const [formRows, setFormRows] = useState<
    { id: string; form_type: string; pdf_url: string | null }[]
  >([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const loadDocs = useCallback(async () => {
    if (!clientId || !Number.isFinite(year)) return;
    const { data } = await supabase
      .from("documents")
      .select("*")
      .eq("client_id", clientId)
      .eq("is_deleted", false)
      .order("created_at", { ascending: false });
    // Filter by year client-side since tax_year may not be in schema
    const filtered = (data ?? []).filter((d: any) => (d as any).tax_year === year);
    setDocs(filtered as unknown as DocRow[]);
  }, [clientId, year]);

  const loadTaxReturn = useCallback(async () => {
    if (!clientId || !Number.isFinite(year)) return;
    const { data: c } = await supabase.from("clients").select("name").eq("id", clientId).maybeSingle();
    const name = (c as { name: string } | null)?.name ?? "Client";
    setClientName(name);

    let { data: tr } = await supabase
      .from("tax_returns")
      .select("*")
      .eq("client_id", clientId)
      .eq("tax_year", year)
      .maybeSingle();

    if (!tr) {
      const ins = await supabase
        .from("tax_returns")
        .insert({
          client_id: clientId,
          client_name: name,
          tax_year: year,
          status: "gathering_docs",
        })
        .select("*")
        .single();
      tr = ins.data;
    }

    if (!tr) return;

    setTaxReturnId(tr.id as string);
    setTaxRow(tr as unknown as Record<string, unknown>);
    setAnalyzedJson(JSON.stringify((tr as any).analyzed_data ?? {}, null, 2));
    setSettingsJson(JSON.stringify((tr as any).workspace_settings ?? {}, null, 2));

    const { data: forms } = await supabase
      .from("tax_form_instances")
      .select("id,form_type,pdf_url")
      .eq("tax_return_id", tr.id);
    setFormRows((forms as typeof formRows) ?? []);
  }, [clientId, year]);

  const refreshAll = useCallback(async () => {
    await loadTaxReturn();
    await loadDocs();
  }, [loadTaxReturn, loadDocs]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  async function onUploadFiles(files: FileList | null) {
    if (!files?.length || !clientId || !Number.isFinite(year)) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const hash = await sha256Hex(file);
        const path = `${clientId}/${year}/${crypto.randomUUID()}_${file.name.replace(/[^\w.\-]+/g, "_")}`;
        const { error: upErr } = await supabase.storage.from("tax-source-documents").upload(path, file, {
          cacheControl: "3600",
          upsert: false,
        });
        if (upErr) throw upErr;

        const { error: insErr } = await supabase.from("documents").insert({
          client_id: clientId,
          file_name: file.name,
          mime_type: file.type || "application/octet-stream",
          original_mime_type: file.type || "application/octet-stream",
          processed_mime_type: file.type || "application/pdf",
          sha256: hash,
          drive_file_id: path,
          drive_modified_time: new Date().toISOString(),
          status: "pending",
        } as any);
        if (insErr) throw insErr;
      }
      toast({ title: "Upload complete" });
      await loadDocs();
    } catch (e) {
      toast({
        title: "Upload failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  }

  async function previewDoc(path: string) {
    const { data, error } = await supabase.storage
      .from("tax-source-documents")
      .createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) {
      toast({ title: "Could not preview", variant: "destructive" });
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function deleteDoc(d: DocRow) {
    if (!d.storage_object_path) return;
    if (!window.confirm(`Remove ${d.file_name}?`)) return;
    await supabase.storage.from("tax-source-documents").remove([d.storage_object_path]);
    await supabase.from("documents").delete().eq("id", d.id);
    toast({ title: "Document removed" });
    await loadDocs();
  }

  async function analyzeAll() {
    if (!clientId || !Number.isFinite(year)) return;
    setAnalyzing(true);
    try {
      await invokeTaxEdge("ingest-tax-documents", {
        analyze_storage_uploads: true,
        client_id: clientId,
        client_name: clientName,
        tax_year: year,
      });
      toast({ title: "Analysis complete", description: "Review the Analyzed data tab." });
      await loadTaxReturn();
      await loadDocs();
    } catch (e) {
      toast({
        title: "Analysis failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setAnalyzing(false);
    }
  }

  async function saveAnalyzed() {
    if (!taxReturnId) return;
    setSavingAnalysis(true);
    try {
      const parsed = JSON.parse(analyzedJson) as Record<string, unknown>;
      const { error } = await supabase
        .from("tax_returns")
        .update({ analyzed_data: parsed, updated_at: new Date().toISOString() })
        .eq("id", taxReturnId);
      if (error) throw error;
      toast({ title: "Analysis saved" });
      await loadTaxReturn();
    } catch (e) {
      toast({
        title: "Invalid JSON or save failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSavingAnalysis(false);
    }
  }

  async function saveSettings() {
    if (!taxReturnId) return;
    setSavingSettings(true);
    try {
      const parsed = JSON.parse(settingsJson) as Record<string, unknown>;
      const { error } = await supabase
        .from("tax_returns")
        .update({ workspace_settings: parsed, updated_at: new Date().toISOString() })
        .eq("id", taxReturnId);
      if (error) throw error;
      toast({ title: "Settings saved" });
    } catch (e) {
      toast({
        title: "Invalid JSON or save failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSavingSettings(false);
    }
  }

  async function generateReturn() {
    if (!clientId || !Number.isFinite(year)) return;
    setGenerating(true);
    setLastGenerate(null);
    try {
      const res = await invokeTaxEdge<Record<string, unknown>>("generate-tax-documents", {
        tax_years: [year],
        client_id: clientId,
        client_name: clientName,
      });
      setLastGenerate(res);
      toast({ title: "Return generated" });
      await loadTaxReturn();
    } catch (e) {
      toast({
        title: "Generation failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setGenerating(false);
    }
  }

  const plSummary = (() => {
    try {
      const a = JSON.parse(analyzedJson) as { pl_summary?: Record<string, unknown> };
      return a.pl_summary ?? null;
    } catch {
      return null;
    }
  })();

  if (!session) {
    return <p className="text-muted-foreground">Sign in to continue.</p>;
  }

  if (!clientId || !Number.isFinite(year)) {
    return <p className="text-destructive">Invalid year.</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2 mb-2" asChild>
          <Link to={`/clients/${clientId}`}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {clientName} — all years
          </Link>
        </Button>
        <h1 className="text-3xl font-semibold tracking-tight">
          {clientName} · {year}
        </h1>
        <p className="mt-1 text-muted-foreground">Documents, analysis, return, and settings for this year.</p>
      </div>

      <Tabs defaultValue="documents" className="w-full">
        <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start gap-1 bg-muted/50 p-1">
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="analysis">Analyzed data</TabsTrigger>
          <TabsTrigger value="return">Tax return</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="documents" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Upload</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-border bg-muted/20 px-6 py-10 transition-colors hover:bg-muted/40">
                <Upload className="mb-2 h-8 w-8 text-muted-foreground" />
                <span className="text-sm font-medium">Drop files here or click to browse</span>
                <span className="mt-1 text-xs text-muted-foreground">PDF, images — W-2, 1099, receipts</span>
                <input
                  type="file"
                  multiple
                  className="hidden"
                  accept=".pdf,image/*"
                  disabled={uploading}
                  onChange={(e) => void onUploadFiles(e.target.files)}
                />
              </label>
              {uploading && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Uploading…
                </p>
              )}
              <Button type="button" disabled={analyzing || docs.length === 0} onClick={() => void analyzeAll()}>
                {analyzing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analyzing…
                  </>
                ) : (
                  "Analyze all"
                )}
              </Button>
              <p className="text-xs text-muted-foreground">
                Analysis runs OCR and extraction on every uploaded file for this year.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Your documents</CardTitle>
            </CardHeader>
            <CardContent>
              {docs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No uploads yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {docs.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{d.file_name}</p>
                        <p className="text-muted-foreground">
                          {d.doc_type || "Type pending"} ·{" "}
                          {d.created_at ? new Date(d.created_at).toLocaleString() : "—"}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {d.storage_object_path && (
                          <Button type="button" variant="outline" size="sm" onClick={() => void previewDoc(d.storage_object_path!)}>
                            <FileText className="mr-1 h-4 w-4" />
                            Preview
                          </Button>
                        )}
                        <Button type="button" variant="ghost" size="icon" onClick={() => void deleteDoc(d)} aria-label="Delete">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="analysis" className="space-y-4">
          {plSummary && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">P&amp;L summary</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2 text-sm sm:grid-cols-3">
                <div>
                  <p className="text-muted-foreground">Total income</p>
                  <p className="text-lg font-semibold">
                    ${Number(plSummary.total_income ?? 0).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Total expenses</p>
                  <p className="text-lg font-semibold">
                    ${Number(plSummary.total_expenses ?? 0).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Net</p>
                  <p className="text-lg font-semibold">
                    ${Number(plSummary.net_income ?? 0).toLocaleString()}
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Edit analyzed data</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                JSON from the last analysis. Adjust numbers if needed, then save.
              </p>
              <Textarea value={analyzedJson} onChange={(e) => setAnalyzedJson(e.target.value)} rows={16} className="font-mono text-xs" />
              <Button type="button" onClick={() => void saveAnalyzed()} disabled={savingAnalysis}>
                {savingAnalysis ? "Saving…" : "Save changes"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="return" className="space-y-4">
          <ReturnReviewPanel
            taxReturnId={taxReturnId}
            clientId={clientId}
            clientName={clientName}
            year={year}
            taxRow={taxRow}
            worksheet={taxRow?.worksheet != null ? String(taxRow.worksheet) : null}
            formRows={formRows}
            generating={generating}
            lastGenerate={lastGenerate}
            onGenerate={() => void generateReturn()}
            onRefresh={refreshAll}
          />
        </TabsContent>

        <TabsContent value="settings" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Year settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Store filing status, dependents count, and state as JSON for this tax year.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Filing status (quick)</Label>
                  <Select
                    onValueChange={(v) => {
                      try {
                        const cur = JSON.parse(settingsJson) as Record<string, unknown>;
                        setSettingsJson(JSON.stringify({ ...cur, filing_status: v }, null, 2));
                      } catch {
                        setSettingsJson(JSON.stringify({ filing_status: v }, null, 2));
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Set in JSON or pick…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="single">Single</SelectItem>
                      <SelectItem value="married_joint">Married filing jointly</SelectItem>
                      <SelectItem value="married_separate">Married filing separately</SelectItem>
                      <SelectItem value="head_of_household">Head of household</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Textarea value={settingsJson} onChange={(e) => setSettingsJson(e.target.value)} rows={12} className="font-mono text-xs" />
              <Button type="button" onClick={() => void saveSettings()} disabled={savingSettings}>
                {savingSettings ? "Saving…" : "Save settings"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

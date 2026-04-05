import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { invokeTaxEdge } from "@/lib/taxEdge";
import {
  parseJsonSummary,
  validateTaxSummary,
  summaryToRowPatch,
  type TaxJsonSummary,
} from "@/lib/taxReturnModel";
import { generateTxfFromJsonSummary } from "@/lib/taxTxfExport";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, AlertTriangle, FileDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Database, Json } from "@/integrations/supabase/types";

type FormRow = { id: string; form_type: string; pdf_url: string | null };
type TaxReturnUpdate = Database["public"]["Tables"]["tax_returns"]["Update"];

function num(v: string): number | undefined {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

export type ReturnReviewPanelProps = {
  taxReturnId: string | null;
  clientId: string;
  clientName: string;
  year: number;
  taxRow: Record<string, unknown> | null;
  worksheet: string | null | undefined;
  formRows: FormRow[];
  generating: boolean;
  lastGenerate: Record<string, unknown> | null;
  onGenerate: () => void;
  onRefresh: () => Promise<void>;
};

export function ReturnReviewPanel({
  taxReturnId,
  clientId,
  clientName,
  year,
  taxRow,
  worksheet,
  formRows,
  generating,
  lastGenerate,
  onGenerate,
  onRefresh,
}: ReturnReviewPanelProps) {
  const { toast } = useToast();
  const [summary, setSummary] = useState<TaxJsonSummary>({});
  const [filingRec, setFilingRec] = useState<Record<string, unknown>>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const s = parseJsonSummary(taxRow?.json_summary);
    const fr = (taxRow?.filing_recommendation as Record<string, unknown>) || {};
    setSummary(JSON.parse(JSON.stringify(s)) as TaxJsonSummary);
    setFilingRec({ ...fr });
    setWarnings([]);
  }, [taxRow?.json_summary, taxRow?.filing_recommendation, taxRow?.updated_at]);

  const f = summary.form_1040 || {};
  const c = summary.schedule_c || {};
  const se = summary.schedule_se || {};
  const readiness = summary.filing_readiness || {};

  const setF = useCallback((patch: Partial<typeof f>) => {
    setSummary((prev) => ({
      ...prev,
      form_1040: { ...(prev.form_1040 || {}), ...patch },
    }));
  }, []);

  const setC = useCallback((patch: Partial<typeof c>) => {
    setSummary((prev) => ({
      ...prev,
      schedule_c: { ...(prev.schedule_c || {}), ...patch },
    }));
  }, []);

  const setSe = useCallback((patch: Partial<typeof se>) => {
    setSummary((prev) => ({
      ...prev,
      schedule_se: { ...(prev.schedule_se || {}), ...patch },
    }));
  }, []);

  const setReadiness = useCallback((patch: Partial<typeof readiness>) => {
    setSummary((prev) => ({
      ...prev,
      filing_readiness: { ...(prev.filing_readiness || {}), ...patch },
    }));
  }, []);

  async function resolvePdfUrl(path: string): Promise<string | null> {
    if (path.startsWith("http")) return path;
    const { data, error } = await supabase.storage.from("tax-documents").createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const row of formRows) {
        if (!row.pdf_url) continue;
        const u = await resolvePdfUrl(row.pdf_url);
        if (u) next[row.id] = u;
      }
      if (!cancelled) setSignedUrls(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [formRows]);

  async function saveDraft() {
    if (!taxReturnId) return;
    setSaving(true);
    try {
      const raw = summaryToRowPatch(summary, filingRec);
      const patch: TaxReturnUpdate = {
        ...raw,
        json_summary: raw.json_summary as Json,
        filing_recommendation: raw.filing_recommendation as Json,
      };
      const { error } = await supabase.from("tax_returns").update(patch).eq("id", taxReturnId);
      if (error) throw error;
      toast({ title: "Return saved" });
      await onRefresh();
    } catch (e) {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  function runChecks() {
    const w = validateTaxSummary(summary);
    setSummary((prev) => ({
      ...prev,
      _review_meta: { warnings: w, validated_at: new Date().toISOString() },
    }));
    setWarnings(w);
    if (w.length === 0) toast({ title: "Checks passed", description: "No obvious inconsistencies flagged." });
    else toast({ title: "Review suggested", description: `${w.length} item(s) flagged.`, variant: "destructive" });
  }

  async function exportPdfs() {
    if (!taxReturnId) return;
    setExporting(true);
    try {
      await saveDraft();
      await invokeTaxEdge("fill-tax-forms", {
        tax_return_id: taxReturnId,
        tax_year: year,
        client_name: clientName,
        client_id: clientId,
        computed_data: summary,
      });
      toast({ title: "IRS PDFs generated", description: "Draft PDFs uploaded to storage and Drive when configured." });
      await onRefresh();
    } catch (e) {
      toast({
        title: "PDF export failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  }

  function downloadTxf() {
    const content = generateTxfFromJsonSummary(clientName, year, summary);
    const blob = new Blob([content], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${clientName.replace(/\s+/g, "_")}_${year}_1040.txf`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast({ title: "TXF downloaded" });
  }

  function downloadWorksheet() {
    if (!worksheet?.trim()) {
      toast({ title: "No worksheet yet", description: "Generate the return first.", variant: "destructive" });
      return;
    }
    const blob = new Blob([worksheet], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `worksheet-${year}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const recSteps = Array.isArray(filingRec.steps)
    ? (filingRec.steps as string[]).join("\n")
    : typeof filingRec.steps === "string"
      ? filingRec.steps
      : "";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-lg">1. Generate with AI</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Pulls Drive + analyzed data, then opens the review form below (Option C).
            </p>
          </div>
          <Button type="button" disabled={generating} onClick={onGenerate}>
            {generating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating…
              </>
            ) : (
              "Generate return"
            )}
          </Button>
        </CardHeader>
        {lastGenerate?.results && (
          <CardContent>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Last run (raw)</summary>
              <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2">
                {JSON.stringify(lastGenerate.results, null, 2)}
              </pre>
            </details>
          </CardContent>
        )}
      </Card>

      {!taxReturnId ? (
        <p className="text-sm text-muted-foreground">Loading return…</p>
      ) : (
        <>
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Review before export</AlertTitle>
            <AlertDescription>
              Edit values to match source documents. Save, run checks, then export IRS draft PDFs and TXF.
            </AlertDescription>
          </Alert>

          {(warnings.length > 0 || (summary._review_meta?.warnings?.length ?? 0) > 0) && (
            <Alert variant="destructive">
              <AlertTitle>Flags</AlertTitle>
              <AlertDescription>
                <ul className="list-inside list-disc text-sm">
                  {(warnings.length ? warnings : summary._review_meta?.warnings || []).map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Form 1040 (summary)</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label>Name</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    placeholder="First"
                    value={f.first_name ?? ""}
                    onChange={(e) => setF({ first_name: e.target.value })}
                  />
                  <Input
                    placeholder="Last"
                    value={f.last_name ?? ""}
                    onChange={(e) => setF({ last_name: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Filing status</Label>
                <Input
                  value={f.filing_status ?? ""}
                  onChange={(e) => setF({ filing_status: e.target.value })}
                  placeholder="single, married_joint, …"
                />
              </div>
              {[
                ["Wages (Line 1)", "wages"],
                ["Taxable interest (2b)", "taxable_interest"],
                ["Ordinary dividends (3b)", "ordinary_dividends"],
                ["Total income (9)", "total_income"],
                ["AGI (11)", "adjusted_gross_income"],
                ["Standard deduction (12)", "standard_deduction"],
                ["Taxable income (15)", "taxable_income"],
                ["Total tax (24)", "total_tax"],
                ["Total payments (33)", "total_payments"],
                ["Refund / owed (34 / 37)", "amount_owed_or_refund"],
              ].map(([label, key]) => (
                <div key={key} className="space-y-2">
                  <Label>{label}</Label>
                  <Input
                    type="number"
                    value={f[key as keyof typeof f] ?? ""}
                    onChange={(e) => setF({ [key]: num(e.target.value) } as Partial<typeof f>)}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Schedule C (if applicable)</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label>Business name</Label>
                <Input value={c.business_name ?? ""} onChange={(e) => setC({ business_name: e.target.value })} />
              </div>
              {[
                ["Gross receipts", "gross_receipts"],
                ["Total expenses", "total_expenses"],
                ["Net profit", "net_profit"],
              ].map(([label, key]) => (
                <div key={key} className="space-y-2">
                  <Label>{label}</Label>
                  <Input
                    type="number"
                    value={c[key as keyof typeof c] ?? ""}
                    onChange={(e) => setC({ [key]: num(e.target.value) } as Partial<typeof c>)}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Schedule SE (if applicable)</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              {[
                ["Net earnings", "net_earnings"],
                ["SE tax", "se_tax"],
                ["Deductible half", "deductible_half"],
              ].map(([label, key]) => (
                <div key={key} className="space-y-2">
                  <Label>{label}</Label>
                  <Input
                    type="number"
                    value={se[key as keyof typeof se] ?? ""}
                    onChange={(e) => setSe({ [key]: num(e.target.value) } as Partial<typeof se>)}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Filing readiness</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Score (0–100)</Label>
                  <Input
                    type="number"
                    value={readiness.score ?? ""}
                    onChange={(e) => setReadiness({ score: num(e.target.value) })}
                  />
                </div>
                <div className="space-y-2 flex items-end">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!!readiness.ready_to_file}
                      onChange={(e) => setReadiness({ ready_to_file: e.target.checked })}
                    />
                    Ready to file
                  </label>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Missing items (one per line)</Label>
                <Textarea
                  rows={3}
                  value={(readiness.missing_items || []).join("\n")}
                  onChange={(e) =>
                    setReadiness({
                      missing_items: e.target.value
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Filing recommendation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Method (TurboTax / mail / Free File …)</Label>
                <Input
                  value={typeof filingRec.method === "string" ? filingRec.method : ""}
                  onChange={(e) => setFilingRec((r) => ({ ...r, method: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Next steps (one per line)</Label>
                <Textarea
                  rows={4}
                  value={recSteps}
                  onChange={(e) =>
                    setFilingRec((r) => ({
                      ...r,
                      steps: e.target.value
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    }))
                  }
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" disabled={saving} onClick={() => void saveDraft()}>
              {saving ? "Saving…" : "Save draft"}
            </Button>
            <Button type="button" variant="outline" onClick={runChecks}>
              Run checks
            </Button>
            <Button type="button" disabled={exporting} onClick={() => void exportPdfs()}>
              {exporting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Exporting…
                </>
              ) : (
                "Export IRS PDFs"
              )}
            </Button>
            <Button type="button" variant="outline" onClick={downloadTxf}>
              <FileDown className="mr-2 h-4 w-4" />
              Download TXF
            </Button>
            <Button type="button" variant="outline" onClick={downloadWorksheet}>
              Download worksheet
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Filled forms</CardTitle>
            </CardHeader>
            <CardContent>
              {formRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">Export IRS PDFs to generate draft forms.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {formRows.map((row) => (
                    <li key={row.id}>
                      {signedUrls[row.id] ? (
                        <a href={signedUrls[row.id]} className="text-primary underline" target="_blank" rel="noreferrer">
                          {row.form_type} PDF
                        </a>
                      ) : (
                        <span className="text-muted-foreground">{row.form_type} (preparing link…)</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

import { useState } from "react";
import { ClientProfileInput, type ClientProfile } from "@/components/ClientProfileInput";
import { AssessmentResults } from "@/components/AssessmentResults";
import { useAssessment } from "@/hooks/useAssessment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";

const PAGE_PASSWORD = "fendi2026";

export default function Test() {
  const [unlocked, setUnlocked] = useState(false);
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState(false);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [clientProfile, setClientProfile] = useState<ClientProfile | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [rawResult, setRawResult] = useState<any>(null);
  const { assessment, runAssessment, resetAssessment } = useAssessment();

  // Password gate
  if (!unlocked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-lg">Private Test Page</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              type="password"
              placeholder="Password"
              value={pwInput}
              onChange={(e) => setPwInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (pwInput === PAGE_PASSWORD) {
                    setUnlocked(true);
                  } else {
                    setPwError(true);
                  }
                }
              }}
            />
            {pwError && (
              <p className="text-sm text-destructive">Incorrect password</p>
            )}
            <Button
              className="w-full"
              onClick={() => {
                if (pwInput === PAGE_PASSWORD) {
                  setUnlocked(true);
                } else {
                  setPwError(true);
                }
              }}
            >
              Enter
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleAnalyze = async () => {
    if (!pdfFile) return;
    setAnalyzing(true);
    setAnalysisError(null);
    setRawResult(null);
    resetAssessment();

    try {
      // Convert PDF to base64
      const arrayBuffer = await pdfFile.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      bytes.forEach((b) => (binary += String.fromCharCode(b)));
      const base64 = btoa(binary);

      // Call process-document edge function directly
      const { data, error } = await supabase.functions.invoke(
        "process-document",
        {
          body: {
            file_base64: base64,
            file_name: pdfFile.name,
            mime_type: "application/pdf",
            source: "manual_test",
          },
        }
      );

      if (error) throw new Error(error.message);
      setRawResult(data);

      // Map Gemini output to assessment input
      if (clientProfile && data) {
        const tradelines = (data.tradelines ?? []).map((t: any) => ({
          accountName: t.fields?.creditor_name ?? "",
          accountNumber: t.fields?.account_number ?? null,
          dateOpened: t.fields?.date_opened ?? "",
          balance: t.fields?.balance ?? "",
          statusText: t.fields?.status ?? "",
          remarks: t.fields?.remarks ?? "",
          openClosed:
            t.fields?.status?.toLowerCase().includes("closed")
              ? "Closed"
              : "Open",
          paymentFlag: t.payment_flag ?? "UNREADABLE",
          negativeCells: t.negative_cells ?? [],
          lateCount: t.late_count ?? 0,
          worstStatus: t.worst_status ?? "NONE",
          fullTextBlock: t.evidence ?? "",
          allowedScanZoneText: [
            t.fields?.status ?? "",
            t.fields?.payment_status ?? "",
            t.fields?.remarks ?? "",
          ].join(" "),
          isNegative: false,
          isCollection:
            t.fields?.account_type
              ?.toLowerCase()
              .includes("collection") ?? false,
          collectionAgency: t.fields?.collection_agency ?? undefined,
          originalCreditor: t.fields?.original_creditor ?? undefined,
          bureauSource: (data.bureau?.toUpperCase() ?? "UNKNOWN") as any,
        }));

        const inquiries = (data.inquiries ?? []).map((inq: any) => ({
          creditor: inq.fields?.creditor_name ?? "",
          date: inq.fields?.inquiry_date ?? "",
          inquiryType:
            inq.fields?.inquiry_type?.toUpperCase() === "SOFT"
              ? "SOFT"
              : inq.fields?.inquiry_type?.toUpperCase() === "HARD"
              ? "HARD"
              : "UNKNOWN",
        }));

        const personalInfo = data.personal_info ?? [];
        const bureauNames = personalInfo
          .filter((p: any) => p.field_name === "full_name")
          .map((p: any) => p.value);
        const bureauAddresses = personalInfo
          .filter((p: any) => p.field_name === "address")
          .map((p: any) => p.value);
        const bureauEmployers = personalInfo
          .filter((p: any) => p.field_name === "employer")
          .map((p: any) => p.value);

        runAssessment(clientProfile, {
          bureau: data.bureau?.toUpperCase() ?? "UNKNOWN",
          reportDate: data.report_date ?? "",
          consumerName:
            bureauNames[0] ?? clientProfile.fullLegalName,
          accountsEverLate: data.accounts_ever_late ?? 0,
          collectionsCount: data.collections_count ?? 0,
          publicRecordsCount: data.public_records_count ?? 0,
          hardInquiriesCount: data.hard_inquiries_count ?? 0,
          bureauNames,
          bureauAddresses,
          bureauEmployers,
          inquiries,
          tradelines,
        });
      }
    } catch (e: any) {
      setAnalysisError(e.message ?? "Unknown error");
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground p-6 max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Credit Assessment — Test</h1>
        <p className="text-sm text-muted-foreground">Private. Not linked.</p>
      </div>

      {/* Step 1 — Client Profile */}
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Step 1 — Client Profile</h2>
        <ClientProfileInput
          onProfileSubmit={(profile) => {
            setClientProfile(profile);
            resetAssessment();
          }}
          isLocked={!!clientProfile}
        />
        {clientProfile && (
          <button
            onClick={() => {
              setClientProfile(null);
              resetAssessment();
            }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Reset profile
          </button>
        )}
      </div>

      {/* Step 2 — Upload PDF */}
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Step 2 — Upload Credit Report PDF</h2>
        <Card>
          <CardContent className="pt-6 space-y-4">
            <Input
              type="file"
              accept=".pdf"
              onChange={(e) => {
                setPdfFile(e.target.files?.[0] ?? null);
                setRawResult(null);
                resetAssessment();
              }}
            />
            {pdfFile && (
              <p className="text-sm text-muted-foreground">
                Selected: {pdfFile.name} ({(pdfFile.size / 1024).toFixed(1)} KB)
              </p>
            )}
            <Button
              onClick={handleAnalyze}
              disabled={!pdfFile || !clientProfile || analyzing}
            >
              {analyzing ? "Analyzing..." : "Run Analysis + Assessment"}
            </Button>
            {!clientProfile && (
              <p className="text-xs text-muted-foreground">Complete Step 1 first</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Error */}
      {analysisError && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">Error: {analysisError}</p>
          </CardContent>
        </Card>
      )}

      {/* Raw Gemini Output (debug) */}
      {rawResult && (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Raw Gemini Output (debug)
          </summary>
          <pre className="mt-2 text-xs bg-muted p-4 rounded overflow-auto max-h-96">
            {JSON.stringify(rawResult, null, 2)}
          </pre>
        </details>
      )}

      {/* Step 3 — Assessment Results */}
      {assessment && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Step 3 — Assessment Results</h2>
          <AssessmentResults assessment={assessment} />
        </div>
      )}
    </div>
  );
}

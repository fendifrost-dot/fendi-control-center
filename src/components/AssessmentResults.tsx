import type { CreditAssessment } from "@/types/assessment";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Props = {
  assessment: CreditAssessment;
};

export function AssessmentResults({ assessment }: Props) {
  const {
    personalInfoFlags,
    inquiryFlags,
    negativeAccountFlags,
    assessmentSummary,
    validationWarnings,
    tradelineInventory,
    reportMetadata,
  } = assessment;

  return (
    <div className="space-y-6">

      {/* Report Source Badge */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Bureau source:</span>
        <Badge variant="outline">
          {reportMetadata.bureau}
        </Badge>
      </div>

      {/* Validation Warnings */}
      {validationWarnings.length > 0 && (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive text-base">
              ⚠ Validation Warnings
            </CardTitle>
          </CardHeader>
          <CardContent>
            {validationWarnings.map((w, i) => (
              <p key={i} className="text-sm text-destructive">{w}</p>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Assessment Summary */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Assessment Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <SummaryTile label="Personal Info" value={assessmentSummary.personalInfoFlagged} />
          <SummaryTile label="Inquiries" value={assessmentSummary.inquiriesFlagged} />
          <SummaryTile label="Negative Accts" value={assessmentSummary.negativeAccountsFlagged} />
          <SummaryTile label="Collections" value={assessmentSummary.collectionsFlagged} />
          <SummaryTile label="Total Flagged" value={assessmentSummary.totalFlagged} highlight />
        </CardContent>
      </Card>

      {/* Personal Info Flags */}
      {personalInfoFlags.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Personal Information Flags
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 pr-4">Type</th>
                    <th className="text-left py-2 pr-4">Bureau Value</th>
                    <th className="text-left py-2 pr-4">Client Value</th>
                    <th className="text-left py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {personalInfoFlags.map((f, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 pr-4">{f.type}</td>
                      <td className="py-2 pr-4">{f.bureauValue}</td>
                      <td className="py-2 pr-4">{f.clientValue}</td>
                      <td className="py-2">
                        <Badge variant="destructive">
                          REMOVE
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Inquiry Flags — Hard only */}
      {inquiryFlags.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Hard Inquiry Flags — {inquiryFlags.length} flagged
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 pr-4">Creditor</th>
                    <th className="text-left py-2 pr-4">Date</th>
                    <th className="text-left py-2 pr-4">Type</th>
                    <th className="text-left py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {inquiryFlags.map((inq, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 pr-4">{inq.creditor}</td>
                      <td className="py-2 pr-4">{inq.date}</td>
                      <td className="py-2 pr-4">
                        <Badge variant="outline">
                          {inq.inquiryType}
                        </Badge>
                      </td>
                      <td className="py-2">
                        <Badge variant="destructive">
                          FLAG
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Negative Account Flags */}
      {negativeAccountFlags.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Negative Account Flags — {negativeAccountFlags.length} flagged
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 pr-4">Account</th>
                    <th className="text-left py-2 pr-4">Account #</th>
                    <th className="text-left py-2 pr-4">Opened</th>
                    <th className="text-left py-2 pr-4">Amount</th>
                    <th className="text-left py-2 pr-4">Status</th>
                    <th className="text-left py-2 pr-4">Open/Closed</th>
                    <th className="text-left py-2 pr-4">Source</th>
                    <th className="text-left py-2">Flag</th>
                  </tr>
                </thead>
                <tbody>
                  {negativeAccountFlags.map((acct, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 pr-4">
                        {acct.isCollection && (
                          <span className="text-destructive font-bold">[COL]</span>
                        )}
                        {acct.accountName}
                        {acct.originalCreditor && (
                          <p className="text-xs text-muted-foreground">
                            Orig: {acct.originalCreditor}
                          </p>
                        )}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        {acct.accountNumber ?? "—"}
                      </td>
                      <td className="py-2 pr-4">{acct.dateOpened}</td>
                      <td className="py-2 pr-4">{acct.amount}</td>
                      <td className="py-2 pr-4 text-destructive">
                        {acct.statusText}
                      </td>
                      <td className="py-2 pr-4">{acct.openOrClosed}</td>
                      <td className="py-2 pr-4">
                        <Badge variant="outline">
                          {acct.bureauSource}
                        </Badge>
                      </td>
                      <td className="py-2">
                        <Badge variant="destructive">
                          FLAGGED
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tradeline Inventory Footer */}
      <Card>
        <CardContent className="pt-6">
          <p className="text-xs text-muted-foreground">
            Blocks detected: {tradelineInventory.totalDetected} |
            Negative: {tradelineInventory.negativeCount} |
            Collections: {tradelineInventory.collectionCount} |
            Reconciled: {tradelineInventory.reconciled ? "YES" : "NO"}
          </p>
        </CardContent>
      </Card>

    </div>
  );
}

function SummaryTile({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div className="text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold ${highlight ? "text-destructive" : "text-foreground"}`}>
        {value}
      </p>
    </div>
  );
}

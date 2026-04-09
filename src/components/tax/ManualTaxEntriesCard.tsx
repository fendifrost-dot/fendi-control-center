import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import type { Json } from "@/integrations/supabase/types";
import { Trash2 } from "lucide-react";

const INCOME_CATEGORIES = [
  { value: "cash", label: "Cash" },
  { value: "side_job", label: "Side job" },
  { value: "freelance", label: "Freelance" },
  { value: "tips", label: "Tips" },
  { value: "rental_cash", label: "Rental cash" },
  { value: "other", label: "Other" },
] as const;

const DEDUCTION_CATEGORIES = [
  { value: "advertising_marketing", label: "Advertising / marketing" },
  { value: "car_truck_expenses", label: "Car & truck (mileage below)" },
  { value: "contract_labor", label: "Contract labor" },
  { value: "depreciation", label: "Depreciation" },
  { value: "insurance_business", label: "Insurance (business)" },
  { value: "interest_mortgage_business", label: "Interest — mortgage (business)" },
  { value: "interest_other_business", label: "Interest — other (business)" },
  { value: "legal_professional", label: "Legal & professional" },
  { value: "office_expense", label: "Office expense" },
  { value: "rent_lease_business", label: "Rent / lease (business)" },
  { value: "repairs_maintenance", label: "Repairs & maintenance" },
  { value: "supplies", label: "Supplies" },
  { value: "taxes_licenses", label: "Taxes & licenses" },
  { value: "travel", label: "Travel" },
  { value: "meals", label: "Meals (50% deductible)" },
  { value: "utilities", label: "Utilities" },
  { value: "wages", label: "Wages" },
  { value: "other_business_expense", label: "Other business" },
  { value: "medical_dental", label: "Medical / dental" },
  { value: "state_local_taxes", label: "State & local (SALT)" },
  { value: "mortgage_interest", label: "Mortgage interest" },
  { value: "charitable_cash", label: "Charitable (cash)" },
  { value: "charitable_noncash", label: "Charitable (non-cash)" },
  { value: "student_loan_interest", label: "Student loan interest" },
  { value: "health_insurance_self_employed", label: "Health insurance (SE)" },
  { value: "home_office", label: "Home office (simplified)" },
  { value: "education_expenses", label: "Education" },
] as const;

type ManualIn = { id: string; amount: number; category: string; description?: string };
type ManualDed = { id: string; amount: number; category: string; description?: string; miles?: number };

type Props = {
  taxReturnId: string | null;
  taxRow: Record<string, unknown> | null;
  onSaved: () => Promise<void>;
};

export function ManualTaxEntriesCard({ taxReturnId, taxRow, onSaved }: Props) {
  const { toast } = useToast();
  const [income, setIncome] = useState<ManualIn[]>([]);
  const [deductions, setDeductions] = useState<ManualDed[]>([]);
  const [saving, setSaving] = useState(false);
  const [incAmount, setIncAmount] = useState("");
  const [incCat, setIncCat] = useState<string>("cash");
  const [incDesc, setIncDesc] = useState("");
  const [dedAmount, setDedAmount] = useState("");
  const [dedCat, setDedCat] = useState<string>("supplies");
  const [dedDesc, setDedDesc] = useState("");
  const [dedMiles, setDedMiles] = useState("");

  const loadFromRow = useCallback(() => {
    const js = (taxRow?.json_summary || {}) as Record<string, unknown>;
    const mi = js.manual_income;
    const md = js.manual_deductions;
    setIncome(Array.isArray(mi) ? (mi as ManualIn[]) : []);
    setDeductions(Array.isArray(md) ? (md as ManualDed[]) : []);
  }, [taxRow?.json_summary]);

  useEffect(() => {
    loadFromRow();
  }, [loadFromRow]);

  async function persist(nextIncome: ManualIn[], nextDed: ManualDed[]) {
    if (!taxReturnId) return;
    setSaving(true);
    try {
      const js = { ...((taxRow?.json_summary || {}) as Record<string, unknown>), manual_income: nextIncome, manual_deductions: nextDed };
      const { error } = await supabase
        .from("tax_returns")
        .update({ json_summary: js as Json, updated_at: new Date().toISOString() })
        .eq("id", taxReturnId);
      if (error) throw error;
      toast({ title: "Saved manual entries" });
      await onSaved();
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

  function addIncome() {
    const n = parseFloat(incAmount);
    if (!Number.isFinite(n) || n === 0) return;
    const next = [
      ...income,
      {
        id: crypto.randomUUID(),
        amount: n,
        category: incCat,
        description: incDesc.trim() || undefined,
      },
    ];
    setIncome(next);
    setIncAmount("");
    setIncDesc("");
    void persist(next, deductions);
  }

  function removeIncome(id: string) {
    const next = income.filter((x) => x.id !== id);
    setIncome(next);
    void persist(next, deductions);
  }

  function addDeduction() {
    let n = parseFloat(dedAmount);
    const miles = parseFloat(dedMiles);
    if (dedCat === "car_truck_expenses" && Number.isFinite(miles) && miles > 0) {
      n = Math.round(miles * 0.585 * 100) / 100;
    } else if (!Number.isFinite(n) || n === 0) return;
    const next: ManualDed[] = [
      ...deductions,
      {
        id: crypto.randomUUID(),
        amount: n,
        category: dedCat,
        description: dedDesc.trim() || undefined,
        miles: Number.isFinite(miles) && miles > 0 ? miles : undefined,
      },
    ];
    setDeductions(next);
    setDedAmount("");
    setDedDesc("");
    setDedMiles("");
    void persist(income, next);
  }

  function removeDed(id: string) {
    const next = deductions.filter((x) => x.id !== id);
    setDeductions(next);
    void persist(income, next);
  }

  const totalInc = income.reduce((s, x) => s + x.amount, 0);
  const totalDed = deductions.reduce((s, x) => s + x.amount, 0);

  if (!taxReturnId) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Manual income &amp; deductions</CardTitle>
        <p className="text-sm text-muted-foreground">
          Entries without documents. Stored on this return&apos;s JSON summary and included on the next AI generation.
        </p>
      </CardHeader>
      <CardContent className="space-y-8">
        <div className="space-y-3">
          <p className="text-sm font-medium">Manual income (total ${totalInc.toLocaleString()})</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <Label>Amount</Label>
              <Input
                type="number"
                value={incAmount}
                onChange={(e) => setIncAmount(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="space-y-1">
              <Label>Category</Label>
              <Select value={incCat} onValueChange={setIncCat}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INCOME_CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Description</Label>
              <Input value={incDesc} onChange={(e) => setIncDesc(e.target.value)} placeholder="Optional" />
            </div>
          </div>
          <Button type="button" size="sm" onClick={addIncome} disabled={saving}>
            Add income
          </Button>
          {income.length > 0 && (
            <ul className="divide-y rounded-md border text-sm">
              {income.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span>
                    ${row.amount.toLocaleString()} · {row.category}
                    {row.description ? ` — ${row.description}` : ""}
                  </span>
                  <Button type="button" variant="ghost" size="icon" onClick={() => removeIncome(row.id)} aria-label="Remove">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-3">
          <p className="text-sm font-medium">Manual deductions (total ${totalDed.toLocaleString()})</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <Label>Amount</Label>
              <Input
                type="number"
                value={dedAmount}
                onChange={(e) => setDedAmount(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="space-y-1">
              <Label>Category</Label>
              <Select value={dedCat} onValueChange={setDedCat}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {DEDUCTION_CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Miles (car/truck)</Label>
              <Input
                type="number"
                value={dedMiles}
                onChange={(e) => setDedMiles(e.target.value)}
                placeholder="0.585 $/mi 2022"
              />
            </div>
            <div className="space-y-1 sm:col-span-2 lg:col-span-1">
              <Label>Description</Label>
              <Input value={dedDesc} onChange={(e) => setDedDesc(e.target.value)} placeholder="Optional" />
            </div>
          </div>
          <Button type="button" size="sm" onClick={addDeduction} disabled={saving}>
            Add deduction
          </Button>
          {deductions.length > 0 && (
            <ul className="divide-y rounded-md border text-sm">
              {deductions.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span>
                    ${row.amount.toLocaleString()} · {row.category}
                    {row.miles != null ? ` (${row.miles} mi)` : ""}
                    {row.description ? ` — ${row.description}` : ""}
                  </span>
                  <Button type="button" variant="ghost" size="icon" onClick={() => removeDed(row.id)} aria-label="Remove">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

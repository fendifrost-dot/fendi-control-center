// supabase/functions/_shared/taxReturns.ts
// Supabase CRUD helpers for the tax_returns, tax_form_instances, and tax_return_audit_log tables.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export interface TaxReturnUpsert {
  client_id: string;
  client_name?: string;
  tax_year: number;
  status?: string;
  filing_status?: string;
  json_summary?: Record<string, unknown>;
  worksheet?: string;
  filing_recommendation?: Record<string, unknown>;
  agi?: number;
  total_income?: number;
  total_tax?: number;
  amount_owed_or_refund?: number;
  filing_readiness_score?: number;
  filing_method?: string;
  drive_folder_id?: string;
  drive_folder_url?: string;
  model?: string;
  notes?: string;
  created_by?: string;
  analyzed_data?: Record<string, unknown>;
  workspace_settings?: Record<string, unknown>;
}

export interface TaxFormInstanceInsert {
  tax_return_id: string;
  template_id?: string;
  form_type: string;
  form_year: number;
  status?: string;
  field_data?: Record<string, unknown>;
  pdf_url?: string;
  drive_file_id?: string;
  error_message?: string;
  notes?: string;
}

export interface AuditLogEntry {
  tax_return_id: string;
  action: string;
  actor?: string;
  old_values?: Record<string, unknown>;
  new_values?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Upsert a tax return (insert or update on client_id + tax_year unique). */
export async function upsertTaxReturn(
  supabase: SupabaseClient,
  data: TaxReturnUpsert
): Promise<{ id: string; created: boolean }> {
  const { data: existing, error: selectError } = await supabase
    .from("tax_returns")
    .select("id")
    .eq("client_id", data.client_id)
    .eq("tax_year", data.tax_year)
    .maybeSingle();
  if (selectError) {
    console.error("[upsertTaxReturn] SELECT error:", selectError.message);
    throw new Error(`Failed to check existing tax return: ${selectError.message}`);
  }

  if (existing) {
    const { error } = await supabase
      .from("tax_returns")
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) throw new Error("Failed to update tax return: " + error.message);
    return { id: existing.id, created: false };
  }

  const { data: created, error } = await supabase
    .from("tax_returns")
    .insert(data)
    .select("id")
    .single();
  if (error) throw new Error("Failed to insert tax return: " + error.message);
  return { id: created.id, created: true };
}

/** Get a single tax return by client_id and year. */
export async function getTaxReturn(
  supabase: SupabaseClient,
  clientId: string,
  year: number
): Promise<any | null> {
  const { data, error } = await supabase
    .from("tax_returns")
    .select("*, tax_form_instances(*)")
    .eq("client_id", clientId)
    .eq("tax_year", year)
    .maybeSingle();
  if (error) throw new Error("Failed to get tax return: " + error.message);
  return data;
}

/** Get a tax return by its UUID. */
export async function getTaxReturnById(
  supabase: SupabaseClient,
  id: string
): Promise<any | null> {
  const { data, error } = await supabase
    .from("tax_returns")
    .select("*, tax_form_instances(*)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error("Failed to get tax return: " + error.message);
  return data;
}

/** List tax returns, optionally filtered by client. */
export async function listTaxReturns(
  supabase: SupabaseClient,
  clientId?: string,
  limit = 50
): Promise<any[]> {
  let query = supabase
    .from("tax_returns")
    .select("id, client_id, client_name, tax_year, status, agi, total_income, total_tax, amount_owed_or_refund, filing_readiness_score, filing_method, created_at, updated_at")
    .order("tax_year", { ascending: false })
    .limit(limit);

  if (clientId) {
    query = query.eq("client_id", clientId);
  }

  const { data, error } = await query;
  if (error) throw new Error("Failed to list tax returns: " + error.message);
  return data || [];
}

/** Insert a tax form instance (filled PDF record). */
export async function insertFormInstance(
  supabase: SupabaseClient,
  data: TaxFormInstanceInsert
): Promise<string> {
  const { data: row, error } = await supabase
    .from("tax_form_instances")
    .insert(data)
    .select("id")
    .single();
  if (error) throw new Error("Failed to insert form instance: " + error.message);
  return row.id;
}

/** Update a form instance status and PDF URL after filling. */
export async function updateFormInstance(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<TaxFormInstanceInsert>
): Promise<void> {
  const { error } = await supabase
    .from("tax_form_instances")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error("Failed to update form instance: " + error.message);
}

/** Get all form instances for a tax return. */
export async function getFormInstances(
  supabase: SupabaseClient,
  taxReturnId: string
): Promise<any[]> {
  const { data, error } = await supabase
    .from("tax_form_instances")
    .select("*")
    .eq("tax_return_id", taxReturnId)
    .order("form_type");
  if (error) throw new Error("Failed to get form instances: " + error.message);
  return data || [];
}

/** Get the template for a specific form type and year. */
export async function getFormTemplate(
  supabase: SupabaseClient,
  formType: string,
  formYear: number
): Promise<any | null> {
  const { data, error } = await supabase
    .from("tax_form_templates")
    .select("*")
    .eq("form_type", formType)
    .eq("form_year", formYear)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error("Failed to get form template: " + error.message);
  return data;
}

/** Log an action to the audit trail. */
export async function logAudit(
  supabase: SupabaseClient,
  entry: AuditLogEntry
): Promise<void> {
  const { error } = await supabase
    .from("tax_return_audit_log")
    .insert(entry);
  if (error) {
    console.error("Audit log insert failed:", error.message);
  }
  }



## Plan: Create `delete_client_and_related_data` Database Function

### Single Step — Database Migration

Run the user-provided SQL as a migration to create the `delete_client_and_related_data(uuid)` function with `SECURITY DEFINER`, plus `REVOKE ALL` / `GRANT EXECUTE` to `authenticated` and `service_role`, and the `COMMENT`.

The SQL will be used exactly as provided. No application code changes.

### Technical Details

The migration creates a PL/pgSQL function that deletes rows in dependency order across: `telegram_approval_queue`, `audit_logs` (nullify FK), `documents` (clear self-ref), `extracted_pages`, `observations`, `ingestion_jobs`, `conflicts`, `documents`, `drive_sync_events`, `tax_returns`, `marketing_spend`, `dispute_letters`, `credit_analyses`, and finally `clients`.

Access is restricted to `authenticated` and `service_role` roles only.




# Credit Case Control Center — Phase 1: Database Foundation

## Overview
Production-grade, append-only, evidence-first schema for credit case management. Single-user (Fendi Frost), Google Drive as canonical source of truth, Supabase as structured metadata layer.

## Core Principles Acknowledged
- **Immutability**: No UPDATE/DELETE on `documents`, `extracted_pages`, `observations` — INSERT only, soft-delete via flags
- **Observability**: All jobs have heartbeats, attempt counts, worker IDs, error tracking
- **Deterministic views**: Explicit ordering by confidence → recency → source preference
- **Forward-compatible**: `model_id` on observations supports future multi-model extraction
- **Schema stability**: Additive-only migrations, no destructive changes without confirmation

## Step 1 — Enable Supabase (Lovable Cloud)
Spin up backend infrastructure for auth and database.

## Step 2 — Create Core Tables (Migration 1)
Create all 9 tables with exact schemas as specified:
- `clients` — client records with Drive folder linkage
- `documents` — immutable document metadata with lineage tracking (`is_deleted`, `replaced_by_document_id`, `source_version`)
- `extracted_pages` — per-page text/OCR with unique constraint on (document_id, page_number)
- `observations` — append-only extracted facts with confidence scores and model tracking
- `conflicts` — flagged disagreements between observations
- `ingestion_jobs` — job queue with heartbeat/retry observability
- `drive_sync_runs` — sync session tracking
- `drive_sync_events` — per-file sync event log
- `audit_logs` — user action audit trail

## Step 3 — Add Indexes (Migration 2)
- Unique index on observations: `(client_id, object_type, object_key, field_name, document_id, page_number)` — prevents duplicate extractions
- Composite index on documents: `(client_id, drive_modified_time)` — efficient client document lookups
- Composite index on ingestion_jobs: `(status, heartbeat_at)` — stuck job detection

## Step 4 — Enable RLS on All Tables (Migration 3)
Permissive single-user policy on every table: authenticated user gets full access via `auth.uid() IS NOT NULL`.

## Step 5 — Create Current-State Views (Migration 4)
Three non-materialized views resolving the "best" observation per key:
- `current_tradelines` — filters `object_type = 'tradeline'`
- `current_inquiries` — filters `object_type = 'inquiry'`
- `current_personal_info` — filters `object_type = 'personal_info'`

Each uses deterministic row selection: highest confidence → newest created_at → preferred bureau/doc_type via CASE expression.

## Step 6 — Regression Checklist Verification
After applying, verify:
- Unique index blocks duplicate observations
- Soft-delete flags work (no actual row deletion)
- Retry/reprocessing inserts new rows, never mutates
- Views return exactly one row per (client_id, object_type, object_key, field_name)
- Stuck jobs detectable via stale heartbeat_at
- All constraints and NOT NULL rules hold

## What This Does NOT Include (by design)
No UI, no pages, no components, no Edge Functions, no auth setup, no Google Drive integration code. Phase 2+ only after Phase 1 is confirmed applied and tested.


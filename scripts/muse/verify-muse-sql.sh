#!/usr/bin/env bash
# Validate the Muse migration against a real PostgreSQL server.
#
#   ./scripts/muse/verify-muse-sql.sh
#
# Builds a throwaway database containing a faithful subset of the live Control
# Hub schema, applies the Muse migration twice (idempotency), loads sample
# activity, then runs every assertion in verify-muse-sql.sql — including the
# read-only security tests.
#
# Requires a local PostgreSQL 15+ and psql. Never points at production.
set -euo pipefail

DB="${MUSE_VERIFY_DB:-muse_verify}"
PSQL_BASE=(psql -v ON_ERROR_STOP=1 -q)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "== rebuilding $DB =="
"${PSQL_BASE[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null
"${PSQL_BASE[@]}" -d postgres -c "CREATE DATABASE $DB" >/dev/null

echo "== loading Control Hub schema subset =="
"${PSQL_BASE[@]}" -d "$DB" -f scripts/muse/fixtures/control_hub_subset.sql >/dev/null

echo "== applying Muse migration =="
"${PSQL_BASE[@]}" -d "$DB" -f supabase/migrations/20260925120000_muse_executive_layer.sql >/dev/null

echo "== loading sample activity =="
"${PSQL_BASE[@]}" -d "$DB" -f scripts/muse/fixtures/sample_activity.sql >/dev/null

echo "== running assertions =="
psql -v ON_ERROR_STOP=1 -d "$DB" -f scripts/muse/verify-muse-sql.sql

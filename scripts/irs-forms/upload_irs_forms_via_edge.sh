#!/usr/bin/env bash
# Trigger Supabase Edge Function upload-irs-forms to download IRS PDFs server-side
# and cache them in the "irs-forms" bucket. Does NOT upload local PDF files.
#
# Prerequisites: jq, curl
# Env:
#   SUPABASE_URL   (e.g. https://wkzwcfmvnwolgrdpnygc.supabase.co)
#   SUPABASE_ANON_KEY  (anon publishable key — Edge Function uses service role internally)
#
# Optional:
#   TAX_YEAR (default: tax_year from manifest or 2022)
#
# Usage:
#   export SUPABASE_URL="https://....supabase.co"
#   export SUPABASE_ANON_KEY="eyJ..."
#   ./upload_irs_forms_via_edge.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${SCRIPT_DIR}/irs_forms_manifest.json"

: "${SUPABASE_URL:?Set SUPABASE_URL}"
: "${SUPABASE_ANON_KEY:?Set SUPABASE_ANON_KEY}"

TAX_YEAR="${TAX_YEAR:-$(jq -r '.tax_year // empty' "$MANIFEST")}"
if [[ -z "$TAX_YEAR" || "$TAX_YEAR" == "null" ]]; then
  TAX_YEAR=2022
fi

FORMS_JSON="$(jq -c '[.forms[].slug]' "$MANIFEST")"
COUNT="$(echo "$FORMS_JSON" | jq 'length')"

echo "=== upload-irs-forms: tax_year=${TAX_YEAR}, ${COUNT} forms (from manifest) ==="

RESPONSE="$(curl -sS -X POST \
  "${SUPABASE_URL}/functions/v1/upload-irs-forms" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
  -d "{\"tax_year\": ${TAX_YEAR}, \"forms\": ${FORMS_JSON}}" \
  --max-time 300)"

echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
echo "=== Done ==="

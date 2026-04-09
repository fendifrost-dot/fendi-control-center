#!/usr/bin/env bash
# Download IRS PDFs locally and extract AcroForm field names (for offline analysis).
# Run from repo: scripts/irs-forms/download_all_irs_forms.sh
#
# Prerequisite: pip install pypdf
# Optional env:
#   TAX_YEAR (default from manifest or 2022)
#   OUT_DIR  (default /tmp/irs_forms_<year>)
#   FIELDS_DIR (default /tmp/irs_fields_<year>)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${SCRIPT_DIR}/irs_forms_manifest.json"

TAX_YEAR="${TAX_YEAR:-$(jq -r '.tax_year // empty' "$MANIFEST")}"
[[ -z "$TAX_YEAR" || "$TAX_YEAR" == "null" ]] && TAX_YEAR=2022

OUT_DIR="${OUT_DIR:-/tmp/irs_forms_${TAX_YEAR}}"
FIELDS_DIR="${FIELDS_DIR:-/tmp/irs_fields_${TAX_YEAR}}"

mkdir -p "$OUT_DIR" "$FIELDS_DIR"

echo "=== Downloading IRS forms for tax year ${TAX_YEAR} → ${OUT_DIR} ==="

while IFS= read -r IRS_FILE; do
  if [[ -z "$IRS_FILE" ]]; then continue; fi
  FILE="$OUT_DIR/${IRS_FILE}--${TAX_YEAR}.pdf"
  if [[ -f "$FILE" ]] && [[ -s "$FILE" ]]; then
    echo "SKIP $IRS_FILE (already downloaded)"
    continue
  fi

  URL="https://www.irs.gov/pub/irs-prior/${IRS_FILE}--${TAX_YEAR}.pdf"
  echo -n "Downloading $IRS_FILE... "
  HTTP_CODE=$(curl -s -o "$FILE" -w "%{http_code}" -L "$URL" 2>/dev/null || true)

  if [[ "$HTTP_CODE" == "200" ]] && [[ -s "$FILE" ]]; then
    echo "OK ($(du -h "$FILE" | cut -f1))"
  else
    URL2="https://www.irs.gov/pub/irs-pdf/${IRS_FILE}.pdf"
    HTTP_CODE2=$(curl -s -o "$FILE" -w "%{http_code}" -L "$URL2" 2>/dev/null || true)
    if [[ "$HTTP_CODE2" == "200" ]] && [[ -s "$FILE" ]]; then
      echo "OK via current-year ($(du -h "$FILE" | cut -f1))"
    else
      echo "FAILED (HTTP $HTTP_CODE / $HTTP_CODE2)"
      rm -f "$FILE"
    fi
  fi
done < <(jq -r '.forms[].irs_file' "$MANIFEST")

echo ""
echo "=== Extracting AcroForm field names → ${FIELDS_DIR} ==="
pip install pypdf --quiet 2>/dev/null || true

export FORMS_DIR="$OUT_DIR"
export FIELDS_DIR
export TAX_YEAR_STR="$TAX_YEAR"

python3 << 'PYEOF'
import os, json
from pypdf import PdfReader

forms_dir = os.environ["FORMS_DIR"]
fields_dir = os.environ["FIELDS_DIR"]
year = os.environ["TAX_YEAR_STR"]
all_fields = {}

for fname in sorted(os.listdir(forms_dir)):
    if not fname.endswith(".pdf"):
        continue
    slug = fname.replace(f"--{year}.pdf", "").replace(".pdf", "")
    path = os.path.join(forms_dir, fname)
    try:
        reader = PdfReader(path)
        fields = reader.get_fields() or {}
        field_list = []
        for name, field in sorted(fields.items()):
            field_list.append({
                "name": name,
                "type": str(field.get("/FT", "unknown")),
                "tooltip": str(field.get("/TU", ""))[:100],
                "default_value": str(field.get("/V", ""))[:50] if "/V" in field else "",
            })
        all_fields[slug] = {"file": fname, "total_fields": len(field_list), "fields": field_list}
        with open(os.path.join(fields_dir, f"{slug}_fields.json"), "w") as f:
            json.dump(field_list, f, indent=2)
        print(f"{slug}: {len(field_list)} fields")
    except Exception as e:
        print(f"{slug}: ERROR - {e}")
        all_fields[slug] = {"file": fname, "error": str(e)}

combined = os.path.join(fields_dir, "all_form_fields.json")
with open(combined, "w") as f:
    json.dump(all_fields, f, indent=2)
print(f"\nCombined: {combined}")
PYEOF

echo "=== Done ==="

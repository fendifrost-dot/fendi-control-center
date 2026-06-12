#!/usr/bin/env bash
# Kick off FENDIFROST identity LoRA training on Fal (flux-lora-fast-training).
#
# Prerequisites:
#   export FAL_API_KEY="..."   # from Lovable Cloud → Edge Functions → Secrets
#
# Usage:
#   ./scripts/kickoff-fendifrost-identity-lora.sh
#   ./scripts/kickoff-fendifrost-identity-lora.sh /path/to/training.zip
#
# Writes job metadata to scripts/.fendifrost-identity-lora-job.json on submit.

set -euo pipefail

ZIP_PATH="${1:-$HOME/fendi-control-center/AVT FACE IMAGES/FENDIFROST_lora_training_set.zip}"
JOB_FILE="$(dirname "$0")/.fendifrost-identity-lora-job.json"
TRIGGER_WORD="FENDIFROST"
STEPS=1500
POLL_INTERVAL=30

if [[ -z "${FAL_API_KEY:-}" ]]; then
  echo "error: FAL_API_KEY is not set." >&2
  echo "Pull it from Lovable Cloud → Backend → Edge Functions → Secrets." >&2
  exit 1
fi

if [[ ! -f "$ZIP_PATH" ]]; then
  echo "error: ZIP not found: $ZIP_PATH" >&2
  exit 1
fi

echo "==> Uploading $(basename "$ZIP_PATH") to Fal storage..."
INIT_RESP="$(
  curl -sf -X POST \
    "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3" \
    -H "Authorization: Key ${FAL_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"file_name\":\"$(basename "$ZIP_PATH")\",\"content_type\":\"application/zip\"}"
)"

UPLOAD_URL="$(echo "$INIT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['upload_url'])")"
FILE_URL="$(echo "$INIT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['file_url'])")"

curl -sf -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/zip" \
  --data-binary @"$ZIP_PATH"

echo "==> ZIP public URL: $FILE_URL"
echo "==> Submitting identity LoRA training (trigger=$TRIGGER_WORD, steps=$STEPS, masks=true)..."

SUBMIT_RESP="$(
  curl -sf -X POST "https://queue.fal.run/fal-ai/flux-lora-fast-training" \
    -H "Authorization: Key ${FAL_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "
import json
print(json.dumps({
  'images_data_url': '$FILE_URL',
  'trigger_word': '$TRIGGER_WORD',
  'is_style': False,
  'create_masks': True,
  'steps': $STEPS,
}))
")"
)"

REQUEST_ID="$(echo "$SUBMIT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['request_id'])")"
STATUS_URL="$(echo "$SUBMIT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['status_url'])")"
RESPONSE_URL="$(echo "$SUBMIT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['response_url'])")"

python3 -c "
import json, datetime
print(json.dumps({
  'submitted_at': datetime.datetime.utcnow().isoformat() + 'Z',
  'request_id': '$REQUEST_ID',
  'status_url': '$STATUS_URL',
  'response_url': '$RESPONSE_URL',
  'images_data_url': '$FILE_URL',
  'trigger_word': '$TRIGGER_WORD',
  'steps': $STEPS,
}, indent=2))
" >"$JOB_FILE"

echo "==> Queued. request_id=$REQUEST_ID"
echo "==> Job metadata: $JOB_FILE"
echo "==> Polling every ${POLL_INTERVAL}s (30-45 min typical)..."

while true; do
  STATUS_RESP="$(curl -sf "$STATUS_URL" -H "Authorization: Key ${FAL_API_KEY}")"
  STATUS="$(echo "$STATUS_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")"
  echo "    status=$STATUS ($(date -u +%H:%M:%S)Z)"

  if [[ "$STATUS" == "COMPLETED" ]]; then
    RESULT="$(curl -sf "$RESPONSE_URL" -H "Authorization: Key ${FAL_API_KEY}")"
    LORA_URL="$(echo "$RESULT" | python3 -c "
import sys, json
r = json.load(sys.stdin)
f = r.get('diffusers_lora_file') or {}
print(f.get('url') or '')
")"
    if [[ -z "$LORA_URL" ]]; then
      echo "error: training completed but no diffusers_lora_file.url in response" >&2
      echo "$RESULT" | python3 -m json.tool >&2
      exit 1
    fi
    python3 -c "
import json
job = json.load(open('$JOB_FILE'))
job['completed_at'] = __import__('datetime').datetime.utcnow().isoformat() + 'Z'
job['lora_url'] = '$LORA_URL'
json.dump(job, open('$JOB_FILE', 'w'), indent=2)
"
    echo "==> Training complete."
    echo "==> LoRA URL: $LORA_URL"
    echo "==> Saved to $JOB_FILE"
    exit 0
  fi

  if [[ "$STATUS" == "FAILED" || "$STATUS" == "ERROR" ]]; then
    echo "error: training failed" >&2
    echo "$STATUS_RESP" | python3 -m json.tool >&2
    exit 1
  fi

  sleep "$POLL_INTERVAL"
done

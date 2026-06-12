#!/usr/bin/env bash
# Kick off FENDIFROST identity LoRA training on Fal (flux-lora-fast-training).
#
# Preferred (uses CC's deployed FAL_API_KEY — no local Fal key needed):
#   export COMPOSE_LOOK_PROXY_SECRET="..."   # Lovable Cloud → CC → Edge Functions → Secrets
#   ./scripts/kickoff-fendifrost-identity-lora.sh
#
# Fallback (direct Fal API):
#   export FAL_API_KEY="..."
#   ./scripts/kickoff-fendifrost-identity-lora.sh
#
# Writes job metadata to scripts/.fendifrost-identity-lora-job.json on submit.

set -euo pipefail

ZIP_PATH="${1:-$HOME/fendi-control-center/AVT FACE IMAGES/FENDIFROST_lora_training_set.zip}"
JOB_FILE="$(dirname "$0")/.fendifrost-identity-lora-job.json"
CC_BASE="${CC_SUPABASE_URL:-https://wkzwcfmvnwolgrdpnygc.supabase.co}/functions/v1"
TRIGGER_WORD="FENDIFROST"
STEPS=1500
POLL_INTERVAL=30

if [[ -z "${COMPOSE_LOOK_PROXY_SECRET:-}" && -z "${FAL_API_KEY:-}" ]]; then
  echo "error: set COMPOSE_LOOK_PROXY_SECRET (preferred — uses CC's FAL_API_KEY)" >&2
  echo "       or FAL_API_KEY for direct Fal access." >&2
  exit 1
fi

if [[ ! -f "$ZIP_PATH" ]]; then
  echo "error: ZIP not found: $ZIP_PATH" >&2
  exit 1
fi

USE_CC=false
if [[ -n "${COMPOSE_LOOK_PROXY_SECRET:-}" ]]; then
  USE_CC=true
fi

upload_zip_cc() {
  curl -sf -X POST "${CC_BASE}/fal-storage-upload" \
    -H "X-Proxy-Secret: ${COMPOSE_LOOK_PROXY_SECRET}" \
    -H "Content-Type: application/zip" \
    -H "X-File-Name: $(basename "$ZIP_PATH")" \
    --data-binary @"$ZIP_PATH"
}

upload_zip_direct() {
  local init_resp upload_url file_url
  init_resp="$(
    curl -sf -X POST \
      "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3" \
      -H "Authorization: Key ${FAL_API_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"file_name\":\"$(basename "$ZIP_PATH")\",\"content_type\":\"application/zip\"}"
  )"
  upload_url="$(echo "$init_resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['upload_url'])")"
  file_url="$(echo "$init_resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['file_url'])")"
  curl -sf -X PUT "$upload_url" \
    -H "Content-Type: application/zip" \
    --data-binary @"$ZIP_PATH"
  python3 -c "import json; print(json.dumps({'file_url': '$file_url'}))"
}

submit_training_cc() {
  local file_url="$1"
  curl -sf -X POST "${CC_BASE}/train-style-lora" \
    -H "X-Proxy-Secret: ${COMPOSE_LOOK_PROXY_SECRET}" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "
import json
print(json.dumps({
  'images_data_url': '$file_url',
  'trigger_word': '$TRIGGER_WORD',
  'is_style': False,
  'create_masks': True,
  'steps': $STEPS,
  'queue_only': True,
}))
")"
}

submit_training_direct() {
  local file_url="$1"
  curl -sf -X POST "https://queue.fal.run/fal-ai/flux-lora-fast-training" \
    -H "Authorization: Key ${FAL_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "
import json
print(json.dumps({
  'images_data_url': '$file_url',
  'trigger_word': '$TRIGGER_WORD',
  'is_style': False,
  'create_masks': True,
  'steps': $STEPS,
}))
")"
}

poll_once_cc() {
  local status_url="$1" response_url="$2"
  curl -sf -X POST "${CC_BASE}/fal-queue-poll" \
    -H "X-Proxy-Secret: ${COMPOSE_LOOK_PROXY_SECRET}" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "
import json
print(json.dumps({'status_url': '$status_url', 'response_url': '$response_url'}))
")"
}

poll_once_direct() {
  local status_url="$1" response_url="$2"
  local status_resp status
  status_resp="$(curl -sf "$status_url" -H "Authorization: Key ${FAL_API_KEY}")"
  status="$(echo "$status_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")"
  if [[ "$status" == "COMPLETED" ]]; then
    curl -sf "$response_url" -H "Authorization: Key ${FAL_API_KEY}"
  else
    echo "$status_resp"
  fi
}

echo "==> Uploading $(basename "$ZIP_PATH")..."
if $USE_CC; then
  echo "    (via CC fal-storage-upload — server-side FAL_API_KEY)"
  UPLOAD_JSON="$(upload_zip_cc)"
else
  echo "    (direct Fal storage)"
  UPLOAD_JSON="$(upload_zip_direct)"
fi
FILE_URL="$(echo "$UPLOAD_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['file_url'])")"
echo "==> ZIP public URL: $FILE_URL"

echo "==> Submitting identity LoRA training (trigger=$TRIGGER_WORD, steps=$STEPS, masks=true)..."
if $USE_CC; then
  SUBMIT_JSON="$(submit_training_cc "$FILE_URL")"
else
  SUBMIT_JSON="$(submit_training_direct "$FILE_URL")"
fi

REQUEST_ID="$(echo "$SUBMIT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['request_id'])")"
STATUS_URL="$(echo "$SUBMIT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['status_url'])")"
RESPONSE_URL="$(echo "$SUBMIT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['response_url'])")"

python3 -c "
import json, datetime
print(json.dumps({
  'submitted_at': datetime.datetime.utcnow().isoformat() + 'Z',
  'via_cc': $USE_CC,
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
  if $USE_CC; then
    POLL_JSON="$(poll_once_cc "$STATUS_URL" "$RESPONSE_URL")"
    STATUS="$(echo "$POLL_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")"
    LORA_URL="$(echo "$POLL_JSON" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('lora_url') or '')")"
  else
    POLL_RAW="$(poll_once_direct "$STATUS_URL" "$RESPONSE_URL")"
    STATUS="$(echo "$POLL_RAW" | python3 -c "
import sys, json
r = json.load(sys.stdin)
print(r.get('status') or ('COMPLETED' if r.get('diffusers_lora_file') else ''))
")"
    LORA_URL="$(echo "$POLL_RAW" | python3 -c "
import sys, json
r = json.load(sys.stdin)
f = r.get('diffusers_lora_file') or {}
print(f.get('url') or r.get('lora_url') or '')
")"
  fi

  echo "    status=$STATUS ($(date -u +%H:%M:%S)Z)"

  if [[ "$STATUS" == "COMPLETED" ]]; then
    if [[ -z "$LORA_URL" ]]; then
      echo "error: training completed but no lora_url in response" >&2
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
    echo "$POLL_JSON" >&2 2>/dev/null || echo "$POLL_RAW" >&2
    exit 1
  fi

  sleep "$POLL_INTERVAL"
done

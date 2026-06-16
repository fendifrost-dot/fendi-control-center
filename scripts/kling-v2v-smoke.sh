#!/usr/bin/env bash
# Kling O1 Edit video-to-video smoke test — bypasses Supabase Edge 150s sync wall.
#
# Kling O1 Edit runs 60–180s; CC's kling-restyle sync mode hits IDLE_TIMEOUT.
# This script submits with queue_only=true, then polls Fal client-side (up to 10 min).
#
# Preferred (uses CC's deployed FAL_API_KEY — no local Fal key needed):
#   export KLING_PROXY_SECRET="..."          # CC → Edge Functions → Secrets
#   export COMPOSE_LOOK_PROXY_SECRET="..."   # for fal-queue-poll (same FAL_API_KEY)
#   ./scripts/kling-v2v-smoke.sh [prompt_index]
#
# Fallback (direct Fal API):
#   export FAL_API_KEY="..."
#   ./scripts/kling-v2v-smoke.sh [prompt_index]
#
# prompt_index: 1–4 (default 1). Runs one wardrobe scenario per invocation.
# Writes job metadata + result to scripts/.kling-v2v-smoke-job.json

set -euo pipefail

PROMPT_INDEX="${1:-1}"
JOB_FILE="$(dirname "$0")/.kling-v2v-smoke-job.json"
CC_BASE="${CC_SUPABASE_URL:-https://wkzwcfmvnwolgrdpnygc.supabase.co}/functions/v1"
POLL_INTERVAL=5
POLL_TIMEOUT=600

# Fendi 5s performance clip — 720×1280, 30fps (signed URL; refresh if expired).
SOURCE_VIDEO_URL="${KLING_SOURCE_VIDEO_URL:-}"

PROMPTS=(
  "Neon-lit Tokyo alley at night, subject wearing a crimson silk shirt and black trousers, cinematic moody lighting"
  "Luxury private jet cabin with golden window light, subject wearing a black leather jacket over a white shirt"
  "Chicago rooftop at sunset, subject wearing a denim trucker jacket and dark jeans"
  "Capri villa terrace overlooking the sea, subject wearing a beige Pequin striped denim jacket, shorts, and white tee"
)

if [[ -z "${SOURCE_VIDEO_URL}" ]]; then
  echo "error: set KLING_SOURCE_VIDEO_URL to a signed 720×1280 mp4 URL" >&2
  echo "       (see CURSOR_HANDOFF_kling_v2v_smoke_test.md for the Fendi test clip)" >&2
  exit 1
fi

if [[ "$PROMPT_INDEX" -lt 1 || "$PROMPT_INDEX" -gt 4 ]]; then
  echo "error: prompt_index must be 1–4" >&2
  exit 1
fi
PROMPT="${PROMPTS[$((PROMPT_INDEX - 1))]}"

if [[ -z "${KLING_PROXY_SECRET:-}" && -z "${FAL_API_KEY:-}" ]]; then
  echo "error: set KLING_PROXY_SECRET (preferred — uses CC's FAL_API_KEY)" >&2
  echo "       or FAL_API_KEY for direct Fal access." >&2
  exit 1
fi

USE_CC=false
if [[ -n "${KLING_PROXY_SECRET:-}" ]]; then
  USE_CC=true
fi

submit_cc() {
  curl -sf -X POST "${CC_BASE}/kling-restyle" \
    -H "X-Proxy-Secret: ${KLING_PROXY_SECRET}" \
    -H "Content-Type: application/json" \
    -d @- <<EOF
$(jq -n --arg url "$SOURCE_VIDEO_URL" --arg prompt "$PROMPT" '{sourceVideoUrl: $url, prompt: $prompt, queue_only: true}')
EOF
}

submit_direct() {
  curl -sf -X POST "https://queue.fal.run/fal-ai/kling-video/o1/video-to-video/edit" \
    -H "Authorization: Key ${FAL_API_KEY}" \
    -H "Content-Type: application/json" \
    -d @- <<EOF
$(jq -n --arg url "$SOURCE_VIDEO_URL" --arg prompt "$PROMPT" '{video_url: $url, prompt: $prompt}')
EOF
}

poll_once_cc() {
  local status_url="$1" response_url="$2"
  curl -sf -X POST "${CC_BASE}/fal-queue-poll" \
    -H "X-Proxy-Secret: ${COMPOSE_LOOK_PROXY_SECRET}" \
    -H "Content-Type: application/json" \
    -d @- <<EOF
$(jq -n --arg status_url "$status_url" --arg response_url "$response_url" '{status_url: $status_url, response_url: $response_url}')
EOF
}

poll_once_direct() {
  local status_url="$1" response_url="$2"
  local status_resp status result_json
  status_resp="$(curl -sf "$status_url" -H "Authorization: Key ${FAL_API_KEY}")"
  status="$(echo "$status_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")"
  if [[ "$status" == "COMPLETED" ]]; then
    result_json="$(curl -sf "$response_url" -H "Authorization: Key ${FAL_API_KEY}")"
    python3 -c "
import json, sys
result = json.loads(sys.argv[1])
video = (result.get('video') or {})
print(json.dumps({
  'status': 'COMPLETED',
  'video_url': video.get('url'),
  'result': result,
}))
" "$result_json"
  else
    echo "$status_resp"
  fi
}

extract_video_url() {
  python3 -c "
import json, sys
r = json.load(sys.stdin)
print(r.get('video_url') or (r.get('result') or {}).get('video', {}).get('url') or '')
"
}

echo "==> Kling O1 Edit smoke test — prompt ${PROMPT_INDEX}/4"
echo "    ${PROMPT:0:80}..."

if $USE_CC; then
  if [[ -z "${COMPOSE_LOOK_PROXY_SECRET:-}" ]]; then
    echo "error: COMPOSE_LOOK_PROXY_SECRET required for CC polling via fal-queue-poll" >&2
    exit 1
  fi
  echo "==> Submitting via CC kling-restyle (queue_only)..."
  SUBMIT_JSON="$(submit_cc)"
else
  echo "==> Submitting direct to Fal..."
  SUBMIT_JSON="$(submit_direct)"
fi

REQUEST_ID="$(echo "$SUBMIT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['request_id'])")"
STATUS_URL="$(echo "$SUBMIT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['status_url'])")"
RESPONSE_URL="$(echo "$SUBMIT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['response_url'])")"

python3 -c "
import json, datetime
print(json.dumps({
  'submitted_at': datetime.datetime.utcnow().isoformat() + 'Z',
  'via_cc': $USE_CC,
  'prompt_index': $PROMPT_INDEX,
  'prompt': '''$PROMPT''',
  'request_id': '$REQUEST_ID',
  'status_url': '$STATUS_URL',
  'response_url': '$RESPONSE_URL',
  'source_video_url': '''$SOURCE_VIDEO_URL''',
}, indent=2))
" >"$JOB_FILE"

echo "==> Queued. request_id=$REQUEST_ID"
echo "==> Job metadata: $JOB_FILE"
echo "==> Polling every ${POLL_INTERVAL}s (60–180s typical, timeout ${POLL_TIMEOUT}s)..."

START_TS=$(date +%s)
while true; do
  ELAPSED=$(( $(date +%s) - START_TS ))
  if [[ "$ELAPSED" -ge "$POLL_TIMEOUT" ]]; then
    echo "error: poll timeout after ${POLL_TIMEOUT}s" >&2
    exit 1
  fi

  if $USE_CC; then
    POLL_JSON="$(poll_once_cc "$STATUS_URL" "$RESPONSE_URL")"
  else
    POLL_JSON="$(poll_once_direct "$STATUS_URL" "$RESPONSE_URL")"
  fi

  STATUS="$(echo "$POLL_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")"
  VIDEO_URL="$(echo "$POLL_JSON" | extract_video_url)"

  echo "    status=$STATUS elapsed=${ELAPSED}s ($(date -u +%H:%M:%S)Z)"

  if [[ "$STATUS" == "COMPLETED" ]]; then
    if [[ -z "$VIDEO_URL" ]]; then
      echo "error: job completed but no video_url in response" >&2
      echo "$POLL_JSON" >&2
      exit 1
    fi
    python3 -c "
import json
job = json.load(open('$JOB_FILE'))
job['completed_at'] = __import__('datetime').datetime.utcnow().isoformat() + 'Z'
job['output_video_url'] = '$VIDEO_URL'
with open('$JOB_FILE', 'w') as f:
    json.dump(job, f, indent=2)
"
    echo "==> Complete."
    echo "==> Output video: $VIDEO_URL"
    echo "==> Saved to $JOB_FILE"
    exit 0
  fi

  if [[ "$STATUS" == "FAILED" || "$STATUS" == "ERROR" ]]; then
    echo "error: Kling job failed" >&2
    echo "$POLL_JSON" >&2
    exit 1
  fi

  sleep "$POLL_INTERVAL"
done

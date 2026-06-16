#!/usr/bin/env bash
# SwitchX (Beeble) wardrobe-swap smoke test — bypasses the Supabase Edge 150s
# sync wall the same way the Kling smoke test does.
#
# Flow:
#   1. POST /switchx-restyle with mode=wardrobe + queue_only=true. The function
#      resolves the first-frame keep-mask (face/hands/hair/skin BLACK = preserve,
#      everything else WHITE = regenerate), submits the Beeble job, and returns
#      { beeble_job_id } immediately — no polling, no sync wall.
#   2. Poll /beeble-poll-debug?job_id=<id> client-side (up to 10 min) until the
#      job succeeds and result.render appears.
#   3. Write job metadata + output URL to scripts/.switchx-wardrobe-smoke-job.json
#
# Identity (face, body, motion, lipsync) is preserved by the inverted keep-mask.
# Audio is NOT touched here — the downstream build owns it.
#
# Usage:
#   export SWITCHX_PROXY_SECRET="..."          # CC → Edge Functions → Secrets
#   export WARDROBE_REF_URL="https://.../outfit.jpg"   # target outfit reference
#   ./scripts/switchx-wardrobe-smoke.sh [prompt_index]
#
# prompt_index: 1–4 (default 1). One wardrobe scenario per invocation. Supply a
# different WARDROBE_REF_URL per run to test the 4 reference outfits.
#
# Source video: reuses the staged Fendi clip from .kling-v2v-smoke-job.json.
#   Override with SWITCHX_SOURCE_VIDEO_URL (the baked-in token expires — refresh
#   it if polling never starts / Beeble can't fetch the source).

set -euo pipefail

PROMPT_INDEX="${1:-1}"
SCRIPT_DIR="$(dirname "$0")"
JOB_FILE="${SCRIPT_DIR}/.switchx-wardrobe-smoke-job.json"
KLING_JOB_FILE="${SCRIPT_DIR}/.kling-v2v-smoke-job.json"
CC_BASE="${CC_SUPABASE_URL:-https://wkzwcfmvnwolgrdpnygc.supabase.co}/functions/v1"
POLL_INTERVAL=5
POLL_TIMEOUT=600

# Caller prompt = the garment description ONLY. The function prepends
# "Same subject, identical face and pose, wearing " before sending to Beeble.
PROMPTS=(
  "a tailored charcoal Fendi pinstripe wool suit with a crisp white dress shirt"
  "a brown Fendi FF-monogram leather jacket over a fitted black turtleneck"
  "a beige Pequin-striped denim jacket with matching shorts and a white tee"
  "an emerald-green silk evening gown with subtle gold accents"
)

# ---- source video (reuse the Kling smoke clip) -----------------------------
SOURCE_VIDEO_URL="${SWITCHX_SOURCE_VIDEO_URL:-}"
if [[ -z "${SOURCE_VIDEO_URL}" && -f "${KLING_JOB_FILE}" ]]; then
  SOURCE_VIDEO_URL="$(jq -r '.source_video_url // empty' "${KLING_JOB_FILE}")"
fi
if [[ -z "${SOURCE_VIDEO_URL}" ]]; then
  echo "error: no source video. Set SWITCHX_SOURCE_VIDEO_URL, or ensure" >&2
  echo "       ${KLING_JOB_FILE} has a .source_video_url field." >&2
  exit 1
fi

# ---- required env ----------------------------------------------------------
if [[ -z "${SWITCHX_PROXY_SECRET:-}" ]]; then
  echo "error: set SWITCHX_PROXY_SECRET (CC → Edge Functions → Secrets)" >&2
  exit 1
fi
if [[ -z "${WARDROBE_REF_URL:-}" ]]; then
  echo "error: set WARDROBE_REF_URL to a signed URL for the target outfit image" >&2
  exit 1
fi
if [[ "$PROMPT_INDEX" -lt 1 || "$PROMPT_INDEX" -gt 4 ]]; then
  echo "error: prompt_index must be 1–4" >&2
  exit 1
fi
PROMPT="${PROMPTS[$((PROMPT_INDEX - 1))]}"

# ---- submit (queue_only) ---------------------------------------------------
submit() {
  curl -sf -X POST "${CC_BASE}/switchx-restyle" \
    -H "X-Proxy-Secret: ${SWITCHX_PROXY_SECRET}" \
    -H "Content-Type: application/json" \
    -d @- <<EOF
$(jq -n \
  --arg url "$SOURCE_VIDEO_URL" \
  --arg prompt "$PROMPT" \
  --arg ref "$WARDROBE_REF_URL" \
  '{sourceVideoUrl: $url, prompt: $prompt, mode: "wardrobe", wardrobeReferenceImageUrl: $ref, queue_only: true}')
EOF
}

poll_once() {
  local job_id="$1"
  curl -sf "${CC_BASE}/beeble-poll-debug?job_id=${job_id}"
}

echo "==> SwitchX wardrobe smoke test — prompt ${PROMPT_INDEX}/4"
echo "    wardrobe: ${PROMPT:0:80}..."
echo "==> Submitting via CC switchx-restyle (mode=wardrobe, queue_only)..."

SUBMIT_JSON="$(submit)"
BEEBLE_JOB_ID="$(echo "$SUBMIT_JSON" | jq -r '.beeble_job_id // empty')"
if [[ -z "$BEEBLE_JOB_ID" ]]; then
  echo "error: no beeble_job_id in submit response" >&2
  echo "$SUBMIT_JSON" >&2
  exit 1
fi

jq -n \
  --arg submitted_at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  --arg prompt_index "$PROMPT_INDEX" \
  --arg prompt "$PROMPT" \
  --arg beeble_job_id "$BEEBLE_JOB_ID" \
  --arg source_video_url "$SOURCE_VIDEO_URL" \
  --arg wardrobe_ref_url "$WARDROBE_REF_URL" \
  --argjson submit_response "$SUBMIT_JSON" \
  '{submitted_at: $submitted_at, mode: "wardrobe", prompt_index: $prompt_index, prompt: $prompt, beeble_job_id: $beeble_job_id, source_video_url: $source_video_url, wardrobe_ref_url: $wardrobe_ref_url, submit_response: $submit_response}' \
  >"$JOB_FILE"

echo "==> Queued. beeble_job_id=$BEEBLE_JOB_ID"
echo "==> Keep-mask: $(echo "$SUBMIT_JSON" | jq -r '.generation_metadata.keep_mask_url // "n/a"')"
echo "==> Job metadata: $JOB_FILE"
echo "==> Polling every ${POLL_INTERVAL}s (30–90s typical, timeout ${POLL_TIMEOUT}s)..."

START_TS=$(date +%s)
while true; do
  ELAPSED=$(( $(date +%s) - START_TS ))
  if [[ "$ELAPSED" -ge "$POLL_TIMEOUT" ]]; then
    echo "error: poll timeout after ${POLL_TIMEOUT}s" >&2
    exit 1
  fi

  POLL_JSON="$(poll_once "$BEEBLE_JOB_ID" || true)"
  STATUS="$(echo "$POLL_JSON" | jq -r '.status // ""' 2>/dev/null || echo "")"
  RENDER_URL="$(echo "$POLL_JSON" | jq -r '.result.render // ""' 2>/dev/null || echo "")"

  echo "    status=$STATUS elapsed=${ELAPSED}s ($(date -u +%H:%M:%S)Z)"

  case "$(echo "$STATUS" | tr '[:upper:]' '[:lower:]')" in
    succeeded|completed|complete)
      if [[ -z "$RENDER_URL" || "$RENDER_URL" == "null" ]]; then
        echo "error: job succeeded but no result.render URL" >&2
        echo "$POLL_JSON" >&2
        exit 1
      fi
      TMP="$(mktemp)"
      jq \
        --arg completed_at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
        --arg output_video_url "$RENDER_URL" \
        '. + {completed_at: $completed_at, output_video_url: $output_video_url}' \
        "$JOB_FILE" >"$TMP" && mv "$TMP" "$JOB_FILE"
      echo "==> Complete."
      echo "==> Output video: $RENDER_URL"
      echo "==> Saved to $JOB_FILE"
      exit 0
      ;;
    failed|error|errored)
      echo "error: Beeble wardrobe job failed" >&2
      echo "$POLL_JSON" >&2
      exit 1
      ;;
  esac

  sleep "$POLL_INTERVAL"
done

#!/usr/bin/env bash
# SwitchX (Beeble) three-mode smoke test. Bypasses the Supabase Edge 150s sync
# wall the same way the Kling smoke test does: submit with queue_only=true, then
# poll /beeble-poll-debug client-side.
#
# THREE MODES
#   background <ref_url> <source_url> <prompt>
#       Swap BACKGROUND/scene only (Beeble alpha_mode=auto). ref_url = scene ref
#       (may be "-" / empty to use prompt alone). Proven path.
#
#   wardrobe <wardrobe_ref> <source_url> <prompt>
#       Swap CLOTHING only (Beeble alpha_mode=custom). The function builds a
#       per-frame SAM-3 body-parts alpha video (face/hands/hair/skin WHITE=preserve,
#       clothes BLACK=regenerate). wardrobe_ref drives the new costume.
#
#   both <wardrobe_ref> <bg_ref> <source_url> <prompt>
#       Wardrobe THEN background. Chained client-side here as two queue_only
#       single-mode calls (pass 1 wardrobe -> interim render -> pass 2 background)
#       so the smoke stays self-contained without standing up a callback server.
#       (Production drives mode:"both" server-side via callback_url.)
#       bg_ref may be "-" / empty to use prompt alone for the background pass.
#
# FLAGS
#   --probe-only   wardrobe only: validate polarity on a short clip before
#                  burning full-clip credits. Provide a pre-trimmed ~1s
#                  (~30-frame) clip as <source_url> (or set SWITCHX_PROBE_SOURCE_URL).
#                  Operator verifies the output: skin/face preserved + clothes
#                  swapped = correct polarity. If clothes preserved + skin
#                  regenerated = inverted -> supply a pre-inverted alphaUrl for the
#                  real run (in-function video invert is unsupported).
#
# ENV
#   SWITCHX_PROXY_SECRET   (required)  CC -> Edge Functions -> Secrets
#   CC_SUPABASE_URL        (optional)  default https://wkzwcfmvnwolgrdpnygc.supabase.co
#   SWITCHX_PROBE_SOURCE_URL (optional, --probe-only) pre-trimmed ~1s clip
#
# Writes result + metadata to scripts/.switchx-smoke-<mode>-job.json
#
# Usage:
#   ./scripts/switchx-smoke.sh background <ref|-> <source> "<prompt>"
#   ./scripts/switchx-smoke.sh wardrobe   <wardrobe_ref> <source> "<prompt>"
#   ./scripts/switchx-smoke.sh wardrobe --probe-only <wardrobe_ref> <source> "<prompt>"
#   ./scripts/switchx-smoke.sh both <wardrobe_ref> <bg_ref|-> <source> "<prompt>"

set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"
CC_BASE="${CC_SUPABASE_URL:-https://wkzwcfmvnwolgrdpnygc.supabase.co}/functions/v1"
POLL_INTERVAL=5
POLL_TIMEOUT=600

die() { echo "error: $*" >&2; exit 1; }
usage() {
  grep -E '^#( |$)' "$0" | sed -E 's/^# ?//'
  exit "${1:-1}"
}

[[ $# -lt 1 ]] && usage 1
MODE="$1"; shift

# Optional --probe-only flag (wardrobe only), may appear right after the mode.
PROBE_ONLY=0
if [[ "${1:-}" == "--probe-only" ]]; then
  PROBE_ONLY=1
  shift
fi

[[ -z "${SWITCHX_PROXY_SECRET:-}" ]] && die "set SWITCHX_PROXY_SECRET (CC -> Edge Functions -> Secrets)"

# normalize "-" / "" sentinels to empty
norm() { [[ "${1:-}" == "-" ]] && echo "" || echo "${1:-}"; }

# ---- POST a single switchx-restyle call (queue_only) -----------------------
# args: <json-body>  -> echoes the submit response JSON
submit() {
  curl -sf -X POST "${CC_BASE}/switchx-restyle" \
    -H "X-Proxy-Secret: ${SWITCHX_PROXY_SECRET}" \
    -H "Content-Type: application/json" \
    -d "$1"
}

poll_once() {
  curl -sf "${CC_BASE}/beeble-poll-debug?job_id=$1"
}

# ---- poll a beeble job id to completion, echo the render URL ----------------
poll_job() {
  local job_id="$1" label="$2"
  local start_ts elapsed poll_json status render
  start_ts=$(date +%s)
  while true; do
    elapsed=$(( $(date +%s) - start_ts ))
    [[ "$elapsed" -ge "$POLL_TIMEOUT" ]] && die "poll timeout after ${POLL_TIMEOUT}s ($label)"
    poll_json="$(poll_once "$job_id" || true)"
    status="$(echo "$poll_json" | jq -r '.status // ""' 2>/dev/null || echo "")"
    render="$(echo "$poll_json" | jq -r '.result.render // ""' 2>/dev/null || echo "")"
    echo "    [$label] status=$status elapsed=${elapsed}s ($(date -u +%H:%M:%S)Z)" >&2
    case "$(echo "$status" | tr '[:upper:]' '[:lower:]')" in
      succeeded|completed|complete)
        [[ -z "$render" || "$render" == "null" ]] && { echo "$poll_json" >&2; die "$label succeeded but no result.render"; }
        echo "$render"; return 0 ;;
      failed|error|errored)
        echo "$poll_json" >&2; die "$label job failed" ;;
    esac
    sleep "$POLL_INTERVAL"
  done
}

# ---- submit one queue_only job, echo its beeble_job_id ----------------------
submit_job() {
  local body="$1" label="$2" resp job_id
  resp="$(submit "$body")"
  job_id="$(echo "$resp" | jq -r '.beeble_job_id // empty')"
  [[ -z "$job_id" ]] && { echo "$resp" >&2; die "no beeble_job_id in $label submit response"; }
  echo "    [$label] queued beeble_job_id=$job_id" >&2
  echo "    [$label] alpha_url=$(echo "$resp" | jq -r '.generation_metadata.alpha_url // "n/a"')" >&2
  echo "$job_id"
}

case "$MODE" in
  background)
    [[ $# -lt 3 ]] && die "background needs: <ref|-> <source> <prompt>"
    REF="$(norm "$1")"; SOURCE="$2"; PROMPT="$3"
    JOB_FILE="${SCRIPT_DIR}/.switchx-smoke-background-job.json"
    echo "==> SwitchX BACKGROUND smoke"
    BODY="$(jq -n --arg url "$SOURCE" --arg prompt "$PROMPT" --arg ref "$REF" \
      '{sourceVideoUrl:$url, prompt:$prompt, mode:"background", queue_only:true}
       + (if $ref != "" then {referenceImageUrl:$ref} else {} end)')"
    echo "==> POST body:"; echo "$BODY" | jq .
    JOB_ID="$(submit_job "$BODY" "background")"
    RENDER="$(poll_job "$JOB_ID" "background")"
    jq -n --arg at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" --arg mode "background" \
      --arg job "$JOB_ID" --arg src "$SOURCE" --arg ref "$REF" --arg prompt "$PROMPT" --arg out "$RENDER" \
      '{completed_at:$at, mode:$mode, beeble_job_id:$job, source_video_url:$src, reference_image_url:$ref, prompt:$prompt, output_video_url:$out}' \
      > "$JOB_FILE"
    echo "==> Complete. output=$RENDER"
    echo "==> Saved $JOB_FILE"
    ;;

  wardrobe)
    [[ $# -lt 3 ]] && die "wardrobe needs: <wardrobe_ref> <source> <prompt>"
    WREF="$1"; SOURCE="$2"; PROMPT="$3"
    [[ -z "$WREF" || "$WREF" == "-" ]] && die "wardrobe requires a real wardrobe_ref (target outfit image URL)"
    if [[ "$PROBE_ONLY" -eq 1 ]]; then
      SOURCE="${SWITCHX_PROBE_SOURCE_URL:-$SOURCE}"
      JOB_FILE="${SCRIPT_DIR}/.switchx-smoke-wardrobe-probe-job.json"
      echo "==> SwitchX WARDROBE smoke (PROBE-ONLY: short clip for polarity check)"
      echo "    Verify output: skin/face preserved + clothes swapped = correct polarity."
    else
      JOB_FILE="${SCRIPT_DIR}/.switchx-smoke-wardrobe-job.json"
      echo "==> SwitchX WARDROBE smoke"
    fi
    BODY="$(jq -n --arg url "$SOURCE" --arg prompt "$PROMPT" --arg ref "$WREF" \
      '{sourceVideoUrl:$url, prompt:$prompt, mode:"wardrobe", wardrobeReferenceImageUrl:$ref, queue_only:true}')"
    echo "==> POST body:"; echo "$BODY" | jq .
    JOB_ID="$(submit_job "$BODY" "wardrobe")"
    RENDER="$(poll_job "$JOB_ID" "wardrobe")"
    jq -n --arg at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" --arg mode "wardrobe" --arg probe "$PROBE_ONLY" \
      --arg job "$JOB_ID" --arg src "$SOURCE" --arg ref "$WREF" --arg prompt "$PROMPT" --arg out "$RENDER" \
      '{completed_at:$at, mode:$mode, probe_only:($probe=="1"), beeble_job_id:$job, source_video_url:$src, wardrobe_ref_url:$ref, prompt:$prompt, output_video_url:$out}' \
      > "$JOB_FILE"
    echo "==> Complete. output=$RENDER"
    echo "==> Saved $JOB_FILE"
    ;;

  both)
    [[ $# -lt 4 ]] && die "both needs: <wardrobe_ref> <bg_ref|-> <source> <prompt>"
    WREF="$1"; BGREF="$(norm "$2")"; SOURCE="$3"; PROMPT="$4"
    [[ -z "$WREF" || "$WREF" == "-" ]] && die "both requires a real wardrobe_ref"
    JOB_FILE="${SCRIPT_DIR}/.switchx-smoke-both-job.json"
    echo "==> SwitchX BOTH smoke (client-chained: wardrobe -> background)"

    # pass 1: wardrobe
    BODY1="$(jq -n --arg url "$SOURCE" --arg prompt "$PROMPT" --arg ref "$WREF" \
      '{sourceVideoUrl:$url, prompt:$prompt, mode:"wardrobe", wardrobeReferenceImageUrl:$ref, queue_only:true}')"
    echo "==> Pass 1 POST body:"; echo "$BODY1" | jq .
    JOB1="$(submit_job "$BODY1" "pass1-wardrobe")"
    INTERIM="$(poll_job "$JOB1" "pass1-wardrobe")"
    echo "==> Pass 1 interim render: $INTERIM"

    # pass 2: background on the interim render
    BODY2="$(jq -n --arg url "$INTERIM" --arg prompt "$PROMPT" --arg ref "$BGREF" \
      '{sourceVideoUrl:$url, prompt:$prompt, mode:"background", queue_only:true}
       + (if $ref != "" then {referenceImageUrl:$ref} else {} end)')"
    echo "==> Pass 2 POST body:"; echo "$BODY2" | jq .
    JOB2="$(submit_job "$BODY2" "pass2-background")"
    FINAL="$(poll_job "$JOB2" "pass2-background")"

    jq -n --arg at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" --arg mode "both" \
      --arg j1 "$JOB1" --arg j2 "$JOB2" --arg src "$SOURCE" --arg wref "$WREF" --arg bgref "$BGREF" \
      --arg prompt "$PROMPT" --arg interim "$INTERIM" --arg out "$FINAL" \
      '{completed_at:$at, mode:$mode, wardrobe_job_id:$j1, background_job_id:$j2, source_video_url:$src, wardrobe_ref_url:$wref, background_ref_url:$bgref, prompt:$prompt, interim_video_url:$interim, output_video_url:$out}' \
      > "$JOB_FILE"
    echo "==> Complete. interim=$INTERIM"
    echo "==>           final=$FINAL"
    echo "==> Saved $JOB_FILE"
    ;;

  -h|--help|help)
    usage 0 ;;
  *)
    die "unknown mode '$MODE' (expected: background | wardrobe | both)" ;;
esac

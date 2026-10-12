#!/usr/bin/env bash
# Reproducible memory benchmark. Materialises the function at a git revision, runs it against the fake Google, and
# prints medians of N runs. Requires deno (2.x) on PATH, git, python3.
#   scripts/bench/gemini-memory/run.sh <git-rev|HEAD|worktree> <refs> <mode> [reps]
# Examples: run.sh 64c6c50 1 bytes   (main before #55: buffered)   run.sh HEAD 3 stream   (current)
set -euo pipefail
cd "$(dirname "$0")"
REV=${1:?git revision, HEAD, or worktree}; REFS=${2:-1}; MODE=${3:-stream}; REPS=${4:-5}
FN=supabase/functions/image-providers-gemini-generate
rm -rf impl && mkdir impl
if [ "$REV" = "worktree" ]; then cp ../../../$FN/*.ts impl/; else
  for f in $(git -C ../../.. ls-tree --name-only "$REV" -- "$FN/" | grep -v test); do git -C ../../.. show "$REV:$f" > "impl/$(basename "$f")"; done
fi
echo "impl=$REV files: $(ls impl | tr '\n' ' ')" >&2
deno run -A fake-google.ts > fake.log 2>&1 & SP=$!
for i in $(seq 1 50); do grep -q ready fake.log && break; sleep 0.2; done
trap 'kill $SP 2>/dev/null' EXIT
: > bench.err
for r in $(seq 1 "$REPS"); do deno run -A --v8-flags=--expose-gc bench.ts "$REFS" "$MODE" 2>>bench.err | grep '^{"refs'; done | python3 -c '
import json,sys,statistics as st
rows=[json.loads(l) for l in sys.stdin]
if not rows: sys.exit("no bench rows: see scripts/bench/gemini-memory/bench.err and fake.log")
def med(k): return st.median(r[k] for r in rows)
print(json.dumps({"rev":sys.argv[1],"refs":int(sys.argv[2]),"mode":sys.argv[3],"runs":len(rows),"ok":all(r["ok"] for r in rows),"errors":sorted({str(r["err"]) for r in rows if not r["ok"]}),
 "median_peakRssAboveBaseMB":med("peakRssAboveBaseMB"),"max_peakRssAboveBaseMB":max(r["peakRssAboveBaseMB"] for r in rows),
 "median_peakHeapExtAboveBaseMB":med("peakHeapExtAboveBaseMB"),"median_ms":med("ms"),
 "sampledPhases_firstRun":rows[0]["sampledPhases"]}))' "$REV" "$REFS" "$MODE"

#!/usr/bin/env bash
#
# Runs the complete "replicate Fecha 3 on a new date" simulation end to end,
# fase by fase, in the correct order (see plan.md in the IA-Claude repo for
# the full design). Each UI-driving fase gets its own Playwright video under
# output/videos/faseN/ — Playwright wipes its shared outputDir at the start
# of every invocation, so each fase MUST get a distinct --output, which this
# script handles for you.
#
# By default every run starts a brand-new competition date (never reuses or
# overwrites a previous run's date) — matches the real use case this was
# built for: pointing this at a restored production backup and replaying it
# repeatedly without ever colliding with an earlier run's data.
#
# Usage:
#   ./run-full-simulation.sh              # fresh competition date (default)
#   KEEP_STATE=1 ./run-full-simulation.sh # resume/rerun against the existing
#                                          # date in output/simulation-state.json
#
# On any phase failure, the script stops immediately and writes a report
# showing exactly how far it got and where to look (log file + video).

set -uo pipefail

# All paths below are absolute, derived from this script's own location, so
# they stay correct regardless of which directory later commands `cd` into
# (playwright.config.ts's own relative paths require running from the repo
# root, same as every command in plan.md).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SIM_REL="scripts/e2e-simulations"

OUTPUT_DIR="$SCRIPT_DIR/output"
VIDEOS_DIR="$OUTPUT_DIR/videos"
LOGS_DIR="$OUTPUT_DIR/logs"
REPORTS_DIR="$OUTPUT_DIR/reports"
STATE_FILE="$OUTPUT_DIR/simulation-state.json"
RUN_TAG="$(date -u +%Y-%m-%dT%H-%M-%S)"
REPORT_FILE="$REPORTS_DIR/report-$RUN_TAG.md"

mkdir -p "$VIDEOS_DIR" "$LOGS_DIR" "$REPORTS_DIR"

cd "$REPO_ROOT"
PW="npx playwright test --config=$SIM_REL/playwright.config.ts"

# ---------------------------------------------------------------------------
# Pre-flight: the local dev stack must already be running (this simulation
# drives the REAL local dev frontend/backend/DB, not the disposable Docker
# E2E stack — see config.ts's own header comment).
# ---------------------------------------------------------------------------
echo "== Pre-flight: checking local dev stack =="
MISSING=()
for c in rowing-federation-frontend rowing-federation-api rowing-federation-db; do
  if ! docker ps --format '{{.Names}}' | grep -qx "$c"; then
    MISSING+=("$c")
  fi
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "ERROR: missing container(s): ${MISSING[*]}"
  echo "Start the local dev stack (docker compose up, or whatever this repo uses) before running this."
  exit 1
fi
echo "  OK - frontend/api/db containers are up."
echo

if [ "${KEEP_STATE:-0}" != "1" ]; then
  echo "== Starting a FRESH competition date (default) =="
  echo "  Clearing competitionDateId/competitionDateName/submissionCodesByClubId/simulationTargetDate from $STATE_FILE"
  STATE_FILE="$STATE_FILE" node -e '
    const fs = require("fs");
    const path = process.env.STATE_FILE;
    let state = {};
    if (fs.existsSync(path)) state = JSON.parse(fs.readFileSync(path, "utf8"));
    delete state.competitionDateId;
    delete state.competitionDateName;
    delete state.submissionCodesByClubId;
    delete state.simulationTargetDate;
    fs.writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
  '
else
  echo "== KEEP_STATE=1 - resuming/rerunning against the existing date in $STATE_FILE =="
fi
echo

# ---------------------------------------------------------------------------
# Step bookkeeping for the final report.
# ---------------------------------------------------------------------------
declare -a STEP_NAMES=()
declare -a STEP_STATUS=()
declare -a STEP_DURATION=()
declare -a STEP_LOG=()
declare -a STEP_VIDEO=()
START_TIME=$(date +%s)

run_step() {
  local name="$1"; local log_name="$2"; local video_dir="$3"; shift 3
  local log_path="$LOGS_DIR/$log_name.log"
  echo "== $name =="
  local t0=$(date +%s)
  local status="PASS"
  "$@" >"$log_path" 2>&1 || status="FAIL"
  local t1=$(date +%s)
  tail -n 15 "$log_path" | sed 's/^/  /'
  STEP_NAMES+=("$name")
  STEP_STATUS+=("$status")
  STEP_DURATION+=("$((t1 - t0))s")
  STEP_LOG+=("$log_path")
  STEP_VIDEO+=("$video_dir")
  echo "  -> $status ($((t1 - t0))s), log: $log_path"
  echo
  if [ "$status" = "FAIL" ]; then
    write_report
    echo "STOPPED: $name failed. See $log_path for the full error, and $REPORT_FILE for the run report so far."
    exit 1
  fi
}

write_report() {
  local end_time=$(date +%s)
  local total=$((end_time - START_TIME))
  local comp_date_id
  comp_date_id="$(STATE_FILE="$STATE_FILE" node -e '
    const fs = require("fs");
    const path = process.env.STATE_FILE;
    const s = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
    console.log(s.competitionDateId || "(none yet)");
  ')"

  {
    echo "# Reporte de simulacion - replicar Fecha 3 en fecha nueva"
    echo
    echo "- Corrida: $RUN_TAG"
    echo "- Fecha de competencia creada: \`$comp_date_id\`"
    echo "- Duracion total: ${total}s"
    echo
    echo "## Casos de prueba (fases)"
    echo
    echo "| Fase | Estado | Duracion | Log | Video |"
    echo "|---|---|---|---|---|"
    for i in "${!STEP_NAMES[@]}"; do
      local video_note="-"
      if [ -n "${STEP_VIDEO[$i]}" ]; then
        local webm
        webm="$(find "${STEP_VIDEO[$i]}" -name '*.webm' 2>/dev/null | head -1)"
        video_note="${webm:-(sin video, script de preparacion)}"
      fi
      echo "| ${STEP_NAMES[$i]} | ${STEP_STATUS[$i]} | ${STEP_DURATION[$i]} | ${STEP_LOG[$i]} | $video_note |"
    done
    echo
    echo "## Videos por fase"
    echo
    find "$VIDEOS_DIR" -name '*.webm' 2>/dev/null | sort | sed 's/^/- /'
    echo
    echo "## Resumen de la comparacion final (Fase 7, si se llego a correr)"
    echo
    if [ -f "$LOGS_DIR/fase7.log" ]; then
      grep -E "Fecha 3 \(fuente\)|Fecha nueva|Diferencia|Public page|FINAL_RESULTS" "$LOGS_DIR/fase7.log" | sed 's/^/- /'
    else
      echo "(Fase 7 no llego a correr en esta corrida)"
    fi
  } > "$REPORT_FILE"

  echo "Reporte escrito en: $REPORT_FILE"
}

# ---------------------------------------------------------------------------
# Fase 0 / 3.5 prep - no UI, no video.
# ---------------------------------------------------------------------------
run_step "Fase 0.1 - extract-recipe"           "fase0.1" "" npx tsx "$SIM_REL/extract-recipe.ts"
run_step "Fase 0.2 - check-age-categories"     "fase0.2" "" npx tsx "$SIM_REL/check-age-categories.ts"
run_step "Fase 3.5 - check-novice-eligibility" "fase3.5" "" npx tsx "$SIM_REL/check-novice-eligibility.ts"

# ---------------------------------------------------------------------------
# Fases 1-5 - one video each.
# ---------------------------------------------------------------------------
run_step "Fase 1 - crear fecha + abrir inscripciones" "fase1" "$VIDEOS_DIR/fase1" \
  $PW "$SIM_REL/phase1-create-date.spec.ts" --output="$VIDEOS_DIR/fase1"

run_step "Fase 2 - usuarios y delegados" "fase2" "$VIDEOS_DIR/fase2" \
  $PW "$SIM_REL/phase2-create-users.spec.ts" --output="$VIDEOS_DIR/fase2"

run_step "Fase 3 - habilitar atletas 24h" "fase3" "$VIDEOS_DIR/fase3" \
  $PW "$SIM_REL/phase3-bulk-activate.spec.ts" --output="$VIDEOS_DIR/fase3"

run_step "Fase 4 - inscripciones (piloto + escalado)" "fase4" "$VIDEOS_DIR/fase4" \
  $PW "$SIM_REL/phase4-inscriptions-pilot.spec.ts" --timeout=3600000 --output="$VIDEOS_DIR/fase4"

run_step "Fase 5 - confirmacion, cierre, sorteo" "fase5" "$VIDEOS_DIR/fase5" \
  $PW "$SIM_REL/phase5-close-and-sorteo.spec.ts" --timeout=600000 --output="$VIDEOS_DIR/fase5"

# ---------------------------------------------------------------------------
# Results recipe depends on Fase 5's sorteo - no UI, no video.
# ---------------------------------------------------------------------------
run_step "Prep - extract-results-recipe" "fase5.5-prep" "" npx tsx "$SIM_REL/extract-results-recipe.ts"

# ---------------------------------------------------------------------------
# Fases 6-7 - one video each.
# ---------------------------------------------------------------------------
run_step "Fase 6 - competencia y resultados" "fase6" "$VIDEOS_DIR/fase6" \
  $PW "$SIM_REL/phase6-load-results.spec.ts" --timeout=3600000 --output="$VIDEOS_DIR/fase6"

run_step "Fase 7 - finalizar y comparar contra Fecha 3" "fase7" "$VIDEOS_DIR/fase7" \
  $PW "$SIM_REL/phase7-finalize.spec.ts" --timeout=180000 --output="$VIDEOS_DIR/fase7"

write_report
echo "== Simulacion completa. Reporte: $REPORT_FILE =="

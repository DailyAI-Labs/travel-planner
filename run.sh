#!/usr/bin/env bash
#
# Start the backend and the frontend together.
#
#   ./run.sh
#
# Ctrl-C stops both, and if either one dies the other is shut down too, so you
# never end up with half the app running.
#
# Written for bash 3.2, the version macOS ships: no associative arrays, no
# negative array indices, no `wait -n`.
#
# Environment:
#   BACKEND_PORT   default 8000
#   FRONTEND_PORT  default 3000
#   OPEN_BROWSER   set to 0 to stop the frontend opening a browser tab

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$ROOT/.venv"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
OPEN_BROWSER="${OPEN_BROWSER:-1}"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; OFF=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; OFF=''
fi

say()  { printf '%s==>%s %s\n' "$BOLD" "$OFF" "$*"; }
warn() { printf '%s==>%s %s\n' "$RED" "$OFF" "$*" >&2; }

BACKEND_PID=''
FRONTEND_PID=''
SHUTTING_DOWN=0

alive() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null
}

# Signal a process and everything below it. Depth matters: `npm start` runs
# react-scripts as a grandchild, and uvicorn's reloader spawns its own worker,
# so signalling only direct children leaves servers holding their ports.
kill_tree() {
  local sig="$1" pid="$2" child
  [ -n "$pid" ] || return 0
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$sig" "$child"
  done
  # On a polite stop, spare the line-tagger: it ends by itself once the server
  # closes the pipe, and killing it first truncates the server's parting
  # messages — uvicorn logs five lines on shutdown and only the first survived.
  # A forced stop kills everything, tagger included.
  if [ "$sig" = 'TERM' ]; then
    case "$(ps -o comm= -p "$pid" 2>/dev/null)" in
      *awk) return 0 ;;
    esac
  fi
  kill "-$sig" "$pid" 2>/dev/null || true
}

cleanup() {
  # Disarm first: shutting down must not re-enter this on a second Ctrl-C.
  trap - EXIT INT TERM
  SHUTTING_DOWN=1
  # A preflight failure exits before anything is running; announcing a
  # shutdown then only muddies the error the user actually needs to read.
  [ -n "$BACKEND_PID$FRONTEND_PID" ] || return 0
  say 'Shutting down…'
  # Take the jobs off the table so bash does not narrate each kill; everything
  # below is signalled by PID, so nothing depends on the job table. Bash may
  # still print a "Terminated" line anyway — noise, not a failure.
  disown -a 2>/dev/null || true
  kill_tree TERM "$FRONTEND_PID"
  kill_tree TERM "$BACKEND_PID"

  # Give them a moment to close down, then insist. A bare `wait` here would
  # hang forever on anything that ignores SIGTERM.
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! alive "$BACKEND_PID" && ! alive "$FRONTEND_PID"; then
      break
    fi
    sleep 0.5
  done

  # Whatever is still up has had its chance.
  kill_tree KILL "$FRONTEND_PID"
  kill_tree KILL "$BACKEND_PID"

  # The backend logs its own goodbye; react-scripts exits without a word. Say
  # it for both, so neither side is left looking like it might still be up.
  alive "$BACKEND_PID"  || say 'backend stopped'
  alive "$FRONTEND_PID" || say 'frontend stopped'
}

# A handler for a termination signal must exit rather than return. Returning
# hands control back to the interrupted command, and bash 3.2 then spins in
# signal handling instead of unwinding — the script stays alive with every
# child already gone.
on_signal() {
  cleanup
  exit "$1"
}

trap cleanup EXIT
trap 'on_signal 130' INT   # 128 + SIGINT
trap 'on_signal 143' TERM  # 128 + SIGTERM

backend_healthy() {
  curl -fsS "http://localhost:$BACKEND_PORT/health" >/dev/null 2>&1
}

# --- preflight ------------------------------------------------------------

# Stopping the two servers needs POSIX signals and process groups, which
# Windows lacks — say so here rather than failing on a missing tool below.
missing=''
for tool in lsof pgrep ps curl awk npm python3; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  warn "Missing required command(s):$missing"
  warn 'run.sh needs Linux, macOS or WSL. On native Windows (including Git'
  warn 'Bash) start the two halves separately — see the README.'
  exit 1
fi

for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if lsof -ti tcp:"$port" >/dev/null 2>&1; then
    warn "Port $port is already in use. Free it with: lsof -ti:$port | xargs kill"
    exit 1
  fi
done

if [ ! -x "$VENV/bin/python" ]; then
  say 'Creating the Python virtualenv…'
  python3 -m venv "$VENV"
fi

if ! "$VENV/bin/python" -c 'import uvicorn, ortools, geopy' >/dev/null 2>&1; then
  say 'Installing backend dependencies (first run only)…'
  "$VENV/bin/pip" install -q -r "$ROOT/backend/requirements.txt"
  "$VENV/bin/pip" install -q -e "$ROOT/backend"
fi

if [ ! -f "$ROOT/backend/.env" ]; then
  say 'Creating backend/.env from the example…'
  cp "$ROOT/backend/.env.example" "$ROOT/backend/.env"
fi

if [ ! -d "$ROOT/frontend/node_modules" ]; then
  say 'Installing frontend dependencies (first run only)…'
  npm --prefix "$ROOT/frontend" install
fi

# --- backend --------------------------------------------------------------

say "Starting the backend on http://localhost:$BACKEND_PORT"
cd "$ROOT"

# Tag each line so both logs can share one terminal readably.
(
  PORT="$BACKEND_PORT" \
  CORS_ORIGINS="http://localhost:$FRONTEND_PORT" \
  "$VENV/bin/python" "$ROOT/backend/main.py" 2>&1 |
    awk '{ printf "backend  | %s\n", $0; fflush() }'
) &
BACKEND_PID=$!

# Hold the frontend back until the API answers, so it does not load showing
# "backend offline" and leave you wondering why.
for _ in $(seq 1 60); do
  backend_healthy && break
  if ! alive "$BACKEND_PID"; then
    warn 'The backend exited during start-up. See its output above.'
    exit 1
  fi
  sleep 0.5
done

if ! backend_healthy; then
  warn "The backend did not answer on port $BACKEND_PORT within 30s."
  exit 1
fi
printf '%s==>%s %sbackend is up%s\n' "$BOLD" "$OFF" "$GREEN" "$OFF"

# --- frontend -------------------------------------------------------------

# react-scripts prints nothing at all when stopped, so on shutdown you see only
# the backend's parting messages — the dev server's own doing, not output lost.
say "Starting the frontend on http://localhost:$FRONTEND_PORT"
BROWSER_SETTING=''
[ "$OPEN_BROWSER" = '1' ] || BROWSER_SETTING='none'

(
  PORT="$FRONTEND_PORT" \
  BROWSER="$BROWSER_SETTING" \
  REACT_APP_API_URL="http://localhost:$BACKEND_PORT" \
  npm --prefix "$ROOT/frontend" start 2>&1 |
    awk '{ printf "frontend | %s\n", $0; fflush() }'
) &
FRONTEND_PID=$!

printf '\n%sBoth running. Press Ctrl-C to stop them.%s\n\n' "$DIM" "$OFF"

# bash 3.2 has no `wait -n`, so poll until either side goes away.
while alive "$BACKEND_PID" && alive "$FRONTEND_PID"; do
  sleep 1
done

# Only worth reporting when something fell over on its own; a deliberate
# Ctrl-C has already said what it is doing.
if [ "$SHUTTING_DOWN" = '0' ]; then
  alive "$BACKEND_PID" || warn 'The backend stopped unexpectedly.'
  alive "$FRONTEND_PID" || warn 'The frontend stopped unexpectedly.'
fi

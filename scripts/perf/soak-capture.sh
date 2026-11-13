#!/bin/sh
# Privileged half of `profile:soak`: packet and exec capture that needs root.
# Run with sudo, beside `bun run profile:soak`, into the same directory:
#
#   sudo sh scripts/perf/soak-capture.sh <output dir> <minutes>
#
# Writes into <output dir>, owned by the user who ran sudo:
#   lo0.txt       packet headers and request lines (method, path, user agent)
#                 on loopback to the OpenChamber server and to its OpenCode,
#                 which is where server-to-OpenCode traffic becomes visible.
#                 Every other header line, auth included, is dropped before it
#                 reaches the disk, and token-like query values are redacted;
#   external.txt  connection openings and DNS traffic on every interface, with
#                 the process behind each packet (pktap `-k`);
#   exec.jsonl    every process started on the machine (eslogger), when the
#                 terminal has Full Disk Access; without it the file stays empty
#                 and the ps sampler's spawn list is the only source.
set -u

OUT="${1:?output directory}"
MINUTES="${2:?minutes}"
OWNER="${SUDO_USER:-$(id -un)}"
mkdir -p "$OUT"
# profile:soak writes into the same directory as the user; a directory this
# root script created first would be root's.
chown "$OWNER" "$OUT"
umask 077

APP_PID=$(ps -axo pid=,command= | awk '$2 ~ /\/Contents\/MacOS\/OpenChamber$/ {print $1; exit}')
if [ -z "$APP_PID" ]; then
  echo "OpenChamber is not running" >&2
  exit 1
fi
OPENCODE_PID=$(ps -axo pid=,ppid=,command= | awk -v app="$APP_PID" '$2 == app && /opencode serve/ {print $1; exit}')
# The main process also listens on the debugging port; the server port is the
# one the desktop settings name.
OWNER_HOME=$(eval echo "~$OWNER")
SERVER_PORT=$(sed -n 's/.*"desktopLocalPort": *\([0-9]*\).*/\1/p' "$OWNER_HOME/.config/openchamber/settings.json" 2>/dev/null | head -n 1)
OPENCODE_PORT=$(lsof -nP -a -p "$OPENCODE_PID" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {sub(/.*:/, "", $9); print $9; exit}')
if [ -z "$SERVER_PORT" ] || [ -z "$OPENCODE_PORT" ]; then
  echo "Could not find the server port ($SERVER_PORT) or the OpenCode port ($OPENCODE_PORT)" >&2
  exit 1
fi
if ! lsof -nP -a -p "$APP_PID" -iTCP:"$SERVER_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "The app does not listen on desktopLocalPort $SERVER_PORT" >&2
  exit 1
fi
printf '{"appPid":%s,"opencodePid":%s,"serverPort":%s,"opencodePort":%s,"startedAt":%s}\n' \
  "$APP_PID" "$OPENCODE_PID" "$SERVER_PORT" "$OPENCODE_PORT" "$(date +%s)000" > "$OUT/capture.json"
echo "app $APP_PID, server port $SERVER_PORT, OpenCode $OPENCODE_PID on port $OPENCODE_PORT; recording $MINUTES min"

FIFO=""
PIDS=""
cleanup() {
  [ -n "$PIDS" ] && kill $PIDS 2>/dev/null
  wait 2>/dev/null
  rm -f "$FIFO"
  chown "$OWNER" "$OUT"/* 2>/dev/null
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Raw packets go through a FIFO so tcpdump's own pid is known for cleanup;
# only the filtered lines reach the disk.
FIFO="$OUT/.lo0.fifo"
rm -f "$FIFO"
mkfifo "$FIFO"
LC_ALL=C grep --line-buffered -aE '^[0-9]+\.[0-9]+ IP|(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /|^[Uu]ser-[Aa]gent:' < "$FIFO" \
  | LC_ALL=C sed -l -E 's/((token|password|secret|auth|key|code)=)[^& ]*/\1REDACTED/gi' > "$OUT/lo0.txt" &
PIDS="$PIDS $!"
tcpdump -i lo0 -n -tt -l -A -s 1024 "tcp dst port $SERVER_PORT or tcp dst port $OPENCODE_PORT" > "$FIFO" 2>"$OUT/lo0.err" &
PIDS="$PIDS $!"
tcpdump -i pktap,all -k NP -n -tt -l "(tcp[tcpflags] & tcp-syn != 0 and not net 127.0.0.0/8 and not ip6 host ::1) or udp port 53" > "$OUT/external.txt" 2>"$OUT/external.err" &
PIDS="$PIDS $!"
eslogger exec > "$OUT/exec.jsonl" 2>"$OUT/exec.err" &
PIDS="$PIDS $!"

# The files are root's and private until handed over; profile:soak may finish
# and read them before this script does.
sleep 1
chown "$OWNER" "$OUT"/* 2>/dev/null

# A foreground sleep would hold off the INT/TERM trap until it ends; `wait`
# returns as soon as a signal arrives.
sleep $((MINUTES * 60)) &
PIDS="$PIDS $!"
wait $!
echo "done: $OUT"

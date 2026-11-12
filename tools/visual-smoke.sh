#!/usr/bin/env bash
# Offline Linux/Wayland smoke test. All remote operations target our private Kitty.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-"$root/artifacts/visual-smoke"}
mkdir -p "$out"
out=$(cd "$out" && pwd)
work=$(mktemp -d /tmp/pi-illustrated-smoke-XXXXXX)
socket="unix:$work/kitty.sock"
kitty=$(command -v kitty)
kitten=$(command -v kitten)
node=$(command -v node)
cli=${PI_CLI:-"$root/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"}
: "${XDG_RUNTIME_DIR:?Requires a Wayland desktop}"
: "${WAYLAND_DISPLAY:?Requires a Wayland desktop}"
mkdir -p "$work"/{home,config,cache,data,pi}
remote() { "$kitten" @ --to "$socket" --use-password never "$@"; }
cleanup() {
  if [ -S "$work/kitty.sock" ]; then remote close-window --match all >/dev/null 2>&1 || true; fi
  if [ -n "${pid:-}" ]; then wait "$pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
env -i PATH="$PATH" HOME="$work/home" XDG_CONFIG_HOME="$work/config" \
  XDG_CACHE_HOME="$work/cache" XDG_DATA_HOME="$work/data" \
  XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" WAYLAND_DISPLAY="$WAYLAND_DISPLAY" LANG=C.UTF-8 \
  PI_CODING_AGENT_DIR="$work/pi" PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  PI_BETTER_RENDER_FONT_DOWNLOAD=0 PI_BETTER_RENDER_MERMAID_INSTALL=0 \
  "$kitty" --config NONE --start-as=hidden --listen-on "$socket" \
  --title pi-illustrated-isolated --directory "$root" \
  -o allow_remote_control=socket-only -o linux_display_server=wayland \
  -o shell_integration=disabled -o remember_window_size=no \
  -o initial_window_width=110c -o initial_window_height=54c \
  -o background_opacity=1 -o background='#111111' -o foreground='#eeeeee' \
  "$node" "$cli" --no-session --no-tools --no-extensions --no-skills \
  --no-prompt-templates --no-themes --use-theme dark \
  -e "$root/src/index.ts" -e "$root/tools/visual-fixture.ts" \
  >"$work/kitty.log" 2>&1 < /dev/null &
pid=$!
for _ in {1..40}; do
  [ -S "$work/kitty.sock" ] && break
  kill -0 "$pid" 2>/dev/null || { printf 'Kitty exited; see %s\n' "$work/kitty.log"; exit 1; }
  sleep 0.1
done
sleep 2
command_in_pi() {
  remote send-text "$1"
  sleep 0.2
  remote send-key enter
  sleep 1
}
capture() {
  sleep 0.3
  # A hidden Kitty has no compositor frame loop. Let its first screenshot frame
  # upload newly decoded image textures, then capture the following frame.
  remote screenshot "$work/$1-first-frame.png" >/dev/null
  sleep 0.1
  remote screenshot "$out/$1.png"
}
command_in_pi /visual-fixture
sleep 1
remote send-key ctrl+home
capture wide
remote send-key page_down
capture scrolled
remote resize-os-window --unit cells --width 64 --height 44
capture narrow
command_in_pi '/visual-fixture light'
remote set-colors background='#ffffff' foreground='#172b4d'
capture light
printf 'Screenshots: %s\nPrivate test logs: %s\n' "$out" "$work"

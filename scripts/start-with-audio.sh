#!/usr/bin/env bash
# Boot script for the Linux/EC2 CallingBot service.
#
# Sets up:
#   - PulseAudio loopback sinks for capture (zoom_sink) and a virtual mic (zoom_mic_sink)
#   - A low-volume ambient noise stream into the virtual mic so Zoom WebRTC
#     sees a non-silent microphone (helps reduce "looks like a bot" risk)
#   - Optional v4l2loopback virtual camera that loops an mp4/png so Zoom
#     thinks the participant has a real webcam
#   - Xvfb display for headed Chromium
#
# Everything is best-effort: missing kernel modules or media files just disable
# that piece — Zoom still works in audio-only mode.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS_DIR="${CALLINGBOT_ASSETS_DIR:-$ROOT_DIR/assets}"
STATE_DIR="${CALLINGBOT_STATE_DIR:-$ROOT_DIR/state}"
mkdir -p "$ASSETS_DIR" "$STATE_DIR"

log() { echo "[start-with-audio] $*"; }

# Match only real ffmpeg processes for a given identifier, not the script
# that's looking for them. Without this guard, `pgrep -f ambient_zoom_mic`
# matches start-with-audio.sh's own command line during startup and
# falsely reports "already running" while no ffmpeg is actually live.
is_ffmpeg_running() {
  local identifier="$1"
  pgrep -fa ffmpeg 2>/dev/null | grep -q "$identifier"
}

# Spawn a watchdog outside the systemd service cgroup so it survives
# `systemctl restart`. systemd-run --user --scope places it in its own
# transient scope unit; fall back to setsid + nohup if systemd-run is
# unavailable. Either way, KillMode=control-group on callingbot.service
# can no longer reap the watchdog.
spawn_detached() {
  local name="$1"
  shift
  if command -v systemd-run >/dev/null 2>&1; then
    systemd-run --user --quiet --scope --unit="${name}-$(date +%s)" \
      --collect \
      bash -c "$*" >/dev/null 2>&1 &
  else
    setsid nohup bash -c "$*" >/dev/null 2>&1 < /dev/null &
    disown 2>/dev/null || true
  fi
}

# ---------------- PulseAudio ----------------
pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1 || true

if ! pactl list short sinks | awk '{print $2}' | grep -qx 'zoom_sink'; then
  pactl load-module module-null-sink sink_name=zoom_sink sink_properties=device.description=ZoomSink >/dev/null
fi

if ! pactl list short sinks | awk '{print $2}' | grep -qx 'zoom_mic_sink'; then
  pactl load-module module-null-sink sink_name=zoom_mic_sink sink_properties=device.description=ZoomSilentMic >/dev/null
fi

if ! pactl list short sources | awk '{print $2}' | grep -qx 'zoom_mic_source'; then
  pactl load-module module-virtual-source source_name=zoom_mic_source master=zoom_mic_sink.monitor source_properties=device.description=ZoomSilentMicSource >/dev/null || true
fi

ZOOM_MIC_SOURCE=zoom_mic_sink.monitor
if pactl list short sources | awk '{print $2}' | grep -qx 'zoom_mic_source'; then
  ZOOM_MIC_SOURCE=zoom_mic_source
fi

pactl set-default-sink zoom_sink >/dev/null
pactl set-default-source "$ZOOM_MIC_SOURCE" >/dev/null

# ---------------- Ambient mic noise ----------------
# Stream very low-volume brown noise into zoom_mic_sink so Zoom WebRTC's
# voice-activity / "is there a microphone?" check sees a non-silent device.
# Volume is configurable via ZOOM_AMBIENT_AMPLITUDE (default 0.004, ~ -48 dBFS).
#
# The ffmpeg input is *infinite* (no `duration=` set on anoisesrc, and the
# file path branch uses `-stream_loop -1`). On top of that we wrap each
# ffmpeg invocation in a watchdog loop so that any crash/disconnect is
# auto-respawned after a short backoff. The watchdog process itself is
# tagged `ambient_zoom_mic_watchdog` so pgrep can detect either the
# watchdog or the running ffmpeg.
AMBIENT_AMPLITUDE="${ZOOM_AMBIENT_AMPLITUDE:-0.004}"
AMBIENT_FILE="${ZOOM_AMBIENT_FILE:-}"
ENABLE_AMBIENT="${ZOOM_ENABLE_AMBIENT_MIC:-true}"
AMBIENT_RESPAWN_DELAY="${ZOOM_AMBIENT_RESPAWN_DELAY:-3}"

if [ "$ENABLE_AMBIENT" = "true" ]; then
  if is_ffmpeg_running "ambient_zoom_mic"; then
    log "ambient mic ffmpeg already running"
  else
    if [ -n "$AMBIENT_FILE" ] && [ -f "$AMBIENT_FILE" ]; then
      log "starting ambient mic watchdog from file: $AMBIENT_FILE"
      AMBIENT_INPUT_ARGS="-re -stream_loop -1 -i \"$AMBIENT_FILE\" -filter:a volume=${AMBIENT_AMPLITUDE}"
    else
      log "starting ambient mic watchdog from brown noise (amplitude=${AMBIENT_AMPLITUDE})"
      # No `duration=` ⇒ infinite source. Watchdog also respawns on crash.
      AMBIENT_INPUT_ARGS="-f lavfi -i anoisesrc=color=brown:amplitude=${AMBIENT_AMPLITUDE}"
    fi
    spawn_detached "callingbot-ambient" "
      export PULSE_SINK=zoom_mic_sink
      # ambient_zoom_mic_watchdog (identifier for pgrep)
      while true; do
        ffmpeg -hide_banner -loglevel error ${AMBIENT_INPUT_ARGS} \
          -ac 1 -ar 48000 \
          -f pulse -device zoom_mic_sink ambient_zoom_mic
        ec=\$?
        echo \"[ambient_zoom_mic_watchdog] ffmpeg exited with \$ec, respawning in ${AMBIENT_RESPAWN_DELAY}s\" >&2
        sleep ${AMBIENT_RESPAWN_DELAY}
      done
    "
  fi
fi

# ---------------- v4l2loopback virtual camera ----------------
# If v4l2loopback kernel module is available, create /dev/videoN and loop
# either a configured video/image into it so Zoom sees a webcam.
ENABLE_CAMERA="${ZOOM_ENABLE_VIRTUAL_CAMERA:-true}"
CAMERA_DEVICE="${ZOOM_VIRTUAL_CAMERA:-/dev/video10}"
CAMERA_LABEL="${ZOOM_VIRTUAL_CAMERA_LABEL:-ZoomBotCam}"
CAMERA_NUMBER="${CAMERA_DEVICE##*video}"
CAMERA_SOURCE_FILE="${ZOOM_VIRTUAL_CAMERA_FILE:-}"
CAMERA_FALLBACK_IMAGE="${ZOOM_VIRTUAL_CAMERA_IMAGE:-$ASSETS_DIR/bot-camera.png}"

if [ "$ENABLE_CAMERA" = "true" ]; then
  if [ ! -e "$CAMERA_DEVICE" ]; then
    if lsmod | grep -q '^v4l2loopback'; then
      log "v4l2loopback already loaded but $CAMERA_DEVICE missing — leaving as-is"
    elif command -v modprobe >/dev/null 2>&1; then
      log "trying to modprobe v4l2loopback (sudo, video_nr=$CAMERA_NUMBER)"
      sudo -n modprobe v4l2loopback \
        devices=1 \
        video_nr="$CAMERA_NUMBER" \
        card_label="$CAMERA_LABEL" \
        exclusive_caps=1 \
        >/dev/null 2>&1 || log "modprobe v4l2loopback failed (need sudo + package). Camera will be disabled."
    fi
  fi

  if [ -e "$CAMERA_DEVICE" ]; then
    if is_ffmpeg_running "v2l_zoom_cam"; then
      log "virtual camera ffmpeg already running"
    else
      CAMERA_RESPAWN_DELAY="${ZOOM_CAMERA_RESPAWN_DELAY:-3}"
      CAMERA_INPUT_ARGS=""
      if [ -n "$CAMERA_SOURCE_FILE" ] && [ -f "$CAMERA_SOURCE_FILE" ]; then
        log "starting virtual camera watchdog from $CAMERA_SOURCE_FILE -> $CAMERA_DEVICE"
        CAMERA_INPUT_ARGS="-re -stream_loop -1 -i \"$CAMERA_SOURCE_FILE\" -vf scale=1280:720,format=yuv420p"
      elif [ -f "$CAMERA_FALLBACK_IMAGE" ]; then
        log "starting virtual camera watchdog from still image $CAMERA_FALLBACK_IMAGE -> $CAMERA_DEVICE"
        CAMERA_INPUT_ARGS="-loop 1 -i \"$CAMERA_FALLBACK_IMAGE\" -vf scale=1280:720,format=yuv420p -r 15"
      else
        log "no camera source configured (set ZOOM_VIRTUAL_CAMERA_FILE or place $CAMERA_FALLBACK_IMAGE)"
      fi
      if [ -n "$CAMERA_INPUT_ARGS" ]; then
        spawn_detached "callingbot-camera" "
          # v2l_zoom_cam_watchdog (identifier for pgrep)
          while true; do
            ffmpeg -hide_banner -loglevel error ${CAMERA_INPUT_ARGS} \
              -f v4l2 \"${CAMERA_DEVICE}\" \
              -metadata title=v2l_zoom_cam
            ec=\$?
            echo \"[v2l_zoom_cam_watchdog] ffmpeg exited with \$ec, respawning in ${CAMERA_RESPAWN_DELAY}s\" >&2
            sleep ${CAMERA_RESPAWN_DELAY}
          done
        "
      fi
    fi
  else
    log "virtual camera disabled: $CAMERA_DEVICE not available"
  fi
fi

# ---------------- Environment for Node app ----------------
export PULSE_SINK="${PULSE_SINK:-zoom_sink}"
export PULSE_SOURCE="${PULSE_SOURCE:-$ZOOM_MIC_SOURCE}"
export AUDIO_INPUT_DEVICE="${AUDIO_INPUT_DEVICE:-zoom_sink.monitor}"
export ZOOM_HEADLESS="${ZOOM_HEADLESS:-false}"
export ZOOM_SILENT_MIC_SECONDS="${ZOOM_SILENT_MIC_SECONDS:-28800}"
export ZOOM_USE_FAKE_MIC_FILE="${ZOOM_USE_FAKE_MIC_FILE:-false}"
export ZOOM_VIRTUAL_CAMERA="${ZOOM_VIRTUAL_CAMERA:-$CAMERA_DEVICE}"

exec xvfb-run -a -s "-screen 0 1280x720x24" npm start

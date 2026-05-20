#!/usr/bin/env bash
set -euo pipefail

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

export PULSE_SINK="${PULSE_SINK:-zoom_sink}"
export PULSE_SOURCE="${PULSE_SOURCE:-$ZOOM_MIC_SOURCE}"
export AUDIO_INPUT_DEVICE="${AUDIO_INPUT_DEVICE:-zoom_sink.monitor}"
export ZOOM_HEADLESS="${ZOOM_HEADLESS:-false}"
export ZOOM_SILENT_MIC_SECONDS="${ZOOM_SILENT_MIC_SECONDS:-28800}"
export ZOOM_USE_FAKE_MIC_FILE="${ZOOM_USE_FAKE_MIC_FILE:-false}"

exec xvfb-run -a -s "-screen 0 1280x720x24" npm start

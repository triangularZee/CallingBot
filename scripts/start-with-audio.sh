#!/usr/bin/env bash
set -euo pipefail

pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1 || true

if ! pactl list short sinks | awk '{print $2}' | grep -qx 'zoom_sink'; then
  pactl load-module module-null-sink sink_name=zoom_sink sink_properties=device.description=ZoomSink >/dev/null
fi

if ! pactl list short sinks | awk '{print $2}' | grep -qx 'zoom_mic_sink'; then
  pactl load-module module-null-sink sink_name=zoom_mic_sink sink_properties=device.description=ZoomSilentMic >/dev/null
fi

pactl set-default-sink zoom_sink >/dev/null
pactl set-default-source zoom_mic_sink.monitor >/dev/null

export PULSE_SINK="${PULSE_SINK:-zoom_sink}"
export PULSE_SOURCE="${PULSE_SOURCE:-zoom_mic_sink.monitor}"
export AUDIO_INPUT_DEVICE="${AUDIO_INPUT_DEVICE:-zoom_sink.monitor}"
export ZOOM_HEADLESS="${ZOOM_HEADLESS:-false}"

exec xvfb-run -a -s "-screen 0 1280x720x24" npm start

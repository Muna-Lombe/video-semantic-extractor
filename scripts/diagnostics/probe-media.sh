#!/usr/bin/env sh
# @type script
# @purpose Capture reproducible container, stream, frame timestamp, and tool-version evidence.
set -eu

if [ "$#" -ne 2 ]; then
    printf 'Usage: %s INPUT_VIDEO OUTPUT_DIRECTORY\n' "$0" >&2
    exit 2
fi

input=$1
output=$2
mkdir -p "$output"

ffmpeg -version > "$output/ffmpeg-version.txt"
ffprobe -version > "$output/ffprobe-version.txt"
ffprobe -v error -show_format -show_streams -of json "$input" > "$output/media.json"
ffprobe -v error -select_streams v:0 \
    -show_entries frame=best_effort_timestamp,best_effort_timestamp_time,pts,pts_time,pkt_dts,pkt_dts_time,key_frame,pict_type \
    -of csv "$input" > "$output/frame-timestamps.csv"

printf 'Wrote media probe artifacts to %s\n' "$output"

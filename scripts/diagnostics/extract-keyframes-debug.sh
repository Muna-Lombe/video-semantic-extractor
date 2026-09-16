#!/usr/bin/env sh
# @type script
# @purpose Retain scene-selected frames and timestamp logs for keyframe root-cause analysis.
set -eu

if [ "$#" -ne 2 ]; then
    printf 'Usage: %s INPUT_VIDEO OUTPUT_DIRECTORY\n' "$0" >&2
    exit 2
fi

input=$1
output=$2
frames="$output/frames"
filter_time_base_frames="$output/filter-time-base-frames"
mkdir -p "$frames" "$filter_time_base_frames"
rm -f "$frames"/frame_*.jpg "$filter_time_base_frames"/frame_*.jpg

ffmpeg -v info -y -i "$input" \
    -vf "select='eq(n,0)+gt(scene,0.3)',settb=AVTB,showinfo" \
    -fps_mode vfr -frame_pts 1 \
    "$frames/frame_%06d_%013d.jpg" \
    2> "$output/showinfo.log"

find "$frames" -maxdepth 1 -type f -name 'frame_*.jpg' -printf '%f\n' \
    | sort > "$output/frame-filenames.txt"

ffmpeg -v info -y -i "$input" \
    -vf "select='eq(n,0)+gt(scene,0.3)',settb=AVTB,showinfo" \
    -fps_mode vfr -enc_time_base filter -frame_pts 1 \
    "$filter_time_base_frames/frame_%06d_%013d.jpg" \
    2> "$output/filter-time-base-showinfo.log"

find "$filter_time_base_frames" -maxdepth 1 -type f -name 'frame_*.jpg' -printf '%f\n' \
    | sort > "$output/filter-time-base-frame-filenames.txt"

printf 'Wrote keyframe debug artifacts to %s\n' "$output"

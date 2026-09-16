#!/usr/bin/env sh
# @type script
# @purpose Generate a deterministic audiovisual fixture with timed scene and text changes.
set -eu

output=${1:-/tmp/video-capsule-diagnostic.mp4}
mkdir -p "$(dirname -- "$output")"

font=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
if [ ! -f "$font" ]; then
    printf 'Required diagnostic font is missing: %s\n' "$font" >&2
    exit 1
fi

ffmpeg -v error -y \
    -f lavfi -i "color=c=0x183153:s=360x640:r=10:d=9" \
    -f lavfi -i "sine=frequency=440:sample_rate=16000:duration=9" \
    -vf "drawbox=x=0:y=0:w=iw:h=ih:color=0xF4F1DE:t=fill:enable='between(t,3,5.999)',drawbox=x=0:y=0:w=iw:h=ih:color=0xE85D04:t=fill:enable='gte(t,6)',drawtext=fontfile=${font}:text='WELCOME':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=120:enable='lt(t,3)',drawtext=fontfile=${font}:text='SHOP NOW':fontcolor=black:fontsize=34:x=(w-text_w)/2:y=340:enable='between(t,3,5.999)',drawtext=fontfile=${font}:text='15 OFF':fontcolor=white:fontsize=38:x=(w-text_w)/2:y=325:enable='gte(t,6)'" \
    -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$output"

printf 'Created %s\n' "$output"

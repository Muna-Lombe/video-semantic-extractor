#!/usr/bin/env sh
set -eu

missing=0

check_command() {
    if command -v "$1" >/dev/null 2>&1; then
        printf 'ok: %s -> %s\n' "$1" "$(command -v "$1")"
    else
        printf 'missing: %s\n' "$1" >&2
        missing=1
    fi
}

check_command python3
check_command ffprobe
check_command ffmpeg

if [ "${1:-}" = "docker" ]; then
    check_command docker
elif [ "${1:-}" = "cloudflare" ]; then
    check_command docker
    check_command node
    check_command npm
fi

if [ "$missing" -ne 0 ]; then
    printf '%s\n' 'Install the missing system tools before installing Python dependencies.' >&2
    exit 1
fi

printf '%s\n' 'System requirements are available.'
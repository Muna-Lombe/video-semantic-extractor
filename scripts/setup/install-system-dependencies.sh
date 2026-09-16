#!/usr/bin/env sh
# @type script
# @purpose Install host media and OCR tools required by local diagnostics.
set -eu

if [ "$(id -u)" -ne 0 ]; then
    printf '%s\n' 'Run this script as root so apt can install packages.' >&2
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --no-install-recommends --yes \
    ca-certificates \
    ffmpeg \
    python3-venv \
    tesseract-ocr \
    tesseract-ocr-eng

command -v ffmpeg
command -v ffprobe
command -v tesseract
ffmpeg -version | sed -n '1p'
ffprobe -version | sed -n '1p'
tesseract --version | sed -n '1p'

#!/usr/bin/env sh
# @type script
# @purpose Run full local capsule generation with the production-equivalent Python environment.
set -eu

if [ "$#" -ne 2 ]; then
    printf 'Usage: %s INPUT_VIDEO OUTPUT_JSON\n' "$0" >&2
    exit 2
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
python_bin=${PYTHON_BIN:-"$repo_root/.venv/bin/python"}

if [ ! -x "$python_bin" ]; then
    printf 'Missing local environment: run scripts/setup/create-local-environment.sh\n' >&2
    exit 1
fi

"$python_bin" -m video_semantic_extractor.cli "$1" --output "$2"

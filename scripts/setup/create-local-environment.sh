#!/usr/bin/env sh
# @type script
# @purpose Create a Python 3.12 environment matching the production container dependencies.
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
venv_path=${VENV_PATH:-"$repo_root/.venv"}
python_bin=${PYTHON_BIN:-/usr/bin/python3}

if ! command -v "$python_bin" >/dev/null 2>&1; then
    printf 'Missing %s; set PYTHON_BIN to a Python 3.12 executable.\n' "$python_bin" >&2
    exit 1
fi

"$python_bin" -m venv --clear --system-site-packages "$venv_path"
"$venv_path/bin/python" -m pip install --upgrade pip
"$venv_path/bin/python" -m pip install -e "$repo_root/backend[dev]"

if [ "${INSTALL_MODELS:-1}" = "1" ]; then
    "$venv_path/bin/python" -m pip install \
        --index-url https://download.pytorch.org/whl/cpu torch
    "$venv_path/bin/python" -m pip install -e "$repo_root/backend[models]"
fi

"$venv_path/bin/python" --version
"$venv_path/bin/python" -c 'import cv2; print(f"OpenCV {cv2.__version__}")'

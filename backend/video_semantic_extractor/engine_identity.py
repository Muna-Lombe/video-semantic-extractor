"""@type implementation @purpose Fingerprint all shipped object-evaluation engine dependencies."""

import hashlib
from pathlib import Path


def evaluation_implementation(script: Path) -> str:
    package = Path(__file__).parent
    digest = hashlib.sha256()
    for name, path in (
        ("evaluate-frame-objects.py", script),
        ("object_detector.py", package / "object_detector.py"),
        ("engine_identity.py", package / "engine_identity.py"),
    ):
        digest.update(name.encode() + b"\0" + path.read_bytes())
    return "managed-object-evaluation.v1@sha256:" + digest.hexdigest()

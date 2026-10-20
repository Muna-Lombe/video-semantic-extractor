# syntax=docker/dockerfile:1
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    CAPSULE_EVALUATOR_PATH=/app/scripts/diagnostics/evaluate-frame-objects.py

WORKDIR /app

# ffprobe and ffmpeg must exist before Python dependencies are installed.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes ffmpeg tesseract-ocr \
    && command -v ffprobe \
    && command -v ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY backend/pyproject.toml backend/requirements.txt ./backend/
COPY backend/video_semantic_extractor ./backend/video_semantic_extractor
COPY scripts/diagnostics/evaluate-frame-objects.py ./scripts/diagnostics/evaluate-frame-objects.py

RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export PIP_CERT=/run/secrets/proxy_ca; fi \
    && python -m pip install --upgrade pip \
    && python -m pip install --index-url https://download.pytorch.org/whl/cpu torch \
    && python -m pip install ./backend[models]

RUN useradd --create-home --uid 10001 appuser \
    && chown --recursive appuser:appuser /app
USER appuser

EXPOSE 8000

CMD ["sh", "-c", "exec uvicorn video_semantic_extractor.api:app --host 0.0.0.0 --port ${PORT:-8000}"]

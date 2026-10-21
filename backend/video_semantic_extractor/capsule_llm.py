"""@type implementation @purpose Collect real model responses against frozen comparison inputs."""

import hashlib
import json
import time
from pathlib import Path
from urllib.parse import urlparse

import requests

from .capsule_comparison import VARIANTS, canonical, compare_answers


def run_comparison(
    directory,
    capsule_bytes,
    questions,
    output,
    *,
    model,
    api_key,
    endpoint="https://api.openai.com/v1/chat/completions",
    max_tokens=2048,
    timeout=120,
    post=requests.post,
):
    """Use a Chat Completions compatible endpoint; never retry or overwrite paid runs."""
    directory, output = Path(directory), Path(output)
    if urlparse(endpoint).scheme != "https" or urlparse(endpoint).username:
        raise ValueError("Model endpoint must use HTTPS without embedded credentials")
    if not model.strip() or not api_key or max_tokens <= 0 or timeout <= 0:
        raise ValueError("Model, credential and positive limits are required")
    # Validate every frozen byte before sending anything to a provider.
    compare_answers(directory, capsule_bytes, questions, {})
    plan = json.loads((directory / "plan.json").read_bytes())
    output.mkdir(parents=True, exist_ok=False)
    configuration = {
        "endpoint": endpoint,
        "temperature": 0,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
        "requested_model": model,
    }
    answers = {}
    for variant in VARIANTS:
        payload = (directory / plan["variants"][variant]["input_file"]).read_bytes()
        request = {
            "model": model,
            "temperature": 0,
            "max_tokens": max_tokens,
            "response_format": configuration["response_format"],
            "messages": [{"role": "user", "content": payload.decode("utf-8")}],
        }
        (output / f"{variant}.request.json").write_bytes(canonical(request))
        started = time.perf_counter()
        response = post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}"},
            json=request,
            timeout=timeout,
            allow_redirects=False,
        )
        elapsed = (time.perf_counter() - started) * 1000
        (output / f"{variant}.response.bin").write_bytes(response.content)
        (output / f"{variant}.transport.json").write_bytes(
            canonical(
                {
                    "status": response.status_code,
                    "elapsed_ms": elapsed,
                    "input_sha256": hashlib.sha256(payload).hexdigest(),
                }
            )
        )
        if response.status_code != 200:
            raise ValueError(
                f"Provider returned HTTP {response.status_code}; raw response retained"
            )
        body = response.json()
        choice = body["choices"][0]
        if choice.get("finish_reason") != "stop":
            raise ValueError("Incomplete model response; raw response retained")
        generated = json.loads(choice["message"]["content"])
        usage = body.get("usage") or {}
        measured = all(
            isinstance(usage.get(key), int) and not isinstance(usage[key], bool) and usage[key] >= 0
            for key in ("prompt_tokens", "completion_tokens")
        )
        answer = {
            "schema_version": "capsule-answers.v1",
            "capsule_sha256": plan["capsule_sha256"],
            "question_set_sha256": plan["question_set_sha256"],
            "input_sha256": plan["variants"][variant]["input_sha256"],
            "model": body.get("model"),
            "run_configuration": configuration,
            "answers": generated["answers"],
            "usage": {
                "input_tokens": usage["prompt_tokens"],
                "output_tokens": usage["completion_tokens"],
                "elapsed_ms": elapsed,
            }
            if measured
            else None,
        }
        # Preserve even invalid outputs before validation; never repair model answers.
        (output / f"{variant}.answers.json").write_bytes(canonical(answer))
        answers[variant] = answer
        report = compare_answers(directory, capsule_bytes, questions, answers)
        (output / "report.json").write_bytes(canonical(report))
    return report

"""@type test @purpose Verify real-run transport isolation, preservation and failure handling."""

import json

import pytest
from test_capsule_comparison import comparison

from video_semantic_extractor.capsule_llm import run_comparison


def setup_run(tmp_path):
    directory, capsule, questions, answers = comparison(tmp_path)
    return capsule, questions, directory, answers


@pytest.mark.parametrize("with_usage", [True, False])
def test_real_transport_contract(tmp_path, with_usage):
    capsule, questions, directory, answers = setup_run(tmp_path)
    calls = []

    def post(url, **kwargs):
        calls.append(kwargs)
        prompt = json.loads(kwargs["json"]["messages"][0]["content"])
        assert "accepted_answers" not in json.dumps(prompt)
        body = {
            "model": "pinned-model",
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": json.dumps({"answers": answers[prompt["variant"]]["answers"]})
                    },
                }
            ],
            "usage": {"prompt_tokens": 120, "completion_tokens": 30},
        }
        if not with_usage:
            del body["usage"]

        class Response:
            status_code = 200
            content = json.dumps(body).encode()

            def json(self):
                return body

        return Response()

    output = tmp_path / "run"
    report = run_comparison(
        directory, capsule, questions, output, model="model", api_key="secret-for-test", post=post
    )
    assert report["status"] == "scored"
    assert len(calls) == 3
    assert all(call["allow_redirects"] is False for call in calls)
    if with_usage:
        assert report["variants"]["capsule"]["usage"]["input_tokens"] == 120
    else:
        assert report["variants"]["capsule"]["usage"] is None
        assert (
            report["differences_from_transcript"]["capsule"]["input_token_reduction_fraction"]
            is None
        )
    assert all(b"secret-for-test" not in path.read_bytes() for path in output.iterdir())
    with pytest.raises(FileExistsError):
        run_comparison(
            directory, capsule, questions, output, model="model", api_key="secret", post=post
        )
    assert len(calls) == 3


def test_tampered_inputs_never_reach_provider(tmp_path):
    capsule, questions, directory, _ = setup_run(tmp_path)
    (directory / "summary.input.json").write_text("{}")
    with pytest.raises(ValueError, match="changed"):
        run_comparison(
            directory,
            capsule,
            questions,
            tmp_path / "run",
            model="model",
            api_key="secret",
            post=lambda *a, **kw: pytest.fail("Provider called"),
        )


def test_provider_failure_preserved_without_retry(tmp_path):
    capsule, questions, directory, _ = setup_run(tmp_path)

    class Response:
        status_code = 429
        content = b'{"error":"rate limited"}'

    output = tmp_path / "run"
    with pytest.raises(ValueError, match="HTTP 429"):
        run_comparison(
            directory,
            capsule,
            questions,
            output,
            model="model",
            api_key="secret",
            post=lambda *a, **kw: Response(),
        )
    assert (output / "transcript.response.bin").read_bytes() == Response.content
    assert not (output / "summary.request.json").exists()
    assert not (output / "report.json").exists()

<!-- @type documentation @purpose Record real corpus evidence, reproducible benchmark commands and remaining human acceptance. -->
# Dataset and evaluation expansion — 2026-10-18

## Recorded result

All 17 supplied videos passed complete FFmpeg decoding, with 17 distinct SHA-256 digests. Together they contain 625.197 seconds of footage and 90,299,321 source bytes. Four previews per source were inspected. These observations guide selection; they do not establish annotation counts or dataset adequacy.

The shared sampler produced **254 retained frames** under a 500-frame limit: 168 development frames from 12 sources and 86 holdout frames from five sources. The split was frozen before the open-vocabulary trial. Human confirmation of related-footage grouping, two independent reviews, adjudication and diagnostic approval remain pending. No completed human review was fabricated.

The initial 15-frame per-source budget correctly failed because it could not preserve the configured five-second temporal coverage. The finalized configuration uses a budget of 25 per source, retains that coverage, and uses the existing sampler. No validator threshold was lowered.

| Source | Seconds | Frames | Split | Provisional classes from previews |
| --- | ---: | ---: | --- | --- |
| sample_1 | 74.138 | 25 | holdout | person |
| sample_2 | 5.467 | 4 | development | person, sports ball |
| sample_3 | 76.699 | 25 | development | person, tie, handbag |
| sample_4 | 87.327 | 25 | development | person, chair, tv, cell phone |
| sample_5 | 99.889 | 23 | holdout | person, tv |
| sample_6 | 52.219 | 25 | development | person, bird, sandwich, cup |
| sample_7 | 65.663 | 15 | development | Negative code/diagram examples |
| sample_8 | 13.093 | 8 | development | sink, potted plant |
| sample_9 | 10.191 | 5 | development | car |
| sample_10 | 13.865 | 13 | development | tv, keyboard, mouse |
| sample_11 | 17.830 | 7 | holdout | tv, person |
| sample_12 | 57.002 | 25 | development | chair, person |
| sample_13 | 6.893 | 6 | holdout | cup, bottle |
| sample_14 | 14.231 | 16 | development | bottle, potted plant |
| sample_15 | 7.544 | 3 | development | book |
| sample_16 | 10.237 | 4 | development | tv, keyboard, book |
| sample_17 | 12.907 | 25 | holdout | sports ball, person |

The filmed displays in samples 10, 11 and 16 are useful screen candidates. A physical display is annotated separately from recognizable objects inside it. Software text and controls are not automatically COCO screen objects. Final inclusion and subset decisions belong to the reviewers.

## Frozen COCO reference comparison

The selected Hugging Face mirror revision is pinned, including both validation parquet shard checksums. A prediction-blind selection balances independent-image class support across **300 validation images and 4,264 non-crowd object instances covering all 80 COCO classes**. Native COCO instance annotations supply authoritative category IDs, float geometry, crowd and ignore semantics; the mirror alone omits `iscrowd`. Images are extracted from the pinned mirror and verified against native dimensions.

The result is a coverage-selected diagnostic subset, not the full official COCO benchmark or an untouched holdout. Both models use the same native annotations and image checksums, COCO maxDets=100, AP confidence floor 0.001, and point metrics at confidence 0.35 / IoU 0.5. NanoDet uses its native 416 input and YOLOv10n its 640 input. Both use two CPU threads and three warmup runs.

| Model | mAP 50–95 | Precision | Recall | F1 | CPU mean | CPU p95 | Peak process RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| nanodet | 12.91% | 59.08% | 23.80% | 33.94% | 98.2 ms | 112.8 ms | 238.5 MiB |
| yolov10 | 29.39% | 84.50% | 29.27% | 43.48% | 55.7 ms | 78.2 ms | 517.0 MiB |

YOLOv10n improves accuracy and measured latency in this environment, while using more process memory. Recall remains low, so this does not justify production promotion. Timings are collected during AP inference at confidence 0.001 and include preprocessing, inference and postprocessing; image disk reads and scoring are excluded. They are not production timing estimates at confidence 0.35. Peak RSS includes each process and its runtime. This is not Cloudflare resource qualification.

The publisher's YOLOv10 checkpoint contains numeric class names. The adapter validates the 80-class layout and applies the COCO order explicitly documented in its model card; native COCO category IDs are non-contiguous and are mapped by name. A different class order is rejected. Native scorer tests cover duplicate predictions, empty frames, absent classes and crowd regions. Integration errors were corrected without modifying labels, thresholds or the frozen subset.

## Extended annotations and open vocabulary

Policies may pin `annotation_rules.taxonomy_version: "coco-extended.v1"`. This adds microphone, headphones, camera, watch, tablet and `other` to the existing 80 classes. `other` requires `description` (1–200 non-blank characters). An independent optional `uncertain` boolean records ambiguity; uncertainty is not an object class. Reviewer and adjudicator forms expose both fields. Disagreeing `other` descriptions do not silently match. Legacy policies continue to reject extended fields/classes.

`video-object-diagnostic.v2` accepts 5–100 distinct frozen source hashes. V1 still requires exactly five. Both retain the original COCO minimums: 50 non-person instances, five non-person classes, 20 live/20 screen/10 composited instances, 15 small/15 large instances and at most 60% of COCO objects from one source. Extended labels do not satisfy these gates. The managed NanoDet evaluator reports unsupported annotations separately from COCO scores and per-frame errors.

Grounding DINO was trialed on five development-only previews with one frozen prompt list. It produced ten unreviewed suggestions, with zero suggestions on one desk preview. Suggestions remain exploratory evidence. No open-vocabulary accuracy or unknown-object completeness is claimed. The trial uses IDEA-Research's pinned Transformers conversion of the upstream Swin-T OGC checkpoint, not the byte-identical `.pth` from the supplied repository. Its conversion files and individual checksums are recorded.

Model cards list Apache-2.0 for Grounding DINO and AGPL-3.0 for the supplied YOLOv10 repository. Image licensing and exact deployment permissions still require the existing accountable approval workflow.

## Operator workflow

1. Open Create dataset. Randomise 1–27 sample videos, or reproduce a selection with its saved seed. A selection records the catalog version, source IDs and expected content hashes. Editing links clears selection provenance; custom URLs can be checked with bounded public HTTPS header probes. Decoding is verified during sampling. Click a dataset name to inspect saved provenance.
2. Sample and create an extended policy/template as needed. Pin frame sets that must remain as reusable benchmarks in Operations. Register the correct frozen source hashes, then collect real independent reviews and adjudication.
3. Use Evaluations to inspect the recorded reference comparison and download provenance/class results. The queued managed evaluation/release path continues to support NanoDet ONNX; YOLOv10 and Grounding DINO are research CLI adapters, not silently registered production engines.
4. Approve only genuinely eligible, reviewed evidence. Model selection and release acceptance remain explicit decisions.

## Catalog addition — 2026-10-19

Catalog `2026-10-19.1` adds samples 18–27 to the original 17-source library.
All ten URLs were downloaded, SHA-256 pinned, probed, fully decoded, and previewed
at four timestamps each. They add 277.276 seconds and 76,341,460 bytes; all 27
catalog entries have distinct content hashes. See the
[new-source audit](verification/2026-10-19-samples-18-27-audit.json).
The earlier benchmark manifests and results above remain frozen at their original
17 sources; this addition does not extend those benchmark claims. Their exact
[original catalog](verification/2026-10-18-sample-library.json) is retained with the
SHA-256 already pinned by the frozen video manifest. Current-catalog provenance
tests cover both audits; historical benchmark tests use that frozen snapshot.

| Source | Seconds | Preview index | Potential coverage |
| --- | ---: | --- | --- |
| sample_18 | 10.054 | Burger and drink cutout advert | composited sandwich/cup candidates |
| sample_19 | 10.217 | Perfume product animation | bottle appearance; rendered/photographic eligibility unresolved |
| sample_20 | 14.861 | Filmed televisions showing people | live televisions/bag; photographic screen people |
| sample_21 | 13.560 | Phone displays with city/car imagery | live phones; verify photographic versus rendered screen imagery |
| sample_22 | 31.927 | Presenter inset over article | composited person candidate |
| sample_23 | 56.587 | Presenter inset with photographic examples | composited presenter; screen people in embedded photographs |
| sample_24 | 12.957 | Desk tour and software displays | live person, furniture, devices and plants |
| sample_25 | 59.490 | Presenter and picture-in-picture explainer | live and composited presenter candidates |
| sample_26 | 10.890 | Dual-monitor desk setup | live person, furniture, devices and plants |
| sample_27 | 56.733 | Presenter and monitor demonstration | live person and computer setup |

These are provisional observations, not reviewed instance counts or proof of
diagnostic adequacy. Software graphics, diagrams, logos, illustrations and rendered
content must not be counted as photographic objects to fill subset quotas.
Samples 22, 23 and 25 share a conservative presenter group for split planning;
review related footage before freezing a holdout. The picker displays per-source
coverage notes, including unresolved eligibility in samples 19 and 21.

The catalog version changes seeded rankings and rejects unsubmitted selections
from the previous catalog; operators should select again. Existing frozen dataset
versions, campaign policies, annotations and benchmarks are unchanged. A new
evaluation corpus still needs its exact final hashes registered in a new policy
version and independent review of its sampled frames.

Catalog-addition verification passed: 108 backend tests, 158 Worker tests,
TypeScript, 522 responsive
layout cases with no runtime errors, JavaScript/Python syntax checks, and a Worker
dry build (450.07 KiB / gzip 94.79 KiB). Selection tests include all 27 videos,
persisted source hashes and rejection of stale catalog selections. Deployment
remains through branch merge.

To audit only this addition:

```bash
python scripts/operations/audit-sample-media.py --start-index 18 --count 10 --output-dir work/sample-index-18-27
```

## Reproduce locally

Use Python 3.12 and run commands from the repository root. Install CPU PyTorch before the optional benchmark extra to avoid downloading a GPU runtime. Generated images and models belong in ignored `work/`.

```bash
python -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.8.0+cpu torchvision==0.23.0+cpu
python -m pip install -e './backend[dev,benchmark]'
python scripts/operations/audit-sample-media.py --output-dir work/corpus
python scripts/diagnostics/prepare-video-benchmark.py --media-dir work/corpus --output-dir work/video-reference
python scripts/diagnostics/benchmark-corpus.py prepare --output-dir work/coco-reference --count 300
python scripts/diagnostics/benchmark-corpus.py download-yolo --output work/models/yolov10n.pt
python scripts/diagnostics/benchmark-corpus.py evaluate --benchmark-dir work/coco-reference --engine nanodet --model work/models/nanodet.onnx --output work/nanodet-report.json
python scripts/diagnostics/benchmark-corpus.py evaluate --benchmark-dir work/coco-reference --engine yolov10 --model work/models/yolov10n.pt --output work/yolov10-report.json
python scripts/diagnostics/trial-open-vocabulary.py prepare --model-dir work/models/grounding-dino-tiny
python scripts/diagnostics/trial-open-vocabulary.py run --model-dir work/models/grounding-dino-tiny --image-dir work/corpus --video-plan work/video-reference/benchmark.json --output work/grounding-dino-report.json
```

Use the pinned NanoDet download instructions in [scripts](../scripts/README.md). Preparation and result commands refuse to overwrite a frozen manifest/report. New experiments need new output paths. Dataset parquet shards and the native annotation ZIP are download caches; after extracting/checksum-verifying the frozen subset, they can be discarded. Keep selected inputs while they are needed for review/replay. This run reclaimed 1,749,693,517 bytes of verified download caches and unused Grounding DINO weights; its [archival record](verification/2026-10-18-cache-reclamation.json) retains checksums and pinned upstream sources.

## Evidence and remaining acceptance

- [Compact comparison and class results](verification/2026-10-18-reference-benchmarks.json). Raw prediction arrays are represented by digests and reproducible commands rather than copied into the repository.
- [COCO input manifest](verification/2026-10-18-coco-reference-manifest.json).
- [Video frame manifest](verification/2026-10-18-video-review-manifest.json).
- [Complete decoding audit](verification/2026-10-18-sample-media-audit.json).

The video corpus still needs independent human review, adjudication, verified grouping and approval. Hosted verification of the new migrations, retention schedule and supported runner happens after branch-merge deployment. Sender onboarding remains excluded. No manual deployment, real approval, model activation or production deletion was performed by this work.

## Build and behavior verification

[Recorded verification](verification/2026-10-18-dataset-workflow-tests.json):
156 Worker tests, 107 backend tests, 37 browser interaction checks and 522 responsive
layout cases passed. TypeScript, JavaScript syntax, changed-Python lint and engine
fingerprint checks passed. Worker dry-build: 442.04 KiB / gzip 93.16 KiB. The sampling
container built and executed real NanoDet ONNX inference as its non-root user.

Lifecycle tests use actual SQLite migrations with controlled R2 failure fixtures.
They cover racing pins, active/retained dependencies, changed media/archive bytes,
archive verification failures, grace cancellation, concurrent sweepers, interruption
between object deletion and database completion, archived evidence responses and
expired identity cleanup without token retention. Hosted behavior remains a
post-merge acceptance task.

<!--
@type documentation
@purpose Freeze the object-annotation scope, review process, subsets, and acceptance gates for the multi-video diagnostic corpus.
-->

# Object annotation policy

## Status and purpose

This policy is frozen for the supplied five-video diagnostic corpus as of
2026-09-18. It must be applied before looking at a candidate detector's output.
Changing a rule after predictions have been reviewed requires a new policy version,
an explanation of the change, and complete re-review of every affected frame.

The policy evaluates localization and classification of objects visible in retained
hybrid frames. It does not evaluate actions, brands, product identity, logos, OCR,
website understanding, or natural-language descriptions. Those are separate tasks;
an empty or successful COCO result must not be used as evidence for them.

## Annotation unit and coordinates

- The annotation unit is one image named by a hybrid sampling manifest. Every
  retained image must have an entry, including images with no eligible objects.
- Each object has a stable annotation identifier, a COCO class name, a source subset,
  and one source-image pixel box represented as `[x, y, width, height]`.
- Coordinates use a zero-based top-left origin. Boxes are clipped to the visible
  image and must have positive width and height.
- The box encloses all visible pixels belonging to the instance, not the estimated
  extent behind another object. Separated visible parts of one instance use the
  tightest single box that encloses those parts.
- A repeated view of the same physical object in another retained frame is a new
  frame-level annotation. A reflection of an object is not a second instance.

## Required source subsets

Every annotation receives exactly one of these mutually exclusive values:

- `live`: a physical object photographed in the source scene, including an object
  held by or partially occluded by a person.
- `composited`: a photographic or rendered object deliberately overlaid into the
  edited video outside a filmed display, including picture-in-picture presenters.
- `screen`: an object depicted inside a filmed or composited screen, application,
  webpage, thumbnail, advertisement, photograph, or video-within-video.

An object is assigned by where its pixels originate, not by whether it could exist
physically. For example, a photographed laptop in the room is `live`; a laptop shown
in a webpage product tile is `screen`; and a cut-out laptop pasted over the main
video is `composited`. Interface chrome, text, icons, emoji, logos, drawings, and
decorative shapes are outside the COCO object task and are not annotated as objects.

## Inclusion and exclusion rules

Annotate an instance only when all of the following are true:

1. Its class is one of the detector's declared 80 COCO classes.
2. A reviewer can identify the class from visible pixels in this frame without
   transcript, neighboring-frame, brand, or detector-output context.
3. The visible portion forms enough of a coherent instance to draw a repeatable box.
4. The instance is at least 8 pixels wide and 8 pixels high in the source image.

Apply these edge rules consistently:

- Include truncated objects that cross an image boundary when the visible portion is
  independently classifiable; clip the box to the image.
- Include occluded objects when their visible pixels are coherent and independently
  classifiable. Do not infer or box the hidden extent.
- Exclude disconnected fragments that cannot independently establish the class.
- Include a person when a face or a contiguous head-and-upper-body region is visible.
  Exclude isolated hands, arms, legs, hair, or torso fragments.
- Treat separately visible people as separate instances, including background
  people. Do not annotate an indistinguishable crowd as one person.
- Include held COCO objects separately from the holder. A prominent microphone is
  recorded in the out-of-taxonomy audit, not mislabeled as another COCO class.
- Include `screen` photographic objects under the same visibility and minimum-size
  rules as `live` objects. Do not include text-only references or interface icons.
- Exclude mannequins, statues, illustrations, cartoons, and purely synthetic icons
  from the COCO benchmark. Record them in the out-of-taxonomy audit when relevant.
- When a class remains genuinely ambiguous after independent review, exclude it from
  scored ground truth and record the frame, candidate classes, and reason in the
  adjudication log. Ambiguity is not resolved using model predictions.

## Independent review and adjudication

1. Generate fresh hybrid manifests and verify each source SHA-256 against the corpus
   inventory before annotation.
2. **Reviewer A**, a human annotator, performs the first pass and saves it in a
   reviewer-specific file. Reviewer A may use an assisted annotation tool, but the
   tool or agent is not a reviewer and its output does not count as a pass.
3. **Reviewer B**, a different human who has not seen Reviewer A's annotations,
   performs the second pass in a separately initialized file. Reviewer B must not
   be the same person under another account or session. Neither reviewer may inspect
   candidate-model predictions first.
4. Compare frame coverage, class, subset, and boxes only after both reviewer files
   are complete. Agreement on boxes requires the same class and subset and at least
   0.8 intersection over union.
5. **Adjudicator C**, a third qualified human who performed neither independent
   pass, reviews the source image, policy, and both completed reviewer
   files and resolves every disagreement and ambiguity. The adjudicator may see the
   comparison report, but must not inspect candidate-model predictions. An AI agent
   may organize evidence but cannot adjudicate. If a third qualified human is not
   available, the corpus remains incomplete rather than allowing Reviewer A or B to
   approve their own annotation.
6. The adjudicator or a designated data custodian writes the decisions into the
   merged fixture. The final fixture must retain an adjudication log without human
   names if anonymity is needed, while separate access-controlled provenance records
   which people filled Reviewer A, Reviewer B, and Adjudicator C roles.
7. Validate that all manifest frames occur exactly once, checksums match, classes and
   subsets are allowed, identifiers are unique, and boxes are within image bounds.
8. Freeze and commit the fixture before running or inspecting the candidate report
   used for model selection.

The second pass is not a NanoDet run or another model's output. Candidate detectors
are the systems being measured, so using their predictions as one side of the truth
construction would make evaluation circular and would reveal predictions before the
freeze. A model may provide assisted suggestions that a human accepts, rejects, or
redraws, but those suggestions do not constitute an independent pass. An AI may
generate the mechanical comparison report, but the adjudicator is the accountable
human who resolves its entries from source pixels and this policy.

Negative frames are first-class evidence. An empty annotation list means both
reviewers exhaustively inspected the frame and found no eligible object; it must not
mean that the frame was skipped.

## Corpus adequacy gate

Detector comparison must not begin until the frozen fixture satisfies all of these
conditions:

- every hybrid frame from all five checksum-bound supplied videos is reviewed;
- at least 50 non-person instances and at least five non-person COCO classes exist;
- at least 20 instances are `live`, 20 are `screen`, and 10 are `composited`;
- at least 15 instances have box area below 2% of the source-image area, and at least
  15 have box area above 20%; and
- no single source video supplies more than 60% of all positive instances.

If the supplied corpus cannot meet a condition, report that failure and add suitable,
properly licensed sources. Do not relax the gate or duplicate annotations. The known
non-commercial license restriction means this corpus is diagnostic evidence only and
cannot establish suitability for commercial training or production evaluation.

## Scoring and predeclared detector gate

Predictions are matched one-to-one to annotations with the same class and subset at
0.5 box intersection over union, using maximum-cardinality matching. Report TP, FP,
FN, precision, recall, and F1 in aggregate and independently for `live`,
`composited`, and `screen`. Also report per-class results and small, medium, and large
area bands; any slice with fewer than ten positives is explicitly underpowered.

A detector passes this diagnostic gate only when all of the following hold on the
frozen corpus at one preselected confidence and NMS configuration:

- aggregate precision and recall are each at least 0.80;
- precision and recall are each at least 0.70 for every source subset with at least
  ten positives;
- recall is at least 0.70 for both the small and large area bands when adequately
  supported;
- no adequately supported COCO class has precision or recall below 0.60; and
- every error remains traceable to a source checksum, frame timestamp, prediction,
  and ground-truth annotation.

Thresholds may be explored only after the primary fixed-configuration result is
recorded. Exploration is diagnostic and does not convert the same corpus into an
independent validation set. Passing this gate supports only broad COCO object
detection on the represented corpus; it does not authorize production integration
or imply support for any excluded capability.

## Out-of-taxonomy audit

Each frame review also records plainly visible, requirement-relevant concepts that
COCO cannot express, such as microphones, brands, logos, application controls, and
product identity. This audit uses names and regions where practical but is not mixed
into COCO precision or recall. Its purpose is to quantify taxonomy gaps and seed
separate evaluation fixtures, not to expand detector classes informally.

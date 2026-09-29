/** @type implementation @purpose Compare independent object reviews in the Worker runtime. */

export type JsonRecord = Record<string, any>;

function iou(left: number[], right: number[]): number {
  if (left.length !== 4 || right.length !== 4) return 0;
  const width = Math.max(0, Math.min(left[0] + left[2], right[0] + right[2]) - Math.max(left[0], right[0]));
  const height = Math.max(0, Math.min(left[1] + left[3], right[1] + right[3]) - Math.max(left[1], right[1]));
  const intersection = width * height;
  const union = left[2] * left[3] + right[2] * right[3] - intersection;
  return union ? intersection / union : 0;
}

function maximumMatches(left: JsonRecord[], right: JsonRecord[]): Array<[number, number]> {
  const edges = left.map((candidate) => right.flatMap((other, index) =>
    candidate.label === other.label && candidate.subset === other.subset &&
    iou(candidate.region ?? [], other.region ?? []) >= 0.8 ? [index] : []));
  const rightToLeft = new Map<number, number>();
  const visit = (leftIndex: number, visited: Set<number>): boolean => {
    for (const rightIndex of edges[leftIndex]) {
      if (visited.has(rightIndex)) continue;
      visited.add(rightIndex);
      const previous = rightToLeft.get(rightIndex);
      if (previous === undefined || visit(previous, visited)) {
        rightToLeft.set(rightIndex, leftIndex);
        return true;
      }
    }
    return false;
  };
  left.forEach((_, index) => visit(index, new Set()));
  return [...rightToLeft].map(([rightIndex, leftIndex]) => [leftIndex, rightIndex]).sort((a, b) => a[0] - b[0]);
}

function frameMap(payload: JsonRecord): Map<string, JsonRecord> {
  const frames = new Map<string, JsonRecord>();
  for (const source of payload.sources ?? []) {
    for (const frame of source.frames ?? []) frames.set(`${source.source}\0${frame.filename}`, frame);
  }
  return frames;
}

export function compareReviews(left: JsonRecord, right: JsonRecord): JsonRecord {
  const disagreements: JsonRecord[] = [];
  if (left.policy_version !== right.policy_version) disagreements.push({ type: "policy_version" });
  const leftFrames = frameMap(left), rightFrames = frameMap(right);
  const keys = [...new Set([...leftFrames.keys(), ...rightFrames.keys()])].sort();
  for (const key of keys) {
    const [source, filename] = key.split("\0");
    const location = { source, filename };
    const leftFrame = leftFrames.get(key), rightFrame = rightFrames.get(key);
    if (!leftFrame || !rightFrame) {
      disagreements.push({ ...location, type: "frame_coverage" });
      continue;
    }
    const leftObjects = leftFrame.objects ?? [], rightObjects = rightFrame.objects ?? [];
    const matches = maximumMatches(leftObjects, rightObjects);
    const matchedLeft = new Set(matches.map(([index]) => index));
    const matchedRight = new Set(matches.map(([, index]) => index));
    leftObjects.forEach((object: JsonRecord, index: number) => {
      if (!matchedLeft.has(index)) disagreements.push({ ...location, type: "left_unmatched", object });
    });
    rightObjects.forEach((object: JsonRecord, index: number) => {
      if (!matchedRight.has(index)) disagreements.push({ ...location, type: "right_unmatched", object });
    });
    if (JSON.stringify(leftFrame.out_of_taxonomy ?? []) !== JSON.stringify(rightFrame.out_of_taxonomy ?? [])) {
      disagreements.push({ ...location, type: "out_of_taxonomy" });
    }
  }
  return { agree: disagreements.length === 0, frames_compared: [...leftFrames.keys()].filter((key) => rightFrames.has(key)).length, disagreements };
}

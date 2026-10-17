/** @type implementation @purpose Reproducible, content-pinned sample selections. */
import catalog from "../../../scripts/fixtures/sample-library.v1.json";
import { sha256Hex } from "./artifact-pipeline";

export const SAMPLE_LIBRARY = catalog;
export async function selectSamples(count: unknown, seed: unknown) {
  if (!Number.isInteger(count) || Number(count) < 1 || Number(count) > catalog.sources.length) throw new Error(`count must be 1-${catalog.sources.length}`);
  if (typeof seed !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(seed)) throw new Error("seed must contain 1-100 letters, digits, dots, colons, underscores or hyphens");
  const ranked = await Promise.all(catalog.sources.map(async (source) => ({ source, rank: await sha256Hex(JSON.stringify([catalog.version, seed, source.id])) })));
  ranked.sort((a, b) => a.rank.localeCompare(b.rank) || a.source.id.localeCompare(b.source.id));
  const sources = ranked.slice(0, Number(count)).map(({ source }) => source);
  return { catalog_version: catalog.version, seed, source_ids: sources.map((source) => source.id), sources };
}

export async function verifySampleSelection(value: unknown, urls: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("selection must be a sample selection object");
  const selection = value as Record<string, any>;
  if (Object.keys(selection).some((key) => !["catalog_version", "seed", "source_ids"].includes(key)) || selection.catalog_version !== catalog.version || !Array.isArray(selection.source_ids)) throw new Error("sample catalog changed; select samples again");
  const expected = await selectSamples(selection.source_ids.length, selection.seed);
  if (JSON.stringify(expected.source_ids) !== JSON.stringify(selection.source_ids) || JSON.stringify(expected.sources.map((source) => source.url)) !== JSON.stringify(urls)) throw new Error("source URLs do not match the reproducible sample selection");
  return { catalog_version: catalog.version, seed: selection.seed, source_ids: expected.source_ids, source_sha256: expected.sources.map((source) => source.sha256) };
}

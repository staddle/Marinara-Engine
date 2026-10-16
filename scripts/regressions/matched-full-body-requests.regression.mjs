import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../packages/client/src/components/ui/SpriteGenerationModal.tsx", import.meta.url),
  "utf8",
);

assert.match(
  source,
  /const MATCHED_FULL_BODY_BATCH_SIZE = 1;/u,
  "matched full-body expressions must be split into one request each",
);
assert.match(
  source,
  /for \(let batchIndex = startIndex; batchIndex < batches\.length; batchIndex \+= 1\)[\s\S]*await generateBatch\(/u,
  "batch requests must run sequentially",
);
assert.match(
  source,
  /batches: matchedFullBodyBatches,[\s\S]*?generateSpriteBatch\(batchExpressions, batchIndex, totalBatches, acceptedNeutral\.dataUrl\)/u,
  "matched full-body batches must be drawn from the accepted neutral",
);
assert.match(
  source,
  /const matched = neutralFullBodyReference !== undefined;\n\s*const grid = matched \? getMatchedFullBodyBatchGrid\(batchExpressions\.length\)/u,
  "matched full-body requests must keep their own small grid",
);
assert.match(
  source,
  /for \(let attempt = 0; attempt < 2; attempt \+= 1\)[\s\S]*await requestGeneratedSheet/u,
  "each expression request must receive one automatic retry",
);
// The server keeps making a picture after the client stops waiting, so a retry after a timeout could be paid twice.
assert.match(
  source,
  /if \(isAbortError\(err\)\) \{[\s\S]*?throw new SpriteGenerationRequestTimeoutError\(/u,
  "a request the client stopped waiting for must be marked as timed out",
);
for (const [name, start, end] of [
  ["generateSpriteBatch", "const generateSpriteBatch = useCallback(", "const generateNeutralFullBodyCandidate"],
  [
    "generateNeutralFullBodyCandidate",
    "const generateNeutralFullBodyCandidate = useCallback(",
    "const runSpriteBatches",
  ],
]) {
  const body = source.slice(source.indexOf(start), source.indexOf(end));
  assert.match(
    body,
    /catch \(err\) \{[\s\S]*?err instanceof SpriteGenerationRequestTimeoutError[\s\S]*?throw err;[\s\S]*?lastError = /u,
    `${name} must not retry a timed-out picture by itself`,
  );
}
assert.match(
  source,
  /nextCells = \[\.\.\.nextCells, \.\.\.generated\.cells\];[\s\S]*setCells\(nextCells\);/u,
  "each completed expression must be preserved before the next request starts",
);
assert.match(
  source,
  /setStep\(nextCells\.length > 0 \? 2 : 0\);/u,
  "cancelling a matched run must keep completed sprites available for review",
);
assert.match(
  source,
  /neutralFullBodyReference,[\s\S]*expressionReferences: matchedFullBodyMode/u,
  "individual requests must retain the accepted neutral and matching portrait references",
);
assert.match(
  source,
  /const neutralReference = fullBodyExpressionMode\s*\? cells\.find\(/u,
  "retrying a matched sprite must reuse the accepted neutral",
);

process.stdout.write("Matched full-body request regression passed\n");

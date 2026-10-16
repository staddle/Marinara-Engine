// ──────────────────────────────────────────────
// Regression: provider lanes for "Queue media generation requests" (#7662)
// ──────────────────────────────────────────────
// With the toggle on, image requests to one provider account must go out one at a
// time whichever feature sends them, because providers like NovelAI reject parallel
// work. Pinned here: the lane itself (serial per key, parallel across keys, re-entrant,
// abort and throw leave nothing behind, toggle off restores parallel requests), the
// server mirror of the synced `ui` setting, and the real generateImage path against a
// local fixture provider reached through two different "connections". Also pinned:
// the gap a lane keeps after each request for providers that need it (NovelAI), and the
// retry when a provider still answers 429 because another generation is running, and
// that a fallback to another account queues only after the primary lane is released.
import assert from "node:assert/strict";
import { createServer } from "node:http";

process.env.MARINARA_MEDIA_GENERATION_CONCURRENCY = "4";
const {
  applyMediaQueueUiSettingsValue,
  inspectMediaProviderLanesForTests,
  mediaProviderLaneGapMs,
  mediaProviderLaneKey,
  mediaProviderLanesEnabled,
  runInMediaProviderLane,
} = await import("../../packages/server/src/services/image/image-generation-queue.js");
const { generateImage, retryOnProviderBusy } =
  await import("../../packages/server/src/services/image/image-generation.js");
const { generateVideo } = await import("../../packages/server/src/services/video/video-generation.js");

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function concurrencyProbe() {
  let running = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    run: async <T>(gate: Promise<void>, value: T) => {
      running += 1;
      peak = Math.max(peak, running);
      try {
        await gate;
        return value;
      } finally {
        running -= 1;
      }
    },
  };
}

const idle = () => {
  const lanes = inspectMediaProviderLanesForTests();
  assert.equal(lanes.activeLanes, 0, "no lane may stay behind");
  assert.equal(lanes.internedAccounts, 0, "no API key may outlive the requests that used it");
};

// ── 1) The synced `ui` setting drives the toggle; only an explicit false turns it off ──
applyMediaQueueUiSettingsValue(null);
assert.equal(mediaProviderLanesEnabled(), true, "missing setting keeps the default (on)");
applyMediaQueueUiSettingsValue("{not json");
assert.equal(mediaProviderLanesEnabled(), true, "bad JSON keeps the default (on)");
applyMediaQueueUiSettingsValue(JSON.stringify({ queueImageGenerationRequests: false }));
assert.equal(mediaProviderLanesEnabled(), false);
applyMediaQueueUiSettingsValue(JSON.stringify({ queueImageGenerationRequests: true, theme: "dark" }));
assert.equal(mediaProviderLanesEnabled(), true);

// ── 2) Lane keys: one per endpoint and account, never the key in clear ──
const keyA = mediaProviderLaneKey("https://image.novelai.net", "secret-key-a");
assert.equal(keyA, mediaProviderLaneKey("https://image.novelai.net", "  secret-key-a "));
assert.notEqual(keyA, mediaProviderLaneKey("https://image.novelai.net", "secret-key-b"));
assert.notEqual(keyA, mediaProviderLaneKey("https://other.example", "secret-key-a"));
assert.ok(!keyA.includes("secret-key-a"), "the API key must never appear in a lane key");

// ── 3) Same lane runs one at a time in FIFO order; other lanes run alongside ──
{
  const probe = concurrencyProbe();
  const order: string[] = [];
  const gates = [deferred(), deferred(), deferred()];
  const same = gates.map((gate, index) =>
    runInMediaProviderLane({
      laneKey: "lane-a",
      task: () => {
        order.push(`a${index}`);
        return probe.run(gate.promise, index);
      },
    }),
  );
  const otherGate = deferred();
  let otherStarted = false;
  const other = runInMediaProviderLane({
    laneKey: "lane-b",
    task: () => {
      otherStarted = true;
      return otherGate.promise;
    },
  });
  await tick();
  assert.equal(probe.peak, 1, "one request at a time per lane");
  assert.equal(otherStarted, true, "a different provider account is not held up");
  for (const gate of gates) gate.resolve();
  otherGate.resolve();
  assert.deepEqual(await Promise.all(same), [0, 1, 2]);
  await other;
  assert.deepEqual(order, ["a0", "a1", "a2"], "FIFO order");
  await tick();
  idle();
}

// ── 4) Re-entering a held lane (nested generateImage) must not deadlock ──
assert.equal(
  await runInMediaProviderLane({
    laneKey: "lane-a",
    task: () => runInMediaProviderLane({ laneKey: "lane-a", task: async () => "nested" }),
  }),
  "nested",
);
await tick();
idle();

// ── 5) A throwing task and an aborted waiter both free the lane ──
{
  await assert.rejects(
    runInMediaProviderLane({
      laneKey: "lane-a",
      task: async () => {
        throw new Error("provider exploded");
      },
    }),
    /provider exploded/u,
  );
  const holderGate = deferred();
  const holder = runInMediaProviderLane({ laneKey: "lane-a", task: () => holderGate.promise });
  const controller = new AbortController();
  let waiterRan = false;
  const waiter = runInMediaProviderLane({
    laneKey: "lane-a",
    signal: controller.signal,
    task: async () => {
      waiterRan = true;
    },
  });
  await tick();
  controller.abort(new Error("user cancelled"));
  await assert.rejects(waiter, /user cancelled/u);
  holderGate.resolve();
  await holder;
  assert.equal(waiterRan, false, "an aborted waiter never reaches the provider");
  assert.equal(await runInMediaProviderLane({ laneKey: "lane-a", task: async () => "after" }), "after");
  await tick();
  idle();
}

// ── 6) Toggle off: requests run in parallel as before ──
{
  applyMediaQueueUiSettingsValue(JSON.stringify({ queueImageGenerationRequests: false }));
  const probe = concurrencyProbe();
  const gate = deferred();
  const runs = [0, 1].map((index) =>
    runInMediaProviderLane({ laneKey: "lane-a", task: () => probe.run(gate.promise, index) }),
  );
  await tick();
  assert.equal(probe.peak, 2, "the toggle off leaves requests unqueued");
  gate.resolve();
  await Promise.all(runs);
  applyMediaQueueUiSettingsValue(null);
  idle();
}

// ── 6b) Gap: the lane stays closed after a request, but its caller returns at once ──
{
  assert.equal(mediaProviderLaneGapMs("novelai"), 1_000, "NovelAI gets breathing room");
  assert.equal(mediaProviderLaneGapMs("openai"), 0, "other providers keep back-to-back requests");
  const gapMs = 80;
  let firstEndedAt = 0;
  let secondStartedAt = 0;
  const first = runInMediaProviderLane({
    laneKey: "lane-gap",
    gapMs,
    task: async () => {
      firstEndedAt = Date.now();
      return "first";
    },
  });
  const second = runInMediaProviderLane({
    laneKey: "lane-gap",
    gapMs,
    task: async () => {
      secondStartedAt = Date.now();
      return "second";
    },
  });
  const firstReturnedAt = await first.then(() => Date.now());
  assert.ok(firstReturnedAt - firstEndedAt < gapMs / 2, "the gap must not delay the finished request's caller");
  assert.equal(await second, "second");
  assert.ok(secondStartedAt - firstEndedAt >= gapMs - 5, "the next request waits out the gap");
  await sleep(gapMs + 20);
  idle();
}

// ── 6c) A busy provider (429) is retried after a wait, then reported as-is ──
// The production wait unrefs its timer, so hold the event loop open while it runs.
const keepAlive = setInterval(() => undefined, 1_000);
try {
  const statuses = [429, 429, 200];
  let calls = 0;
  const ok = await retryOnProviderBusy(async () => new Response("x", { status: statuses[calls++] }), undefined, [5, 5]);
  assert.equal(ok.status, 200);
  assert.equal(calls, 3, "two retries, then the success");

  calls = 0;
  const busy = await retryOnProviderBusy(
    async () => {
      calls += 1;
      return new Response("Concurrent generation is locked", { status: 429 });
    },
    undefined,
    [5, 5],
  );
  assert.equal(busy.status, 429, "out of retries: the caller sees the provider's answer");
  assert.equal(calls, 3);

  calls = 0;
  const other = await retryOnProviderBusy(
    async () => {
      calls += 1;
      return new Response("nope", { status: 500 });
    },
    undefined,
    [5, 5],
  );
  assert.equal(other.status, 500);
  assert.equal(calls, 1, "only 429 is retried");

  const controller = new AbortController();
  const aborted = retryOnProviderBusy(async () => new Response("busy", { status: 429 }), controller.signal, [10_000]);
  await tick();
  controller.abort(new Error("user cancelled"));
  await assert.rejects(aborted, /user cancelled/u, "an abort ends the wait at once");

  // An abort that lands while the busy response's body is being cancelled must not wait either.
  const late = new AbortController();
  const busyBody = () =>
    new Response(new ReadableStream({ cancel: () => late.abort(new Error("cancelled mid-cleanup")) }), {
      status: 429,
    });
  const lateAbort = retryOnProviderBusy(async () => busyBody(), late.signal, [10_000]);
  const settled = await Promise.race([
    lateAbort.then(
      () => "resolved",
      (error: Error) => error.message,
    ),
    sleep(1_000).then(() => "still waiting"),
  ]);
  assert.equal(settled, "cancelled mid-cleanup", "an abort during body cleanup skips the retry wait");
} finally {
  clearInterval(keepAlive);
}

// ── 7) Real generateImage path: two "connections" to one provider account ──
let inFlight = 0;
let providerPeak = 0;
// A fixed cap, never taken from the request.
const MAX_FIXTURE_BODY = 64_000;
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_FIXTURE_BODY) return response.writeHead(413).end();
  }
  inFlight += 1;
  providerPeak = Math.max(providerPeak, inFlight);
  await sleep(40);
  inFlight -= 1;
  response.setHeader("content-type", "application/json");
  if (body.includes("primary-fails")) {
    response.statusCode = 500;
    return response.end(JSON.stringify({ error: { message: "primary down" } }));
  }
  response.end(JSON.stringify({ data: [{ b64_json: png }] }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const request = { prompt: "a lighthouse", model: "flux-2-pro", allowLocalUrls: true };
  // An illustrator, a tracker portrait and a package image, as three independent callers.
  const results = await Promise.all([
    generateImage("openai", baseUrl, "account-key", "openai", request),
    generateImage("openai", `${baseUrl}/`, "account-key", "openai", request),
    generateImage("openai", baseUrl, "account-key", "openai", { ...request, prompt: "an NPC portrait" }),
  ]);
  assert.ok(results.every((result) => result.base64 === png));
  assert.equal(providerPeak, 1, "one provider account must never see parallel requests");

  providerPeak = 0;
  await Promise.all([
    generateImage("openai", baseUrl, "account-key", "openai", request),
    generateImage("openai", baseUrl, "another-account", "openai", request),
  ]);
  assert.equal(providerPeak, 2, "different accounts keep running in parallel");

  providerPeak = 0;
  applyMediaQueueUiSettingsValue(JSON.stringify({ queueImageGenerationRequests: false }));
  await Promise.all([
    generateImage("openai", baseUrl, "account-key", "openai", request),
    generateImage("openai", baseUrl, "account-key", "openai", request),
  ]);
  assert.equal(providerPeak, 2, "with the toggle off only the global ceiling applies");
  applyMediaQueueUiSettingsValue(null);
  await tick();
  idle();

  // Opposite cross-account fallbacks at once (A falls back to B while B falls back to A)
  // must both finish: a primary that kept its lane while queueing for the fallback lane
  // would wait on the other request forever.
  const fallbackTo = (apiKey: string) => ({
    connectionId: `fallback-${apiKey}`,
    connectionName: "Fallback",
    provider: "image_generation",
    source: "openai",
    baseUrl,
    apiKey,
    serviceHint: "openai",
    model: "flux-2-pro",
    prompt: "a lighthouse",
  });
  const crossed = (primaryKey: string, fallbackKey: string) =>
    generateImage("openai", baseUrl, primaryKey, "openai", {
      ...request,
      prompt: "primary-fails",
      fallback: fallbackTo(fallbackKey),
      onFallback: () => undefined,
    });
  const crossedResults = await Promise.race([
    Promise.all([crossed("account-a", "account-b"), crossed("account-b", "account-a")]),
    sleep(2_000).then(() => "deadlock" as const),
  ]);
  assert.notEqual(crossedResults, "deadlock", "opposite fallbacks must not wait on each other");
  assert.ok(Array.isArray(crossedResults) && crossedResults.every((result) => result.base64 === png));
  await tick();
  idle();
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ── 8) Videos share a lane per provider account too ──
{
  const mp4 = Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex");
  let videosInFlight = 0;
  let videoPeak = 0;
  let brokenWaiting = 0;
  const bothBroken = deferred();
  const swarm = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > MAX_FIXTURE_BODY) return response.writeHead(413).end();
    }
    if (request.url === "/API/GetNewSession") return response.end(JSON.stringify({ session_id: "session" }));
    if (request.url === "/API/GenerateText2Image" && body.includes("broken-model")) {
      // Hold both primaries until both are in flight, so each holds its lane at once.
      brokenWaiting += 1;
      if (brokenWaiting === 2) bothBroken.resolve();
      await bothBroken.promise;
      response.statusCode = 500;
      return response.end(JSON.stringify({ error: "primary down" }));
    }
    if (request.url === "/API/GenerateText2Image") {
      videosInFlight += 1;
      videoPeak = Math.max(videoPeak, videosInFlight);
      await sleep(40);
      videosInFlight -= 1;
      return response.end(JSON.stringify({ images: [`data:video/mp4;base64,${mp4.toString("base64")}`] }));
    }
    response.end(mp4);
  });
  await new Promise<void>((resolve) => swarm.listen(0, "127.0.0.1", resolve));
  try {
    const address = swarm.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const video = (connectionKey: string) =>
      generateVideo("swarmui", base, "fixture-token", "swarmui", {
        prompt: "A wave",
        durationSeconds: 4,
        aspectRatio: "16:9",
        comfyWorkflow: "{}",
        connectionKey,
      });
    // Two connection rows for one server: the legacy per-connection queue would let both through.
    await Promise.all([video("scene-video"), video("game-video")]);
    assert.equal(videoPeak, 1, "one provider account must never render two videos at once");
    await tick();
    idle();

    // Crossed fallbacks: each primary fails while holding its lane, then falls back onto
    // the other's account. The fallback must start after the primary leaves its lane.
    const withVideoFallbackTo = (apiKey: string) =>
      generateVideo("swarmui", base, apiKey === "video-b" ? "video-a" : "video-b", "swarmui", {
        prompt: "A wave",
        model: "broken-model",
        durationSeconds: 4,
        aspectRatio: "16:9",
        comfyWorkflow: "{}",
        onFallback: async () => undefined,
        fallback: {
          connectionId: `fallback-${apiKey}`,
          connectionName: "Backup",
          source: "swarmui",
          baseUrl: base,
          apiKey,
          serviceHint: "swarmui",
          model: "working-model",
          comfyWorkflow: "{}",
        },
      });
    const crossedVideos = await Promise.race([
      Promise.all([withVideoFallbackTo("video-b"), withVideoFallbackTo("video-a")]),
      sleep(3_000).then(() => "stuck" as const),
    ]);
    assert.notEqual(crossedVideos, "stuck", "crossed video fallbacks must not wait on each other's lanes");
    await tick();
    idle();
  } finally {
    await new Promise<void>((resolve) => {
      swarm.close(() => resolve());
      swarm.closeAllConnections();
    });
  }
}

console.log("media-provider-lane regression passed");

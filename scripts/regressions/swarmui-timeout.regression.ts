import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Socket } from "node:net";

const previousImageTimeout = process.env.IMAGE_GEN_TIMEOUT_MS;
const previousComfyTimeout = process.env.COMFYUI_GEN_TIMEOUT;
process.env.IMAGE_GEN_TIMEOUT_MS = "80";
process.env.COMFYUI_GEN_TIMEOUT = "1";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const requestPorts = new Map<string, number>();
const server = createServer((request, response) => {
  if (request.url && request.socket.remotePort) requestPorts.set(request.url, request.socket.remotePort);
  if (request.url === "/API/GetNewSession") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ session_id: "regression-session" }));
    return;
  }
  if (request.url === "/API/GenerateText2Image") {
    setTimeout(() => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ images: ["View/generated.png"] }));
    }, 120);
    return;
  }
  if (request.url === "/View/generated.png") {
    response.setHeader("Content-Type", "image/png");
    response.end(png);
    return;
  }
  response.statusCode = 404;
  response.end();
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const keepAliveCalls: Array<{ delay: number; localPort?: number }> = [];
const originalSetKeepAlive = Socket.prototype.setKeepAlive;
Socket.prototype.setKeepAlive = function (enable = false, initialDelay = 0) {
  if (enable) {
    const call = { delay: initialDelay, localPort: this.localPort };
    keepAliveCalls.push(call);
    if (!call.localPort) this.once("connect", () => (call.localPort = this.localPort));
  }
  return originalSetKeepAlive.call(this, enable, initialDelay);
};

try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { generateImage, resolveComfyUiImageGenerationTimeoutMs } =
    await import("../../packages/server/src/services/image/image-generation.js");

  assert.equal(
    resolveComfyUiImageGenerationTimeoutMs(1_800_000, 2400),
    2_400_000,
    "SwarmUI and ComfyUI share the longer configured image-generation deadline",
  );
  const result = await generateImage("swarmui", `http://127.0.0.1:${address.port}`, "", "swarmui", {
    prompt: "timeout regression",
  });
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.base64, png.toString("base64"));
  const generationPort = requestPorts.get("/API/GenerateText2Image");
  assert.ok(generationPort, "the regression server must observe the SwarmUI generation request");
  assert.ok(
    keepAliveCalls.some((call) => call.localPort === generationPort && call.delay === 10_000),
    "SwarmUI generation must probe an idle TCP connection before the reported 30-second network timeout",
  );
  for (const path of ["/API/GetNewSession", "/View/generated.png"]) {
    const port = requestPorts.get(path);
    assert.ok(port, `the regression server must observe ${path}`);
    assert.equal(
      keepAliveCalls.some((call) => call.localPort === port && call.delay === 10_000),
      false,
      `${path} must retain ordinary fetch transport behavior`,
    );
  }
} finally {
  Socket.prototype.setKeepAlive = originalSetKeepAlive;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (previousImageTimeout === undefined) delete process.env.IMAGE_GEN_TIMEOUT_MS;
  else process.env.IMAGE_GEN_TIMEOUT_MS = previousImageTimeout;
  if (previousComfyTimeout === undefined) delete process.env.COMFYUI_GEN_TIMEOUT;
  else process.env.COMFYUI_GEN_TIMEOUT = previousComfyTimeout;
}

console.info("SwarmUI timeout regression passed.");

// ──────────────────────────────────────────────
// Avatar agents: the local emotion model's worker thread (lane: director)
// ──────────────────────────────────────────────
// Loading the model parses a 34 MB tokenizer and builds a 268 MB ONNX session, and each text takes tens to
// hundreds of milliseconds; on the server's main thread that would stall every streaming reply. This worker loads
// the already-downloaded files only (no network: the download is checked and pinned in local-emotion-model.ts) and
// answers { id, text } with { id, scores } or { id, error }. Terminating the worker frees the model.
import { parentPort, workerData } from "node:worker_threads";

interface EmotionModelWorkerData {
  /** transformers.js localModelPath: the folder that holds `modelId`. */
  modelsDir: string;
  modelId: string;
}

type Classify = (text: string, options: { top_k: null }) => Promise<Array<{ label: string; score: number }>>;

const { modelsDir, modelId } = workerData as EmotionModelWorkerData;
const port = parentPort!;

try {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useFSCache = false;
  env.useBrowserCache = false;
  env.localModelPath = modelsDir;
  const classify = (await pipeline("text-classification", modelId, {
    dtype: "q8",
    local_files_only: true,
  })) as unknown as Classify;
  port.on("message", async (message: { id: number; text: string }) => {
    try {
      const output = await classify(message.text, { top_k: null });
      port.postMessage({
        id: message.id,
        scores: Object.fromEntries(output.map(({ label, score }) => [label, score])),
      });
    } catch (error) {
      port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
  port.postMessage({ type: "ready" });
} catch (error) {
  port.postMessage({ type: "failed", error: error instanceof Error ? error.message : String(error) });
}

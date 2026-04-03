import { existsSync } from "node:fs";
import { LlamaChatSession, getLlama, readGgufFileInfo } from "node-llama-cpp";

export interface LlamaRunOptions {
  modelPath: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
}

export interface LlamaStreamChunk {
  text: string;
  segmentType: "main" | "thought" | "comment";
  segmentStart?: boolean;
  segmentEnd?: boolean;
}
let cachedModelPath: string | null = null;
let cachedModel: Awaited<ReturnType<Awaited<ReturnType<typeof getLlama>>["loadModel"]>> | null = null;
const modelArchitectureCache = new Map<string, string>();
const UNSUPPORTED_MAIN_ARCHITECTURES = new Set(["gemma4"]);
const GPU_OOM_HINT = "GPU memory exhausted while running the model. Try a smaller quant/model, lower max tokens, or close GPU-heavy apps and retry.";

type DisposableResource = {
  dispose?: () => void | Promise<void>;
  release?: () => void | Promise<void>;
  free?: () => void | Promise<void>;
};

async function disposeResource(resource: unknown): Promise<void> {
  if (!resource) return;
  const candidate = resource as DisposableResource;
  try {
    if (typeof candidate.dispose === "function") {
      await candidate.dispose();
      return;
    }
    if (typeof candidate.release === "function") {
      await candidate.release();
      return;
    }
    if (typeof candidate.free === "function") {
      await candidate.free();
    }
  } catch {
    // Cleanup should never mask inference failures.
  }
}

function shouldResetModelFromError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("outofmemory")
    || message.includes("insufficient memory")
    || message.includes("backend is in error state")
    || message.includes("failed to decode, ret = -3");
}

async function handleInferenceError(error: unknown): Promise<never> {
  if (shouldResetModelFromError(error)) {
    await disposeResource(cachedModel);
    cachedModel = null;
    cachedModelPath = null;
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`${GPU_OOM_HINT} (${details})`);
  }
  throw error;
}

async function getModelArchitecture(modelPath: string): Promise<string | null> {
  const cached = modelArchitectureCache.get(modelPath);
  if (cached) return cached;

  try {
    const info = await readGgufFileInfo(modelPath, { readTensorInfo: false, logWarnings: false });
    const architecture = String(info.metadata.general.architecture || "").toLowerCase();
    if (!architecture) return null;
    modelArchitectureCache.set(modelPath, architecture);
    return architecture;
  } catch {
    return null;
  }
}

async function assertMainChatModel(modelPath: string): Promise<void> {
  const architecture = await getModelArchitecture(modelPath);
  if (architecture === "clip") {
    throw new Error(
      "This GGUF is CLIP/mmproj (multimodal projector), not a chat model. Delete it and reinstall with `runai recommend`.",
    );
  }
  if (architecture && UNSUPPORTED_MAIN_ARCHITECTURES.has(architecture)) {
    throw new Error(
      `This GGUF uses '${architecture}' architecture, which is not supported by the current node-llama-cpp runtime. `
      + "Use a different model (for example Qwen 3.5 GGUF via `runai recommend`) or update the runtime when support is available.",
    );
  }
}

async function getModel(modelPath: string) {
  if (!existsSync(modelPath)) {
    throw new Error(`Model not found at ${modelPath}`);
  }
  if (cachedModel && cachedModelPath === modelPath) {
    return cachedModel;
  }
  await assertMainChatModel(modelPath);

  const llama = await getLlama();
  try {
    cachedModel = await llama.loadModel({ modelPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("clip cannot be used as main model")) {
      throw new Error(
        "This GGUF appears to be a multimodal projector (mmproj/CLIP), not a chat model. Reinstall the model with `runai recommend` and try again.",
      );
    }
    if (message.toLowerCase().includes("unknown model architecture")) {
      const architecture = await getModelArchitecture(modelPath);
      const architectureHint = architecture ? ` (${architecture})` : "";
      throw new Error(
        `Failed to load model: unsupported GGUF architecture${architectureHint} in current node-llama-cpp runtime. `
        + "Try a different model with `runai recommend` (Qwen 3.5 works) or upgrade your local runtime/dependencies.",
      );
    }
    throw error;
  }
  cachedModelPath = modelPath;
  return cachedModel;
}

export async function runLlamaOnce(options: LlamaRunOptions): Promise<string> {
  const model = await getModel(options.modelPath);
  const context = await model.createContext();
  try {
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
    });
    const text = await session.prompt(options.prompt, {
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    } as never);
    return text.trim();
  } catch (error) {
    return await handleInferenceError(error);
  } finally {
    await disposeResource(context);
  }
}

export async function runLlamaStream(
  options: LlamaRunOptions,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const model = await getModel(options.modelPath);
  const context = await model.createContext();
  try {
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
    });

    let hasChunks = false;
    const text = await session.prompt(options.prompt, {
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      onTextChunk: (chunk: string) => {
        hasChunks = true;
        onChunk(chunk);
      },
    } as never);

    if (!hasChunks && text) {
      onChunk(text);
    }
  } catch (error) {
    await handleInferenceError(error);
  } finally {
    await disposeResource(context);
  }
}

export async function runLlamaStreamWithSegments(
  options: LlamaRunOptions,
  onChunk: (chunk: LlamaStreamChunk) => void,
): Promise<void> {
  const model = await getModel(options.modelPath);
  const context = await model.createContext();
  try {
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
    });

    let hasChunks = false;
    const text = await session.prompt(options.prompt, {
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      onResponseChunk: (chunk) => {
        hasChunks = true;
        if (chunk.type === "segment") {
          const segmentType = chunk.segmentType === "thought" ? "thought" : "comment";
          onChunk({
            text: chunk.text,
            segmentType,
            segmentStart: Boolean(chunk.segmentStartTime),
            segmentEnd: Boolean(chunk.segmentEndTime),
          });
          return;
        }
        onChunk({
          text: chunk.text,
          segmentType: "main",
        });
      },
    } as never);

    if (!hasChunks && text) {
      onChunk({
        text,
        segmentType: "main",
      });
    }
  } catch (error) {
    await handleInferenceError(error);
  } finally {
    await disposeResource(context);
  }
}

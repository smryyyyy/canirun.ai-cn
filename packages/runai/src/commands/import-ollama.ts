import * as p from "@clack/prompts";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { RUNAI_MODEL_DIR, OLLAMA_MODEL_DIR } from "../config";
import { upsertInstalledModel } from "../db";
import { ensureModelDir } from "../model-store";
import { getPromptOutput, usePromptLegend } from "../prompt-footer";
import { hasFlag, listInstalledModelOptions } from "../cli-utils";

export async function handleImport(args: string[]): Promise<void> {
  const asJson = hasFlag(args, "--json");
  const ollamaDir = OLLAMA_MODEL_DIR;
  const blobsDir = join(ollamaDir, "blobs");

  if (!existsSync(blobsDir)) {
    p.log.error(`Ollama model directory not found at ${ollamaDir}`);
    p.log.info("Set OLLAMA_MODELS env var if your Ollama data is in a different location.");
    return;
  }

  const manifestsDir = join(ollamaDir, "manifests", "registry.ollama.ai", "library");
  if (!existsSync(manifestsDir)) {
    p.log.error("No Ollama manifests found. Have you pulled any models with Ollama?");
    return;
  }

  const foundModels: Array<{ name: string; tag: string; blobPath: string | null; sizeBytes: number }> = [];

  try {
    const families = await readdir(manifestsDir, { withFileTypes: true });
    for (const family of families) {
      if (!family.isDirectory()) continue;
      const tagsDir = join(manifestsDir, family.name);
      const tags = await readdir(tagsDir, { withFileTypes: true });
      for (const tag of tags) {
        if (tag.isDirectory()) continue;
        try {
          const manifestContent = await readFile(join(tagsDir, tag.name), "utf-8");
          const manifest = JSON.parse(manifestContent);
          const layers = manifest.layers || [];
          const modelLayer = layers.find((l: { mediaType: string }) =>
            l.mediaType === "application/vnd.ollama.image.model",
          );
          if (!modelLayer?.digest) continue;

          const digestHash = modelLayer.digest.replace("sha256:", "sha256-");
          const blobPath = join(blobsDir, digestHash);
          const exists = existsSync(blobPath);
          let sizeBytes = 0;
          if (exists) {
            const blobStat = await stat(blobPath);
            sizeBytes = blobStat.size;
          }

          foundModels.push({
            name: family.name,
            tag: tag.name,
            blobPath: exists ? blobPath : null,
            sizeBytes,
          });
        } catch {
          // skip malformed manifests
        }
      }
    }
  } catch (error) {
    p.log.error(`Failed to scan Ollama manifests: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const importable = foundModels.filter((m) => m.blobPath !== null);

  if (asJson) {
    console.log(JSON.stringify({ found: foundModels, importable: importable.length }, null, 2));
    return;
  }

  if (importable.length === 0) {
    p.log.warn("No importable Ollama models found.");
    return;
  }

  p.intro(`runai import — ${importable.length} Ollama model(s) found`);

  const alreadyInstalled = await listInstalledModelOptions();
  const alreadyIds = new Set(alreadyInstalled.map((m) => m.id.toLowerCase()));
  const candidates = importable.filter((m) => !alreadyIds.has(`${m.name}-${m.tag}`.toLowerCase()));

  if (candidates.length === 0) {
    p.log.info("All Ollama models are already imported.");
    p.outro("Done.");
    return;
  }

  usePromptLegend("multiselect");
  const selected = await p.multiselect({
    message: "Select Ollama models to import",
    required: false,
    withGuide: true,
    output: getPromptOutput(),
    options: candidates.map((m) => {
      const sizeGB = Math.round((m.sizeBytes / (1024 ** 3)) * 100) / 100;
      return { value: m, label: `${m.name}:${m.tag} (${sizeGB} GB)` };
    }),
  });

  if (p.isCancel(selected) || selected.length === 0) {
    p.log.info("No models selected.");
    return;
  }

  await ensureModelDir();

  for (const model of selected) {
    if (!model.blobPath) continue;
    const id = `${model.name}-${model.tag}`;
    const targetPath = join(RUNAI_MODEL_DIR, `${id}.gguf`);

    if (existsSync(targetPath)) {
      p.log.info(`${id} already exists, skipping.`);
      continue;
    }

    const spinner = p.spinner();
    spinner.start(`Importing ${model.name}:${model.tag}...`);

    try {
      await Bun.write(targetPath, Bun.file(model.blobPath));
      upsertInstalledModel({
        id,
        name: `${model.name}:${model.tag}`,
        path: targetPath,
        sourceUrl: null,
        sourceRepo: `ollama/${model.name}`,
        sourceFile: model.tag,
      });
      spinner.stop(`Imported ${id}`);
    } catch (error) {
      spinner.stop(`Failed to import ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  p.outro("Import complete.");
}

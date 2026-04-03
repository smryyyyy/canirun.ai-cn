import * as p from "@clack/prompts";
import { basename } from "node:path";
import { detectHardware } from "../hardware";
import { installCatalogModel } from "../install";
import { getInstalledModelById, isModelFilePresent, upsertInstalledModel } from "../db";
import { pullModel } from "../pull";
import { findModelByName, getCatalogSize } from "../recommend";
import {
  getArgValue, positionalArgs, stripGguf, normalizeModelId,
  listInstalledModelOptions,
} from "../cli-utils";
import { handleChat } from "./chat";

export async function handleRun(args: string[]): Promise<void> {
  const modelName = positionalArgs(args, ["--model"]).join(" ") || getArgValue(args, "--model");
  if (!modelName) {
    p.log.error("Usage: runai run <model-name>\n  Example: runai run qwen3.5-4b");
    return;
  }

  const normalizedName = modelName.toLowerCase().trim();

  const installedById = getInstalledModelById(normalizeModelId(normalizedName));
  if (installedById && isModelFilePresent(installedById.path)) {
    p.log.info(`Model ${installedById.name} already installed.`);
    await handleChat(["--model", installedById.path]);
    return;
  }

  const installed = await listInstalledModelOptions();
  const existingMatch = installed.find((item) =>
    item.id.toLowerCase().includes(normalizedName) || item.name.toLowerCase().includes(normalizedName),
  );
  if (existingMatch) {
    p.log.info(`Model ${existingMatch.name} already installed.`);
    await handleChat(["--model", existingMatch.path]);
    return;
  }

  const hw = await detectHardware();
  const catalogMatch = findModelByName(normalizedName, hw);
  if (catalogMatch) {
    p.log.step(`Installing ${catalogMatch.name} [${catalogMatch.quant}]...`);
    const installedModel = await installCatalogModel(catalogMatch);
    upsertInstalledModel({
      id: catalogMatch.id,
      name: catalogMatch.name,
      path: installedModel.path,
      sourceUrl: installedModel.sourceUrl,
      sourceRepo: installedModel.sourceRepo,
      sourceFile: installedModel.sourceFile,
    });
    p.log.success(`Installed ${catalogMatch.id}`);
    await handleChat(["--model", installedModel.path]);
    return;
  }

  if (normalizedName.startsWith("http://") || normalizedName.startsWith("https://")) {
    p.log.step("Downloading from URL...");
    const installedPath = await pullModel(normalizedName);
    const id = normalizeModelId(installedPath);
    upsertInstalledModel({
      id,
      name: stripGguf(basename(installedPath)),
      path: installedPath,
      sourceUrl: normalizedName,
    });
    await handleChat(["--model", installedPath]);
    return;
  }

  p.log.error(`Model "${modelName}" not found in catalog (${getCatalogSize()} models available).`);
  p.log.info("Try: runai browse to see available models, or runai run <gguf-url> for a direct URL.");
}

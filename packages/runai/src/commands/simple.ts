import * as p from "@clack/prompts";
import { stat, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { RUNAI_DEFAULT_PORT } from "../config";
import { detectHardware } from "../hardware";
import { printBrowseResults } from "../output";
import { pullModel } from "../pull";
import { searchCatalog } from "../recommend";
import { sendBrowseTelemetry } from "../telemetry";
import { startServer } from "../serve";
import {
  isModelFilePresent,
  removeInstalledModelByPath,
  upsertInstalledModel,
} from "../db";
import { getPromptOutput, usePromptLegend } from "../prompt-footer";
import { ANSI, paint } from "../terminal";
import {
  getArgValue, hasFlag, positionalArgs, stripGguf, normalizeModelId,
  listInstalledModelOptions, resolveServeModel,
  type PromptNavigationOptions,
} from "../cli-utils";

export async function handleBrowse(args: string[]): Promise<void> {
  const query = positionalArgs(args, ["--limit"]).join(" ");
  const limit = Number(getArgValue(args, "--limit") || "25");
  const hw = await detectHardware();
  const matches = searchCatalog(query, hw, limit);
  sendBrowseTelemetry(query, matches.length);
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify({ query, matches }, null, 2));
    return;
  }
  p.intro("runai browse");
  printBrowseResults(matches);
  p.outro(`${matches.length} model(s) shown`);
}

export async function handlePull(args: string[]): Promise<void> {
  const url = args.find((a) => a.startsWith("http://") || a.startsWith("https://"));
  if (!url) {
    throw new Error("Usage: runai pull <gguf-url> [--name my-model.gguf]");
  }
  const name = getArgValue(args, "--name");
  const installedPath = await pullModel(url, name);
  const id = normalizeModelId(name || installedPath);
  upsertInstalledModel({
    id,
    name: stripGguf(name || basename(installedPath)),
    path: installedPath,
    sourceUrl: url,
    sourceRepo: null,
    sourceFile: basename(installedPath),
  });
}

export async function handleServe(args: string[]): Promise<boolean> {
  const model = await resolveServeModel(args);
  if (!model) {
    p.log.error("No model selected. Install one with `runai recommend` or pass `--model`.");
    return false;
  }
  const port = Number(getArgValue(args, "--port") || `${RUNAI_DEFAULT_PORT}`) || RUNAI_DEFAULT_PORT;
  try {
    startServer({ model, port });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("EADDRINUSE") || message.toLowerCase().includes("port")) {
      p.log.error(`Port ${port} is already in use. Try --port ${port + 1}`);
      return false;
    }
    p.log.error(`Failed to start API server: ${message}`);
    return false;
  }
}

export async function handleList(args: string[]): Promise<void> {
  const asJson = hasFlag(args, "--json");
  const installed = await listInstalledModelOptions();

  if (installed.length === 0) {
    if (asJson) {
      console.log(JSON.stringify({ models: [] }, null, 2));
    } else {
      p.log.warn("No installed models. Run `runai run <model>` to install one.");
    }
    return;
  }

  if (asJson) {
    const models = [];
    for (const item of installed) {
      const fileStat = await stat(item.path).catch(() => null);
      models.push({
        id: item.id,
        name: item.name,
        path: item.path,
        sizeBytes: fileStat?.size ?? 0,
      });
    }
    console.log(JSON.stringify({ models }, null, 2));
    return;
  }

  p.intro(`runai list — ${installed.length} model(s)`);
  for (const item of installed) {
    const fileStat = await stat(item.path).catch(() => null);
    const sizeGB = fileStat ? Math.round((fileStat.size / (1024 ** 3)) * 100) / 100 : 0;
    p.log.message(
      `${paint(item.name, ANSI.cyan)} ${paint(`(${item.id})`, ANSI.gray, true)}   ${paint(`${sizeGB} GB`, ANSI.yellow)}`,
      { symbol: "•" },
    );
  }
  p.outro("Done.");
}

export async function handleDeleteModels(
  options: PromptNavigationOptions = {},
): Promise<"completed" | "cancelled"> {
  const installed = await listInstalledModelOptions();
  if (installed.length === 0) {
    p.log.warn("No installed models to delete.");
    return "completed";
  }

  usePromptLegend("multiselect");
  const selected = await p.multiselect({
    message: "Select models to delete",
    required: false,
    withGuide: true,
    output: getPromptOutput(),
    options: installed.map((item) => ({
      value: item.path,
      label: `${item.name} (${item.id})`,
      hint: item.path,
    })),
  });

  if (p.isCancel(selected)) return "cancelled";
  if (selected.length === 0) {
    p.log.info("No models selected.");
    return "completed";
  }

  usePromptLegend("default");
  const ok = await p.confirm({
    message: `Delete ${selected.length} model(s)? This action cannot be undone.`,
    initialValue: false,
    output: getPromptOutput(),
  });
  if (p.isCancel(ok)) return "cancelled";
  if (!ok) {
    p.log.info("Delete cancelled.");
    return "completed";
  }

  for (const modelPath of selected) {
    await unlink(modelPath);
    removeInstalledModelByPath(modelPath);
    p.log.success(`Deleted ${basename(modelPath)}`);
  }
  return "completed";
}

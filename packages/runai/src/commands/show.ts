import * as p from "@clack/prompts";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { getInstalledModelById, isModelFilePresent } from "../db";
import { getModelInfo } from "../llamacpp";
import { getPromptOutput, usePromptLegend } from "../prompt-footer";
import { ANSI, paint } from "../terminal";
import {
  getArgValue, hasFlag, positionalArgs, stripGguf, normalizeModelId,
  listInstalledModelOptions,
} from "../cli-utils";

export async function handleShow(args: string[]): Promise<void> {
  const asJson = hasFlag(args, "--json");
  const modelRef = positionalArgs(args, ["--model"]).join(" ") || getArgValue(args, "--model");

  let modelPath: string | null = null;
  let modelId: string | null = null;

  if (modelRef) {
    if (modelRef.includes("/") || modelRef.endsWith(".gguf")) {
      modelPath = modelRef;
      modelId = stripGguf(basename(modelRef));
    } else {
      const installed = getInstalledModelById(normalizeModelId(modelRef));
      if (installed && isModelFilePresent(installed.path)) {
        modelPath = installed.path;
        modelId = installed.id;
      } else {
        const allInstalled = await listInstalledModelOptions();
        const match = allInstalled.find((item) =>
          item.id.toLowerCase().includes(modelRef.toLowerCase()) || item.name.toLowerCase().includes(modelRef.toLowerCase()),
        );
        if (match) {
          modelPath = match.path;
          modelId = match.id;
        }
      }
    }
  }

  if (!modelPath) {
    const installed = await listInstalledModelOptions();
    if (installed.length === 0) {
      p.log.error("No installed models. Install one with `runai run <model>` or `runai recommend`.");
      return;
    }
    if (installed.length === 1) {
      modelPath = installed[0]!.path;
      modelId = installed[0]!.id;
    } else {
      usePromptLegend("list");
      const selected = await p.select({
        message: "Choose model to inspect",
        output: getPromptOutput(),
        options: installed.map((item) => ({
          value: item.path,
          label: `${item.name} (${item.id})`,
          hint: item.path,
        })),
      });
      if (p.isCancel(selected)) return;
      modelPath = selected;
      modelId = stripGguf(basename(selected));
    }
  }

  if (!modelPath || !isModelFilePresent(modelPath)) {
    p.log.error(`Model not found at ${modelPath}`);
    return;
  }

  const fileStats = await stat(modelPath);
  const fileSizeGB = Math.round((fileStats.size / (1024 ** 3)) * 100) / 100;
  const info = await getModelInfo(modelPath);
  const dbRecord = modelId ? getInstalledModelById(normalizeModelId(modelId)) : null;

  const data = {
    id: modelId,
    path: modelPath,
    architecture: info.architecture,
    contextLength: info.contextLength,
    name: info.name,
    fileSizeGB,
    fileSizeBytes: fileStats.size,
    source: dbRecord?.sourceRepo ?? null,
    installedAt: dbRecord?.installedAt ?? null,
  };

  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  p.intro(`runai show — ${modelId}`);
  p.log.message([
    `${paint("Name", ANSI.gray, true)}          ${info.name || modelId}`,
    `${paint("Architecture", ANSI.gray, true)}  ${info.architecture || "unknown"}`,
    `${paint("Context", ANSI.gray, true)}       ${info.contextLength ? `${info.contextLength.toLocaleString()} tokens` : "unknown"}`,
    `${paint("File size", ANSI.gray, true)}     ${fileSizeGB} GB (${fileStats.size.toLocaleString()} bytes)`,
    `${paint("Path", ANSI.gray, true)}          ${modelPath}`,
    dbRecord?.sourceRepo ? `${paint("Source", ANSI.gray, true)}        ${dbRecord.sourceRepo}` : "",
    dbRecord?.installedAt ? `${paint("Installed", ANSI.gray, true)}     ${new Date(dbRecord.installedAt).toLocaleDateString()}` : "",
  ].filter(Boolean).join("\n"), { symbol: "◇" });
  p.outro("Done.");
}

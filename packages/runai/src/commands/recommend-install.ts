import * as p from "@clack/prompts";
import { detectHardware } from "../hardware";
import { installCatalogModel } from "../install";
import { upsertInstalledModel } from "../db";
import { printHardware, printRecommendations } from "../output";
import { recommendTopModels, searchCatalog } from "../recommend";
import { sendRecommendationTelemetry } from "../telemetry";
import { getPromptOutput, usePromptLegend } from "../prompt-footer";
import { ANSI, paint } from "../terminal";
import {
  getArgValue, hasFlag, parseInstallTokens, uiFitScore,
  type PromptNavigationOptions,
} from "../cli-utils";
import { handleChat } from "./chat";
import type { RecommendedModel, CliHardwareInfo } from "../types";

function recommendationOptionLabel(item: RecommendedModel, index: number): string {
  const quant = paint(`[${item.quant}]`, ANSI.gray);
  const fit = uiFitScore(item.score);
  const fitLine = `   ${paint("☆ Fit:", ANSI.magenta, true)} ${paint(`${fit}/100`, ANSI.green, true)}`;
  const metricsLine = `   ${paint("⛁", ANSI.cyan, true)} ${paint("Disk:", ANSI.cyan, true)} ${paint(`${item.memoryNeededGB} GB`, ANSI.cyan, true)}   ${paint("⛃", ANSI.cyan, true)} ${paint("VRAM:", ANSI.cyan, true)} ${paint(`~${item.diskNeededGB} GB`, ANSI.cyan, true)}`;
  const speedLine = `   ${paint("⚡Speed expected:", ANSI.yellow)} ~${item.expectedTokensPerSec ?? "?"} tok/s`;
  return `${paint(String(index + 1), ANSI.bold)}. ${item.name} ${quant}\n${fitLine}\n${metricsLine}\n${speedLine}\n`;
}

function searchableModelLabel(item: RecommendedModel): string {
  return `${item.name} ${paint(`[${item.quant}]`, ANSI.gray)}`;
}

function searchableModelHint(item: RecommendedModel): string {
  const fit = uiFitScore(item.score);
  return `☆ Fit ${fit}/100  •  score ${item.score}  •  grade ${item.grade}  •  ⚡~${item.expectedTokensPerSec ?? "?"} tok/s`;
}

function resolveInstallTargets(tokens: string[], recommendations: RecommendedModel[]): RecommendedModel[] {
  const available = recommendations.filter((item) => !item.downloaded);
  const unique = new Map<string, RecommendedModel>();
  const addByModel = (model: RecommendedModel | undefined): void => {
    if (!model) return;
    unique.set(model.id, model);
  };
  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (normalized === "all") {
      for (const model of available) addByModel(model);
      continue;
    }
    const numeric = Number(token);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= recommendations.length) {
      addByModel(recommendations[numeric - 1]);
      continue;
    }
    addByModel(available.find((item) => item.id.toLowerCase() === normalized));
  }
  return [...unique.values()];
}

async function promptInstallSelection(
  recommendations: RecommendedModel[],
  catalog: RecommendedModel[],
): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const candidates = recommendations.filter((item) => !item.downloaded);
  if (candidates.length === 0) return null;
  const availableCatalog = catalog.filter((item) => !item.downloaded);
  let visibleCount = candidates.length;

  while (true) {
    const visible = availableCatalog.slice(0, visibleCount);
    const hasMore = visibleCount < availableCatalog.length;
    usePromptLegend("list");
    const selection = await p.select({
      message: "Top recommendations to install",
      output: getPromptOutput(),
      options: [
        ...visible.map((item, index) => ({
          value: item.id,
          label: recommendationOptionLabel(item, index),
        })),
        {
          value: "__more__",
          label: hasMore
            ? paint("＋ Show more options (+3)", ANSI.yellow)
            : paint("＋ No more options", ANSI.gray),
          disabled: !hasMore,
        },
        { value: "__search__", label: paint("🔎 Search models", ANSI.cyan) },
      ],
    });

    if (p.isCancel(selection)) return null;

    if (selection === "__more__") {
      visibleCount = Math.min(visibleCount + 3, availableCatalog.length);
      continue;
    }

    if (selection === "__search__") {
      usePromptLegend("list");
      const searched = await p.autocomplete({
        message: "Search model to install",
        placeholder: "Type to filter models...",
        maxItems: 10,
        output: getPromptOutput(),
        options: availableCatalog.map((item) => ({
          value: item.id,
          label: searchableModelLabel(item),
          hint: searchableModelHint(item),
        })),
      });
      if (p.isCancel(searched)) return null;
      return searched;
    }

    return selection;
  }
}

async function installRecommendations(
  args: string[],
  recommendations: RecommendedModel[],
  hw: CliHardwareInfo,
  options: PromptNavigationOptions = {},
): Promise<"completed" | "cancelled"> {
  const catalog = searchCatalog("", hw, 200);
  const direct = getArgValue(args, "--install");
  const input = direct ?? await promptInstallSelection(recommendations, catalog);
  if (!input) return "cancelled";
  if (input.toLowerCase() === "none") return "completed";

  const targets = resolveInstallTargets(parseInstallTokens(input), catalog);
  if (targets.length === 0) {
    p.log.warn("No installable models matched your selection.");
    return "completed";
  }

  for (const [index, model] of targets.entries()) {
    p.log.step(`Installing ${index + 1}/${targets.length}: ${model.name} (${model.id})`);
    const installed = await installCatalogModel(model);
    upsertInstalledModel({
      id: model.id,
      name: model.name,
      path: installed.path,
      sourceUrl: installed.sourceUrl,
      sourceRepo: installed.sourceRepo,
      sourceFile: installed.sourceFile,
    });
    p.log.success(`Installed ${model.id}`);
  }

  usePromptLegend("default");
  const openNow = await p.confirm({
    message: "Installation complete. Open chat now?",
    output: getPromptOutput(),
  });
  if (p.isCancel(openNow)) return "cancelled";
  if (openNow) {
    await handleChat([], options);
  } else {
    p.log.info("Next: run `runai chat` to start chatting with an installed model.");
  }
  return "completed";
}

export async function handleRecommend(
  args: string[],
  options: PromptNavigationOptions = {},
): Promise<"completed" | "cancelled"> {
  const limit = Number(getArgValue(args, "--top") || "3");
  const hw = await detectHardware();
  const recommendations = recommendTopModels(hw, limit);
  sendRecommendationTelemetry(hw, recommendations);
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify({ hardware: hw, recommendations }, null, 2));
    return "completed";
  }
  p.intro("runai recommend");
  printHardware(hw);
  if (!process.stdin.isTTY) {
    printRecommendations(recommendations);
  }
  const status = await installRecommendations(args, recommendations, hw, options);
  if (status === "cancelled") return "cancelled";
  p.outro("Done.");
  return "completed";
}

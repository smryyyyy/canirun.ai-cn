import * as p from "@clack/prompts";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import { constants } from "node:fs";
import { access, stat, unlink } from "node:fs/promises";
import { arch, platform } from "node:os";
import { RUNAI_DEFAULT_PORT, RUNAI_MODEL_DIR, RUNAI_VERSION } from "./config";
import { detectMacHardware } from "./hardware-macos";
import { printBrowseResults, printHardware, printRecommendations } from "./output";
import { installCatalogModel } from "./install";
import { runLlamaStream, runLlamaStreamWithSegments } from "./llamacpp";
import { ensureModelDir, listInstalledModelPaths } from "./model-store";
import { buildPrompt } from "./openai";
import { pullModel } from "./pull";
import { recommendTopModels, searchCatalog } from "./recommend";
import { startServer } from "./serve";
import { sendBrowseTelemetry, sendRecommendationTelemetry } from "./telemetry";
import { getPromptOutput, setPromptFooter, usePromptLegend } from "./prompt-footer";
import {
  getInstalledModelById,
  isModelFilePresent,
  listInstalledModels,
  removeInstalledModelById,
  removeInstalledModelByPath,
  upsertInstalledModel,
} from "./db";
import type { RecommendedModel, CliHardwareInfo } from "./types";

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  gray: "\u001b[90m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  magenta: "\u001b[35m",
};

function paint(text: string, color: string, muted = false): string {
  if (!process.stdout.isTTY) return text;
  return `${muted ? ANSI.dim : ""}${color}${text}${ANSI.reset}`;
}

function waveGradient(text: string, phase: number): string {
  if (!process.stdout.isTTY) return text;
  const chars = [...text];
  return chars.map((ch, index) => {
    const t = (index + phase) * 0.55;
    const mix = (Math.sin(t) + 1) / 2;
    const r = Math.round(245 + (255 - 245) * mix);
    const g = Math.round(165 + (235 - 165) * mix);
    const b = Math.round(40 + (120 - 40) * mix);
    return `\u001b[38;2;${r};${g};${b}m${ch}`;
  }).join("") + ANSI.reset;
}

function gradientBrand(text: string): string {
  if (!process.stdout.isTTY) return text;
  const stops = [
    [236, 72, 153],  // pink
    [168, 85, 247],  // purple
    [59, 130, 246],  // blue
  ] as const;
  const chars = [...text];
  if (chars.length <= 1) return `\u001b[1m\u001b[38;2;236;72;153m${text}${ANSI.reset}`;
  return chars.map((ch, idx) => {
    const t = idx / (chars.length - 1);
    const seg = t < 0.5 ? 0 : 1;
    const localT = seg === 0 ? t * 2 : (t - 0.5) * 2;
    const [r1, g1, b1] = stops[seg];
    const [r2, g2, b2] = stops[seg + 1];
    const r = Math.round(r1 + (r2 - r1) * localT);
    const g = Math.round(g1 + (g2 - g1) * localT);
    const b = Math.round(b1 + (b2 - b1) * localT);
    return `\u001b[1m\u001b[38;2;${r};${g};${b}m${ch}${ANSI.reset}`;
  }).join("");
}

function pluralize(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

async function isApiServerActive(port = RUNAI_DEFAULT_PORT): Promise<boolean> {
  const fetchWithTimeout = async (url: string): Promise<Response | null> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 400);
    try {
      return await fetch(url, { signal: controller.signal });
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    const healthResponse = await fetchWithTimeout(`http://127.0.0.1:${port}/health`);
    if (healthResponse) {
      if (healthResponse.ok) {
        try {
          const payload = await healthResponse.json() as { ok?: boolean };
          if (payload.ok === true) return true;
        } catch {
          // ignore parse error; continue probing
        }
      }
    }

    const modelsResponse = await fetchWithTimeout(`http://127.0.0.1:${port}/v1/models`);
    if (!modelsResponse || !modelsResponse.ok) return false;
    const payload = await modelsResponse.json() as { object?: string; data?: unknown[] };
    return payload.object === "list" && Array.isArray(payload.data);
  } catch {
    return false;
  }
}

async function isPortInUse(port = RUNAI_DEFAULT_PORT): Promise<boolean> {
  return await new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

async function stopApiServerOnPort(port = RUNAI_DEFAULT_PORT): Promise<boolean> {
  const result = Bun.spawnSync([
    "lsof",
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ]);
  if (result.exitCode !== 0) return false;
  const raw = new TextDecoder().decode(result.stdout).trim();
  if (!raw) return false;

  const pids = raw
    .split("\n")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (pids.length === 0) return false;

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore dead/unauthorized pids
    }
  }

  await Bun.sleep(350);
  if (!(await isPortInUse(port))) return true;

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore dead/unauthorized pids
    }
  }
  await Bun.sleep(200);
  return !(await isPortInUse(port));
}

function homeIntro(installedCount: number, apiActive: boolean, portInUse: boolean): string {
  const apiLabel = apiActive
    ? paint(`• API ON :${RUNAI_DEFAULT_PORT}`, ANSI.green, true)
    : portInUse
      ? paint(`• PORT IN USE :${RUNAI_DEFAULT_PORT}`, ANSI.magenta, true)
      : paint(`• API OFF :${RUNAI_DEFAULT_PORT}`, ANSI.yellow, true);
  return [
    `${gradientBrand("runai")} ${paint(`v${RUNAI_VERSION}`, ANSI.gray, true)}`,
    `   ${paint("local-first AI runtime", ANSI.gray, true)}   ${paint(`• ${installedCount} ${pluralize(installedCount, "model", "models")} installed`, ANSI.cyan, true)}   ${apiLabel}`,
  ].join("\n");
}

function getArgValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) return undefined;
  return next;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function positionalArgs(args: string[], flagsWithValues: string[]): string[] {
  const needsValue = new Set(flagsWithValues);
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token.startsWith("--")) {
      if (needsValue.has(token)) i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

function parseInstallTokens(input: string): string[] {
  return input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function stripGguf(fileName: string): string {
  return fileName.replace(/\.gguf$/i, "");
}

function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

interface MarkdownRenderState {
  inCodeBlock: boolean;
  codeLang: string;
  lineBuffer: string;
}

interface ThinkingDelimiters {
  open: RegExp;
  close: RegExp;
}

interface ParsedThinkingBlock {
  hasThinking: boolean;
  thinkingText: string;
  answerText: string;
  isOpen: boolean;
}

const THINKING_DELIMITERS: ThinkingDelimiters[] = [
  { open: /<\s*think(?:ing)?\s*>/i, close: /<\s*\/\s*think(?:ing)?\s*>/i },
  { open: /<\|begin_of_thought\|>/i, close: /<\|end_of_thought\|>/i },
  { open: /<\|start_of_thought\|>/i, close: /<\|end_of_thought\|>/i },
];

function parseThinkingBlock(text: string): ParsedThinkingBlock {
  let found: { start: number; end: number; delimiters: ThinkingDelimiters } | null = null;

  for (const delimiters of THINKING_DELIMITERS) {
    const startMatch = delimiters.open.exec(text);
    if (!startMatch || startMatch.index === undefined) continue;
    const start = startMatch.index;
    const end = start + startMatch[0].length;
    if (!found || start < found.start) {
      found = { start, end, delimiters };
    }
  }

  if (!found) {
    return {
      hasThinking: false,
      thinkingText: "",
      answerText: text,
      isOpen: false,
    };
  }

  const afterOpen = text.slice(found.end);
  const closeMatch = found.delimiters.close.exec(afterOpen);
  if (!closeMatch || closeMatch.index === undefined) {
    return {
      hasThinking: true,
      thinkingText: afterOpen,
      answerText: "",
      isOpen: true,
    };
  }

  const thinkingText = afterOpen.slice(0, closeMatch.index);
  const answerText = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  return {
    hasThinking: true,
    thinkingText,
    answerText,
    isOpen: false,
  };
}

const TS_JS_KEYWORDS = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "interface",
  "let",
  "new",
  "return",
  "switch",
  "throw",
  "try",
  "type",
  "var",
  "while",
]);

const TS_JS_TYPES = new Set([
  "any",
  "boolean",
  "never",
  "null",
  "number",
  "object",
  "string",
  "undefined",
  "unknown",
  "void",
]);

const TS_JS_TOKEN_REGEX = /(\/\/.*$|\/\*.*?\*\/|`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:async|await|break|case|catch|class|const|continue|default|else|export|extends|finally|for|from|function|if|import|interface|let|new|return|switch|throw|try|type|var|while)\b|\b(?:any|boolean|never|null|number|object|string|undefined|unknown|void)\b|\b\d+(?:\.\d+)?\b)/g;

function createMarkdownRenderState(): MarkdownRenderState {
  return {
    inCodeBlock: false,
    codeLang: "",
    lineBuffer: "",
  };
}

function isTsLike(lang: string): boolean {
  return ["js", "jsx", "javascript", "ts", "tsx", "typescript"].includes(lang);
}

function strong(text: string): string {
  if (!process.stdout.isTTY) return text;
  return `${ANSI.bold}${text}${ANSI.reset}`;
}

function formatInlineMarkdown(text: string): string {
  if (!process.stdout.isTTY || !text) return text;

  const applyInline = (segment: string): string => {
    let out = segment;
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
      return `${paint(label, ANSI.cyan)} (${paint(url, ANSI.gray, true)})`;
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, (_m, value: string) => strong(value));
    out = out.replace(/\*([^*\n]+)\*/g, (_m, value: string) => paint(value, ANSI.magenta, true));
    out = out.replace(/_([^_\n]+)_/g, (_m, value: string) => paint(value, ANSI.magenta, true));
    return out;
  };

  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const index = match.index ?? 0;
    if (index > cursor) output += applyInline(text.slice(cursor, index));
    output += paint(match[0], ANSI.yellow);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) output += applyInline(text.slice(cursor));
  return output;
}

function highlightCodeLine(line: string, lang: string): string {
  if (!process.stdout.isTTY) return line;
  if (!isTsLike(lang)) return paint(line, ANSI.cyan, true);

  // "Night" style palette for terminal syntax highlighting.
  let out = "";
  let cursor = 0;
  for (const match of line.matchAll(TS_JS_TOKEN_REGEX)) {
    const index = match.index ?? 0;
    if (index > cursor) out += line.slice(cursor, index);
    const token = match[0];

    if (token.startsWith("//") || token.startsWith("/*")) {
      out += paint(token, ANSI.gray, true);
    } else if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")) {
      out += paint(token, ANSI.green);
    } else if (TS_JS_KEYWORDS.has(token)) {
      out += paint(token, ANSI.blue);
    } else if (TS_JS_TYPES.has(token)) {
      out += paint(token, ANSI.yellow);
    } else {
      out += paint(token, ANSI.magenta);
    }
    cursor = index + token.length;
  }

  if (cursor < line.length) out += line.slice(cursor);
  return out;
}

function renderMarkdownLine(line: string, state: MarkdownRenderState): string {
  const fence = line.match(/^\s*```([\w-]+)?\s*$/);
  if (fence) {
    if (!state.inCodeBlock) {
      state.inCodeBlock = true;
      state.codeLang = (fence[1] || "").toLowerCase();
    } else {
      state.inCodeBlock = false;
      state.codeLang = "";
    }
    return paint(line, ANSI.gray, true);
  }

  if (state.inCodeBlock) return highlightCodeLine(line, state.codeLang);
  if (!process.stdout.isTTY) return line;

  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    const level = heading[1].length;
    const content = formatInlineMarkdown(heading[2]);
    if (level <= 2) return `${strong(content)}`;
    return `${paint("#".repeat(level), ANSI.gray, true)} ${strong(content)}`;
  }

  const quote = line.match(/^\s*>\s?(.*)$/);
  if (quote) {
    return `${paint("│", ANSI.gray, true)} ${paint(formatInlineMarkdown(quote[1]), ANSI.gray, true)}`;
  }

  const bullet = line.match(/^(\s*)([-*+])\s+(.*)$/);
  if (bullet) {
    return `${bullet[1]}${paint("•", ANSI.cyan)} ${formatInlineMarkdown(bullet[3])}`;
  }

  const ordered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (ordered) {
    return `${ordered[1]}${paint(`${ordered[2]}.`, ANSI.cyan)} ${formatInlineMarkdown(ordered[3])}`;
  }

  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    return paint("────────────────────────", ANSI.gray, true);
  }

  return formatInlineMarkdown(line);
}

function renderMarkdownDelta(delta: string, state: MarkdownRenderState): string {
  state.lineBuffer += delta;
  let out = "";
  while (true) {
    const newlineIndex = state.lineBuffer.indexOf("\n");
    if (newlineIndex === -1) break;
    const line = state.lineBuffer.slice(0, newlineIndex);
    state.lineBuffer = state.lineBuffer.slice(newlineIndex + 1);
    out += `${renderMarkdownLine(line, state)}\n`;
  }
  return out;
}

function flushMarkdownDelta(state: MarkdownRenderState): string {
  if (!state.lineBuffer) return "";
  const remainder = renderMarkdownLine(state.lineBuffer, state);
  state.lineBuffer = "";
  return remainder;
}

interface InstalledModelOption {
  id: string;
  name: string;
  path: string;
}

interface PromptNavigationOptions {
  allowBackOnCancel?: boolean;
}

function normalizeModelId(value: string): string {
  return stripGguf(basename(value)).trim().toLowerCase();
}

async function listInstalledModelOptions(): Promise<InstalledModelOption[]> {
  const dbModels = await listInstalledModels();
  const options: InstalledModelOption[] = [];
  for (const record of dbModels) {
    if (!isModelFilePresent(record.path)) {
      await removeInstalledModelById(record.id);
      continue;
    }
    options.push({
      id: record.id,
      name: record.name,
      path: record.path,
    });
  }
  if (options.length > 0) return options;

  // Bootstrap DB from existing files if this is an older installation.
  const diskModels = await listInstalledModelPaths();
  for (const path of diskModels) {
    const id = normalizeModelId(path);
    await upsertInstalledModel({
      id,
      name: stripGguf(basename(path)),
      path,
      sourceUrl: null,
      sourceRepo: null,
      sourceFile: null,
    });
    options.push({
      id,
      name: stripGguf(basename(path)),
      path,
    });
  }
  return options;
}

function isLikelyProjectorModel(filePath: string): boolean {
  const normalized = basename(filePath).toLowerCase();
  const blockedTokens = ["mmproj", "clip", "projector", "vision"];
  return blockedTokens.some((token) => normalized.includes(token));
}

function uiFitScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score * 0.72)));
}

function recommendationOptionLabel(item: RecommendedModel, index: number): string {
  const quant = paint(`[${item.quant}]`, ANSI.gray);
  const fit = uiFitScore(item.score);
  const fitLine = `   ${paint("☆ Fit:", ANSI.magenta, true)} ${paint(`${fit}/100`, ANSI.green, true)}`;
  const metricsLine = `   ${paint("⛁", ANSI.cyan, true)} ${paint("Disk:", ANSI.cyan, true)} ${paint(`${item.memoryNeededGB} GB`, ANSI.cyan, true)}   ${paint("⛃", ANSI.cyan, true)} ${paint("VRAM:", ANSI.cyan, true)} ${paint(`~${item.diskNeededGB} GB`, ANSI.cyan, true)}`;
  const speedLine = `   ${paint("⚡Speed expected:", ANSI.yellow)} ~${item.expectedTokensPerSec ?? "?"} tok/s`;
  return `${paint(String(index + 1), ANSI.bold)}. ${item.name} ${quant}\n${fitLine}\n${metricsLine}\n${speedLine}\n`;
}

function searchableModelLabel(item: RecommendedModel): string {
  const quant = paint(`[${item.quant}]`, ANSI.gray);
  return `${item.name} ${quant}`;
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
    const byId = available.find(
      (item) => item.id.toLowerCase() === normalized,
    );
    addByModel(byId);
  }

  return [...unique.values()];
}

async function promptInstallSelection(
  recommendations: RecommendedModel[],
  catalog: RecommendedModel[],
  options: PromptNavigationOptions = {},
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
        {
          value: "__search__",
          label: paint("🔎 Search models", ANSI.cyan),
        },
      ],
    });

    if (p.isCancel(selection)) {
      return null;
    }

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
      if (p.isCancel(searched)) {
        return null;
      }
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
  const input = direct ?? await promptInstallSelection(recommendations, catalog, options);
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
    await upsertInstalledModel({
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
  if (p.isCancel(openNow)) {
    return "cancelled";
  }
  if (openNow) {
    await handleChat([], options);
  } else {
    p.log.info("Next: run `runai chat` to start chatting with an installed model.");
  }
  return "completed";
}

async function resolveChatModel(args: string[], options: PromptNavigationOptions = {}): Promise<string | null> {
  const explicit = getArgValue(args, "--model");
  if (explicit) {
    if (explicit.includes("/") || explicit.endsWith(".gguf")) return explicit;
    const installedById = await getInstalledModelById(normalizeModelId(explicit));
    if (installedById && isModelFilePresent(installedById.path)) {
      return installedById.path;
    }
    return explicit;
  }

  const installed = await listInstalledModelOptions();
  if (installed.length === 0) {
    throw new Error("No installed models found. Install one first with `runai recommend` or `runai pull`.");
  }
  if (installed.length === 1) return installed[0].path;

  usePromptLegend("list");
  const selected = await p.select({
    message: "Choose installed model for chat",
    output: getPromptOutput(),
    options: installed.map((item) => {
      return {
        value: item.path,
        label: `${item.name} (${item.id})`,
        hint: item.path,
      };
    }),
  });
  if (p.isCancel(selected)) {
    return null;
  }
  return selected;
}

export async function handleChat(
  args: string[],
  options: PromptNavigationOptions = {},
): Promise<void> {
  let modelPath: string;
  try {
    const resolvedModelPath = await resolveChatModel(args, options);
    if (!resolvedModelPath) return;
    modelPath = resolvedModelPath;
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : "Unable to start chat.");
    return;
  }
  p.log.message(`${paint("Model", ANSI.gray, true)} ${paint(basename(modelPath), ANSI.cyan)}`, { symbol: " " });
  p.log.message(
    `${paint("Tips", ANSI.gray, true)} /exit to quit  ·  Ctrl+T or /think toggle thinking`,
    { symbol: " " },
  );

  const history: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  let showThinking = true;
  const renderChatFooter = (): void => {
    setPromptFooter(
      `[enter] send | [esc] back | [ctrl+t or /think] thinking: ${showThinking ? "ON" : "OFF"} | [ctrl+c] cancel`,
    );
  };
  while (true) {
    renderChatFooter();
    const userInput = await p.text({ message: "You" });
    if (p.isCancel(userInput)) {
      p.cancel("Chat cancelled.");
      break;
    }
    const prompt = userInput.trim();
    if (!prompt) continue;
    if (prompt === "/think" || prompt === "/thinking") {
      showThinking = !showThinking;
      p.log.info(`Thinking view ${showThinking ? "enabled" : "disabled"}.`);
      continue;
    }
    if (prompt === "/exit" || prompt === "/quit") {
      p.outro("Chat ended.");
      break;
    }

    history.push({ role: "user", content: prompt });
    const recent = history.slice(-16);
    let cleanupInput: (() => void) | null = null;
    let thinkingAnimationTimer: ReturnType<typeof setInterval> | null = null;
    try {
      const startedAt = Date.now();
      let fullText = "";
      let displayedAnswer = "";
      let latestThinkingText = "";
      const markdownRenderState = createMarkdownRenderState();
      let shownThinkingLines = 0;
      let hasThinkBlock = false;
      let thinkStartedAt: number | null = null;
      let thinkEndedAt: number | null = null;
      let responseHeaderShown = false;
      let keyListenerAttached = false;
      let statusMode: "thinking" | "replied" = "thinking";
      let thinkingGradientPhase = 0;
      const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void; isRaw?: boolean };
      const wasRawMode = Boolean(stdin.isRaw);

      const clearThinking = (): void => {
        if (!process.stdout.isTTY || shownThinkingLines === 0) return;
        for (let i = 0; i < shownThinkingLines; i += 1) {
          process.stdout.write("\u001b[1A");
          process.stdout.write("\r\u001b[2K");
        }
        shownThinkingLines = 0;
      };
      const renderThinking = (thinkingText: string): void => {
        if (!process.stdout.isTTY) return;
        const lines = thinkingText
          .replace(/\r/g, "")
          .split("\n")
          .map((line) => line.trimEnd())
          .slice(-8);
        clearThinking();
        const title = statusMode === "thinking"
          ? waveGradient("Thinking", thinkingGradientPhase)
          : paint("Assistant replied", ANSI.green);
        process.stdout.write(`${title}\n`);
        for (const line of lines) {
          process.stdout.write(`${paint(line || " ", ANSI.gray, true)}\n`);
        }
        shownThinkingLines = lines.length + 1;
      };

      const stopThinkingAnimation = (): void => {
        if (!thinkingAnimationTimer) return;
        clearInterval(thinkingAnimationTimer);
        thinkingAnimationTimer = null;
      };

      const setRepliedStatus = (): void => {
        if (statusMode === "replied") return;
        statusMode = "replied";
        stopThinkingAnimation();
        if (showThinking) renderThinking(latestThinkingText);
      };

      const onKeypress = (buffer: Buffer): void => {
        // Ctrl+T
        if (buffer.length === 1 && buffer[0] === 0x14) {
          showThinking = !showThinking;
          renderChatFooter();
          if (!showThinking) {
            clearThinking();
            return;
          }
          if (latestThinkingText) {
            renderThinking(latestThinkingText);
          } else if (statusMode === "thinking" || statusMode === "replied") {
            renderThinking("");
          }
        }
      };

      if (stdin.isTTY && typeof stdin.setRawMode === "function") {
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", onKeypress);
        keyListenerAttached = true;
        cleanupInput = () => {
          if (!keyListenerAttached) return;
          stdin.off("data", onKeypress);
          stdin.setRawMode?.(wasRawMode);
          keyListenerAttached = false;
        };
      }

      if (process.stdout.isTTY) {
        if (showThinking) renderThinking("");
        thinkingAnimationTimer = setInterval(() => {
          if (!showThinking || statusMode !== "thinking") return;
          thinkingGradientPhase += 1;
          renderThinking(latestThinkingText);
        }, 90);
      } else {
        p.log.step("Thinking...");
      }

      let thoughtSegmentOpen = false;
      await runLlamaStreamWithSegments(
        {
          modelPath,
          prompt: buildPrompt(recent),
          temperature: 0.7,
          maxTokens: 512,
        },
        (chunk) => {
          if (chunk.segmentType === "thought" || chunk.segmentType === "comment") {
            if (chunk.segmentStart && !thoughtSegmentOpen) {
              fullText += "<think>";
              thoughtSegmentOpen = true;
            }
            if (!thoughtSegmentOpen) {
              fullText += "<think>";
              thoughtSegmentOpen = true;
            }
            fullText += chunk.text;
            if (chunk.segmentEnd && thoughtSegmentOpen) {
              fullText += "</think>";
              thoughtSegmentOpen = false;
            }
          } else {
            fullText += chunk.text;
          }

          const parsed = parseThinkingBlock(fullText);
          let visibleAnswer = parsed.answerText;

          if (parsed.hasThinking) {
            hasThinkBlock = true;
            if (!thinkStartedAt) thinkStartedAt = Date.now();
            latestThinkingText = parsed.thinkingText;

            if (parsed.isOpen) {
              if (showThinking) {
                renderThinking(latestThinkingText);
              } else {
                clearThinking();
              }
              visibleAnswer = "";
            } else if (showThinking && latestThinkingText.trim()) {
              renderThinking(latestThinkingText);
            } else if (!showThinking) {
              clearThinking();
            }

            if (!parsed.isOpen && !thinkEndedAt) {
              thinkEndedAt = Date.now();
            }
          } else {
            latestThinkingText = "";
            visibleAnswer = fullText;
          }

          if (!visibleAnswer) return;
          setRepliedStatus();
          const delta = visibleAnswer.slice(displayedAnswer.length);
          if (!delta) return;
          if (!responseHeaderShown) {
            responseHeaderShown = true;
            process.stdout.write("🤖  ");
          }
          process.stdout.write(renderMarkdownDelta(delta, markdownRenderState));
          displayedAnswer = visibleAnswer;
        },
      );

      if (thoughtSegmentOpen) {
        fullText += "</think>";
      }

      if (responseHeaderShown) {
        const tail = flushMarkdownDelta(markdownRenderState);
        if (tail) process.stdout.write(tail);
      }
      setRepliedStatus();

      if (!showThinking) {
        clearThinking();
      }
      if (showThinking && hasThinkBlock) {
        if (!responseHeaderShown) process.stdout.write("\n");
      }
      if (responseHeaderShown) process.stdout.write("\n");
      renderChatFooter();

      const parsed = parseThinkingBlock(fullText);
      const answer = parsed.hasThinking ? parsed.answerText.trim() : fullText.trim();

      if (!responseHeaderShown) {
        p.log.message(answer, { symbol: "🤖" });
      }

      const elapsedMs = Math.max(1, Date.now() - startedAt);
      const tokens = estimateTokens(answer);
      const tps = tokens / (elapsedMs / 1000);
      const metrics = [
        `${paint("⚡", ANSI.yellow)} ${paint(`${tps.toFixed(1)} tok/s`, ANSI.yellow)}`,
        `${paint("⏱", ANSI.cyan)} ${paint(formatSeconds(elapsedMs), ANSI.cyan)}`,
      ];
      if (hasThinkBlock && thinkStartedAt && thinkEndedAt && thinkEndedAt >= thinkStartedAt) {
        metrics.push(`${paint("🧠", ANSI.magenta)} ${paint(`${formatSeconds(thinkEndedAt - thinkStartedAt)} thinking`, ANSI.magenta)}`);
      }
      p.log.info(metrics.join("  ·  "));

      history.push({ role: "assistant", content: answer });
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : "Inference failed");
    } finally {
      if (thinkingAnimationTimer) {
        clearInterval(thinkingAnimationTimer);
      }
      cleanupInput?.();
    }
  }
  setPromptFooter("");
}

async function handleDeleteModels(
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
    options: installed.map((item) => {
      return {
        value: item.path,
        label: `${item.name} (${item.id})`,
        hint: item.path,
      };
    }),
  });

  if (p.isCancel(selected)) {
    return "cancelled";
  }
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
  if (p.isCancel(ok)) {
    return "cancelled";
  }
  if (!ok) {
    p.log.info("Delete cancelled.");
    return "completed";
  }

  for (const modelPath of selected) {
    await unlink(modelPath);
    await removeInstalledModelByPath(modelPath);
    p.log.success(`Deleted ${basename(modelPath)}`);
  }
  return "completed";
}

export async function handleHome(): Promise<void> {
  while (true) {
    const installed = await listInstalledModelOptions();
    const apiActive = await isApiServerActive();
    const portInUse = apiActive ? false : await isPortInUse();
    if (installed.length === 0) {
      const status = await handleRecommend([], { allowBackOnCancel: true });
      if (status === "cancelled") {
        return;
      }
      continue;
    }

    p.intro(homeIntro(installed.length, apiActive, portInUse));
    usePromptLegend("list");
    const action = await p.select({
      message: "Choose an action:",
      output: getPromptOutput(),
      options: [
        {
          value: "chat",
          label: "☻  Open an interactive chat session",
        },
        {
          value: "install",
          label: "⚙︎  Install more models",
        },
        {
          value: "delete",
          label: "♻  Delete models",
        },
        {
          value: "api",
          label: apiActive
            ? `◼  Stop local OpenAI-compatible API ${paint(`(port ${RUNAI_DEFAULT_PORT})`, ANSI.gray, true)}`
            : `☁︎  Start local OpenAI-compatible API ${paint(`(port ${RUNAI_DEFAULT_PORT})`, ANSI.gray, true)}`,
        },
      ],
    });

    if (p.isCancel(action)) {
      return;
    }

    if (action === "chat") {
      await handleChat([], { allowBackOnCancel: true });
      continue;
    }
    if (action === "install") {
      await handleRecommend([], { allowBackOnCancel: true });
      continue;
    }
    if (action === "delete") {
      const status = await handleDeleteModels({ allowBackOnCancel: true });
      if (status === "completed") {
        p.outro("Done.");
      }
      continue;
    }
    if (action === "api") {
      if (apiActive) {
        const confirmStop = await p.confirm({
          message: `Stop local API on port ${RUNAI_DEFAULT_PORT}?`,
          initialValue: true,
          output: getPromptOutput(),
        });
        if (p.isCancel(confirmStop) || !confirmStop) {
          continue;
        }
        const stopped = await stopApiServerOnPort(RUNAI_DEFAULT_PORT);
        if (stopped) {
          p.log.success(`API stopped on port ${RUNAI_DEFAULT_PORT}`);
        } else {
          p.log.warn(`Could not stop process on port ${RUNAI_DEFAULT_PORT}`);
        }
        continue;
      }
      if (portInUse) {
        p.log.warn(`Port ${RUNAI_DEFAULT_PORT} is already in use by another process.`);
        p.log.info(`Use another port: runai api --port 11436`);
        continue;
      }
      const started = await handleServe([]);
      if (started) {
        p.log.success(`API running on http://localhost:${RUNAI_DEFAULT_PORT}`);
      }
      continue;
    }
  }
}

export async function handleRecommend(
  args: string[],
  options: PromptNavigationOptions = {},
): Promise<"completed" | "cancelled"> {
  const limit = Number(getArgValue(args, "--top") || "3");
  const hw = await detectMacHardware();
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

export async function handleBrowse(args: string[]): Promise<void> {
  const query = positionalArgs(args, ["--limit"]).join(" ");
  const limit = Number(getArgValue(args, "--limit") || "25");
  const hw = await detectMacHardware();
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
  await upsertInstalledModel({
    id,
    name: stripGguf(name || basename(installedPath)),
    path: installedPath,
    sourceUrl: url,
    sourceRepo: null,
    sourceFile: basename(installedPath),
  });
}

async function resolveServeModel(args: string[]): Promise<string | undefined> {
  const explicit = getArgValue(args, "--model");
  if (explicit) return explicit;

  const installed = await listInstalledModelOptions();
  if (installed.length === 0) return undefined;
  if (!process.stdin.isTTY || installed.length === 1) return installed[0].path;

  usePromptLegend("list");
  const selected = await p.select({
    message: "Choose installed model for API server",
    output: getPromptOutput(),
    options: installed.map((item) => ({
      value: item.path,
      label: `${item.name} (${item.id})`,
      hint: item.path,
    })),
  });
  if (p.isCancel(selected)) return undefined;
  return selected;
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

interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

export async function handleDoctor(args: string[]): Promise<void> {
  const asJson = hasFlag(args, "--json");
  const explicitModel = getArgValue(args, "--model");
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "runtime",
    status: typeof Bun !== "undefined" ? "ok" : "fail",
    detail: typeof Bun !== "undefined" ? `bun ${Bun.version}` : "Bun runtime unavailable",
    fix: typeof Bun !== "undefined" ? undefined : "Install Bun and re-run runai.",
  });

  checks.push({
    name: "platform",
    status: "ok",
    detail: `${platform()} ${arch()}`,
  });

  try {
    const modelDir = await ensureModelDir();
    await access(modelDir, constants.R_OK | constants.W_OK);
    checks.push({
      name: "model-dir",
      status: "ok",
      detail: modelDir,
    });
  } catch (error) {
    checks.push({
      name: "model-dir",
      status: "fail",
      detail: error instanceof Error ? error.message : "Cannot access model directory",
      fix: `Set RUNAI_MODEL_DIR to a writable directory (current: ${RUNAI_MODEL_DIR}).`,
    });
  }

  const runtimeSpinner = asJson ? null : p.spinner();
  runtimeSpinner?.start("Checking node-llama-cpp runtime...");
  try {
    const module = await import("node-llama-cpp");
    if (typeof module.getLlama !== "function") {
      throw new Error("node-llama-cpp loaded but getLlama() was not found");
    }
    await module.getLlama();
    runtimeSpinner?.stop("node-llama-cpp is ready");
    checks.push({
      name: "node-llama-cpp",
      status: "ok",
      detail: "native bindings loaded successfully",
    });
  } catch (error) {
    runtimeSpinner?.stop("node-llama-cpp check failed");
    checks.push({
      name: "node-llama-cpp",
      status: "fail",
      detail: error instanceof Error ? error.message : "runtime init failed",
      fix: "Run `bun pm trust node-llama-cpp` and reinstall dependencies.",
    });
  }

  const installed = await listInstalledModelPaths();
  checks.push({
    name: "installed-models",
    status: installed.length > 0 ? "ok" : "warn",
    detail: `${installed.length} model(s) found`,
    fix: installed.length > 0 ? undefined : "Install one with `runai recommend --install`.",
  });

  const suspiciousByName = installed.filter(isLikelyProjectorModel);
  if (suspiciousByName.length > 0) {
    checks.push({
      name: "model-filenames",
      status: "warn",
      detail: `${suspiciousByName.length} possible mmproj/CLIP file(s): ${suspiciousByName.map((file) => basename(file)).join(", ")}`,
      fix: "Delete these files and reinstall text GGUF models with `runai recommend`.",
    });
  } else if (installed.length > 0) {
    checks.push({
      name: "model-filenames",
      status: "ok",
      detail: "no obvious mmproj/CLIP file names detected",
    });
  }

  if (installed.length > 0) {
    try {
      const { readGgufFileInfo } = await import("node-llama-cpp");
      const clipModels: string[] = [];
      for (const filePath of installed.slice(0, 12)) {
        const info = await readGgufFileInfo(filePath, { readTensorInfo: false, logWarnings: false });
        const arch = String(info.metadata.general.architecture || "").toLowerCase();
        if (arch === "clip") clipModels.push(basename(filePath));
      }
      if (clipModels.length > 0) {
        checks.push({
          name: "model-architecture",
          status: "warn",
          detail: `${clipModels.length} installed model(s) are CLIP/mmproj: ${clipModels.join(", ")}`,
          fix: "Delete these files and install a text chat GGUF model (`runai recommend`).",
        });
      } else {
        checks.push({
          name: "model-architecture",
          status: "ok",
          detail: "installed GGUF architecture checks look valid",
        });
      }
    } catch (error) {
      checks.push({
        name: "model-architecture",
        status: "warn",
        detail: error instanceof Error ? error.message : "unable to inspect GGUF metadata",
      });
    }
  }

  if (explicitModel) {
    try {
      const target = explicitModel.includes("/") || explicitModel.includes("\\")
        ? explicitModel
        : join(RUNAI_MODEL_DIR, explicitModel);
      const modelInfo = await stat(target);
      let architecture: string | null = null;
      try {
        const { readGgufFileInfo } = await import("node-llama-cpp");
        const info = await readGgufFileInfo(target, { readTensorInfo: false, logWarnings: false });
        architecture = String(info.metadata.general.architecture || "").toLowerCase();
      } catch {
        architecture = null;
      }
      checks.push({
        name: "model-check",
        status: architecture === "clip" || isLikelyProjectorModel(target) ? "warn" : "ok",
        detail: `${basename(target)} (${Math.round(modelInfo.size / (1024 * 1024))} MB)${architecture ? ` [arch=${architecture}]` : ""}`,
        fix: architecture === "clip" || isLikelyProjectorModel(target)
          ? "This is a projector file (CLIP/mmproj). Use a chat/instruct GGUF main model."
          : undefined,
      });
    } catch (error) {
      checks.push({
        name: "model-check",
        status: "fail",
        detail: error instanceof Error ? error.message : "cannot inspect model file",
        fix: "Pass an existing file path with `--model` or install the model first.",
      });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ checks }, null, 2));
    return;
  }

  p.intro("runai doctor");
  for (const check of checks) {
    const prefix = check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗";
    const logFn = check.status === "ok" ? p.log.success : check.status === "warn" ? p.log.warn : p.log.error;
    logFn(`${prefix} ${check.name}: ${check.detail}`);
    if (check.fix) {
      p.log.info(`   fix: ${check.fix}`);
    }
  }

  const hasFailures = checks.some((check) => check.status === "fail");
  const hasWarnings = checks.some((check) => check.status === "warn");
  if (hasFailures) {
    p.outro("Doctor found blocking issues.");
    return;
  }
  if (hasWarnings) {
    p.outro("Doctor finished with warnings.");
    return;
  }
  p.outro("Doctor says your setup looks healthy.");
}

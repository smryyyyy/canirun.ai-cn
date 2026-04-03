import * as p from "@clack/prompts";
import { basename } from "node:path";
import { runLlamaStream, countTokens } from "../llamacpp";
import { ANSI, paint } from "../terminal";
import { hasFlag, stripGguf, resolveChatModel } from "../cli-utils";

export async function handleBench(args: string[]): Promise<void> {
  const asJson = hasFlag(args, "--json");
  let modelPath: string;

  try {
    const resolved = await resolveChatModel(args);
    if (!resolved) return;
    modelPath = resolved;
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : "Unable to start benchmark.");
    return;
  }

  const modelName = stripGguf(basename(modelPath));
  if (!asJson) {
    p.intro(`runai bench — ${modelName}`);
    p.log.step("Running benchmark (3 rounds)...");
  }

  const prompts = [
    "Write a short poem about programming.",
    "Explain how a hash table works in 3 sentences.",
    "What are the main differences between TCP and UDP? Be concise.",
  ];

  const results: Array<{
    prompt: string;
    tokensGenerated: number;
    timeMs: number;
    tokensPerSec: number;
    firstTokenMs: number;
  }> = [];

  for (const [idx, prompt] of prompts.entries()) {
    if (!asJson) {
      const spinner = p.spinner();
      spinner.start(`Round ${idx + 1}/${prompts.length}...`);
    }

    const startedAt = Date.now();
    let firstTokenAt: number | null = null;
    let fullText = "";

    await runLlamaStream(
      { modelPath, prompt, temperature: 0.7, maxTokens: 256 },
      (chunk) => {
        if (!firstTokenAt) firstTokenAt = Date.now();
        fullText += chunk;
      },
    );

    const elapsed = Date.now() - startedAt;
    const tokenCount = await countTokens(modelPath, fullText);
    const tps = tokenCount / (elapsed / 1000);
    const ttft = firstTokenAt ? firstTokenAt - startedAt : elapsed;

    results.push({
      prompt,
      tokensGenerated: tokenCount,
      timeMs: elapsed,
      tokensPerSec: Math.round(tps * 10) / 10,
      firstTokenMs: ttft,
    });
  }

  const avgTps = results.reduce((sum, r) => sum + r.tokensPerSec, 0) / results.length;
  const avgTtft = results.reduce((sum, r) => sum + r.firstTokenMs, 0) / results.length;
  const totalTokens = results.reduce((sum, r) => sum + r.tokensGenerated, 0);

  const summary = {
    model: modelName,
    path: modelPath,
    rounds: results.length,
    avgTokensPerSec: Math.round(avgTps * 10) / 10,
    avgFirstTokenMs: Math.round(avgTtft),
    totalTokensGenerated: totalTokens,
    results,
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  for (const [idx, r] of results.entries()) {
    p.log.message(
      `Round ${idx + 1}: ${paint(`${r.tokensPerSec} tok/s`, ANSI.yellow)} · ${paint(`${r.tokensGenerated} tokens`, ANSI.cyan)} · ${paint(`TTFT ${r.firstTokenMs}ms`, ANSI.green)} · ${paint(`${(r.timeMs / 1000).toFixed(2)}s total`, ANSI.gray, true)}`,
      { symbol: "◆" },
    );
  }

  p.log.message([
    "",
    `${paint("Average speed", ANSI.bold)}     ${paint(`${summary.avgTokensPerSec} tok/s`, ANSI.yellow)}`,
    `${paint("Average TTFT", ANSI.bold)}      ${paint(`${summary.avgFirstTokenMs}ms`, ANSI.green)}`,
    `${paint("Total tokens", ANSI.bold)}      ${paint(`${summary.totalTokensGenerated}`, ANSI.cyan)}`,
  ].join("\n"), { symbol: "◇" });

  p.outro("Benchmark complete.");
}

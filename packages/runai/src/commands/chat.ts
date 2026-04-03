import * as p from "@clack/prompts";
import { basename } from "node:path";
import { runLlamaStreamWithSegments } from "../llamacpp";
import { buildPrompt } from "../openai";
import { getPromptOutput, setPromptFooter, usePromptLegend } from "../prompt-footer";
import {
  ANSI, paint,
  parseThinkingBlock, waveGradient,
  createMarkdownRenderState, renderMarkdownDelta, flushMarkdownDelta,
} from "../terminal";
import {
  estimateTokens, formatSeconds,
  resolveChatModel,
  type PromptNavigationOptions,
} from "../cli-utils";

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

      if (!showThinking) clearThinking();
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
      if (thinkingAnimationTimer) clearInterval(thinkingAnimationTimer);
      cleanupInput?.();
    }
  }
  setPromptFooter("");
}

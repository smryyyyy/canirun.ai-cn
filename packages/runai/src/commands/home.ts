import * as p from "@clack/prompts";
import { RUNAI_DEFAULT_PORT, RUNAI_VERSION } from "../config";
import { isApiServerActive, isPortInUse, stopApiServerOnPort } from "../process-manager";
import { getPromptOutput, usePromptLegend } from "../prompt-footer";
import { ANSI, paint, gradientBrand, pluralize } from "../terminal";
import { listInstalledModelOptions } from "../cli-utils";
import { handleChat } from "./chat";
import { handleRecommend } from "./recommend-install";
import { handleDeleteModels } from "./simple";
import { handleServe } from "./simple";

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

export async function handleHome(): Promise<void> {
  while (true) {
    const installed = await listInstalledModelOptions();
    const apiActive = await isApiServerActive();
    const portInUse = apiActive ? false : await isPortInUse();
    if (installed.length === 0) {
      const status = await handleRecommend([], { allowBackOnCancel: true });
      if (status === "cancelled") return;
      continue;
    }

    p.intro(homeIntro(installed.length, apiActive, portInUse));
    usePromptLegend("list");
    const action = await p.select({
      message: "Choose an action:",
      output: getPromptOutput(),
      options: [
        { value: "chat", label: "☻  Open an interactive chat session" },
        { value: "install", label: "⚙︎  Install more models" },
        { value: "delete", label: "♻  Delete models" },
        {
          value: "api",
          label: apiActive
            ? `◼  Stop local OpenAI-compatible API ${paint(`(port ${RUNAI_DEFAULT_PORT})`, ANSI.gray, true)}`
            : `☁︎  Start local OpenAI-compatible API ${paint(`(port ${RUNAI_DEFAULT_PORT})`, ANSI.gray, true)}`,
        },
      ],
    });

    if (p.isCancel(action)) return;

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
      if (status === "completed") p.outro("Done.");
      continue;
    }
    if (action === "api") {
      if (apiActive) {
        const confirmStop = await p.confirm({
          message: `Stop local API on port ${RUNAI_DEFAULT_PORT}?`,
          initialValue: true,
          output: getPromptOutput(),
        });
        if (p.isCancel(confirmStop) || !confirmStop) continue;
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

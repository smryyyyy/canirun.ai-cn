import * as p from "@clack/prompts";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNAI_DEFAULT_PORT, RUNAI_DAEMON_PID_FILE, RUNAI_DAEMON_LOG_FILE } from "../config";
import { isApiServerActive, stopApiServerOnPort } from "../process-manager";
import { getArgValue } from "../cli-utils";

export async function handleDaemon(args: string[]): Promise<void> {
  const modelArg = getArgValue(args, "--model");
  const portArg = getArgValue(args, "--port");
  const port = portArg ? Number(portArg) : RUNAI_DEFAULT_PORT;

  const active = await isApiServerActive(port);
  if (active) {
    p.log.warn(`API server already running on port ${port}`);
    return;
  }

  const cliPath = join(import.meta.dir, "..", "cli.ts");
  const childArgs = ["bun", cliPath, "serve"];
  if (modelArg) childArgs.push("--model", modelArg);
  if (portArg) childArgs.push("--port", portArg);

  const proc = Bun.spawn(childArgs, {
    stdout: Bun.file(RUNAI_DAEMON_LOG_FILE),
    stderr: Bun.file(RUNAI_DAEMON_LOG_FILE),
    stdin: "ignore",
  });

  const pid = proc.pid;
  await writeFile(RUNAI_DAEMON_PID_FILE, String(pid));

  p.log.success(`runai daemon started (PID ${pid}) on port ${port}`);
  p.log.info(`Logs: ${RUNAI_DAEMON_LOG_FILE}`);
  p.log.info(`Stop with: runai stop`);
}

export async function handleStop(): Promise<void> {
  try {
    const pidContent = await readFile(RUNAI_DAEMON_PID_FILE, "utf-8");
    const pid = Number.parseInt(pidContent.trim(), 10);

    if (!Number.isInteger(pid) || pid <= 0) {
      p.log.error("Invalid PID file.");
      return;
    }

    try {
      process.kill(pid, "SIGTERM");
      p.log.success(`Stopped runai daemon (PID ${pid})`);
    } catch {
      p.log.warn(`Process ${pid} not found (may have already stopped).`);
    }

    await unlink(RUNAI_DAEMON_PID_FILE).catch(() => {});
  } catch {
    const stopped = await stopApiServerOnPort(RUNAI_DEFAULT_PORT);
    if (stopped) {
      p.log.success("Stopped runai process on default port.");
    } else {
      p.log.warn("No runai daemon found to stop.");
    }
  }
}

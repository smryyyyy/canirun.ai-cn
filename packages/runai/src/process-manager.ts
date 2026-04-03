import { createConnection } from "node:net";
import { RUNAI_DEFAULT_PORT } from "./config";

export async function isApiServerActive(port = RUNAI_DEFAULT_PORT): Promise<boolean> {
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
    const [healthResponse, modelsResponse] = await Promise.all([
      fetchWithTimeout(`http://127.0.0.1:${port}/health`),
      fetchWithTimeout(`http://127.0.0.1:${port}/v1/models`),
    ]);

    if (healthResponse?.ok) {
      try {
        const payload = await healthResponse.json() as { ok?: boolean };
        if (payload.ok === true) return true;
      } catch { /* ignore parse error */ }
    }

    if (!modelsResponse?.ok) return false;
    const payload = await modelsResponse.json() as { object?: string; data?: unknown[] };
    return payload.object === "list" && Array.isArray(payload.data);
  } catch {
    return false;
  }
}

export async function isPortInUse(port = RUNAI_DEFAULT_PORT): Promise<boolean> {
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

export async function stopApiServerOnPort(port = RUNAI_DEFAULT_PORT): Promise<boolean> {
  const result = Bun.spawnSync([
    "lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t",
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
    try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
  }

  await Bun.sleep(350);
  if (!(await isPortInUse(port))) return true;

  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
  }
  await Bun.sleep(200);
  return !(await isPortInUse(port));
}

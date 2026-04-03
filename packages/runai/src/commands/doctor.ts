import * as p from "@clack/prompts";
import { access, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { arch, platform } from "node:os";
import { constants } from "node:fs";
import { RUNAI_MODEL_DIR } from "../config";
import { ensureModelDir, listInstalledModelPaths } from "../model-store";
import { hasFlag, getArgValue, isLikelyProjectorModel } from "../cli-utils";

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

  checks.push({ name: "platform", status: "ok", detail: `${platform()} ${arch()}` });

  try {
    const modelDir = await ensureModelDir();
    await access(modelDir, constants.R_OK | constants.W_OK);
    checks.push({ name: "model-dir", status: "ok", detail: modelDir });
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
    checks.push({ name: "node-llama-cpp", status: "ok", detail: "native bindings loaded successfully" });
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
    checks.push({ name: "model-filenames", status: "ok", detail: "no obvious mmproj/CLIP file names detected" });
  }

  if (installed.length > 0) {
    try {
      const { readGgufFileInfo } = await import("node-llama-cpp");
      const clipModels: string[] = [];
      for (const filePath of installed.slice(0, 12)) {
        const info = await readGgufFileInfo(filePath, { readTensorInfo: false, logWarnings: false });
        const archName = String(info.metadata.general.architecture || "").toLowerCase();
        if (archName === "clip") clipModels.push(basename(filePath));
      }
      if (clipModels.length > 0) {
        checks.push({
          name: "model-architecture",
          status: "warn",
          detail: `${clipModels.length} installed model(s) are CLIP/mmproj: ${clipModels.join(", ")}`,
          fix: "Delete these files and install a text chat GGUF model (`runai recommend`).",
        });
      } else {
        checks.push({ name: "model-architecture", status: "ok", detail: "installed GGUF architecture checks look valid" });
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

  const hasFailures = checks.some((c) => c.status === "fail");
  const hasWarnings = checks.some((c) => c.status === "warn");
  if (hasFailures) { p.outro("Doctor found blocking issues."); return; }
  if (hasWarnings) { p.outro("Doctor finished with warnings."); return; }
  p.outro("Doctor says your setup looks healthy.");
}

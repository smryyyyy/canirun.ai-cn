import { existsSync } from "node:fs";
import type { CliHardwareInfo } from "./types";

function run(command: string, args: string[]): string {
  try {
    const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) return "";
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    return "";
  }
}

function readFileNative(path: string): string {
  try {
    if (!existsSync(path)) return "";
    return new TextDecoder().decode(Bun.file(path).stream() as unknown as ArrayBuffer);
  } catch {
    return "";
  }
}

async function readFileAsync(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    return "";
  }
}

interface GpuInfo {
  name: string;
  vendor: string;
  vramMB: number;
  bandwidthGBs: number;
}

function detectNvidiaGpu(): GpuInfo | null {
  const smiOutput = run("nvidia-smi", ["--query-gpu=name,memory.total,pci.bus_id", "--format=csv,noheader,nounits"]);
  if (!smiOutput) return null;

  const firstLine = smiOutput.split("\n")[0] ?? "";
  const parts = firstLine.split(",").map((s) => s.trim());
  if (parts.length < 2) return null;

  const name = parts[0] ?? "NVIDIA GPU";
  const vramMB = Number.parseInt(parts[1] ?? "0", 10) || 0;

  const bwLookup: Record<string, number> = {
    "5090": 1792, "5080": 960, "5070 Ti": 896, "5070": 672,
    "4090": 1008, "4080 SUPER": 736, "4080": 717,
    "4070 Ti SUPER": 672, "4070 Ti": 504, "4070 SUPER": 504, "4070": 504,
    "4060 Ti": 288, "4060": 272,
    "3090 Ti": 1008, "3090": 936, "3080 Ti": 912, "3080": 760,
    "3070 Ti": 608, "3070": 448, "3060 Ti": 448, "3060": 360,
    "A100": 2039, "H100": 3350, "A6000": 768, "L40": 864,
  };

  let bandwidth = 200;
  for (const [key, bw] of Object.entries(bwLookup)) {
    if (name.includes(key)) {
      bandwidth = bw;
      break;
    }
  }

  return { name, vendor: "NVIDIA", vramMB, bandwidthGBs: bandwidth };
}

function detectAmdGpu(): GpuInfo | null {
  const rocmOutput = run("rocm-smi", ["--showmeminfo", "vram", "--csv"]);
  if (!rocmOutput) return null;

  const lines = rocmOutput.split("\n");
  const dataLine = lines[1] || "";
  if (!dataLine) return null;

  const lspciOutput = run("lspci", ["-nn"]);
  const amdGpuLine = lspciOutput.split("\n").find((line) =>
    line.toLowerCase().includes("vga") && line.toLowerCase().includes("amd"),
  );
  const name: string = amdGpuLine
    ? amdGpuLine.replace(/.*\[AMD.*?\]\s*/, "").replace(/\[.*$/, "").trim()
    : "AMD GPU";

  let vramMB = 0;
  const parts = dataLine.split(",");
  if (parts.length >= 2) {
    vramMB = Math.round(Number.parseInt(parts[1] ?? "0", 10) / (1024 * 1024)) || 0;
  }

  const bwLookup: Record<string, number> = {
    "7900 XTX": 960, "7900 XT": 800, "7900 GRE": 576,
    "7800 XT": 624, "7700 XT": 432,
    "6950 XT": 576, "6900 XT": 512, "6800 XT": 512, "6800": 512,
    "6700 XT": 384,
  };

  let bandwidth = 200;
  for (const [key, bw] of Object.entries(bwLookup)) {
    if (name.includes(key)) {
      bandwidth = bw;
      break;
    }
  }

  return { name, vendor: "AMD", vramMB, bandwidthGBs: bandwidth };
}

export async function detectLinuxHardware(): Promise<CliHardwareInfo> {
  const [meminfoText, cpuinfoText, nprocOutput] = await Promise.all([
    readFileAsync("/proc/meminfo"),
    readFileAsync("/proc/cpuinfo"),
    Promise.resolve(run("nproc", [])),
  ]);

  let ramGB: number | null = null;
  const memMatch = meminfoText.match(/MemTotal:\s+(\d+)\s+kB/i);
  if (memMatch?.[1]) {
    ramGB = Math.round((Number.parseInt(memMatch[1], 10) / (1024 * 1024)) * 10) / 10;
  }

  const nameMatch = cpuinfoText.match(/model name\s*:\s*(.+)/i);
  const cpuName = nameMatch?.[1]?.trim() ?? "Unknown CPU";
  const cpuCores = Number.parseInt(nprocOutput || "1", 10) || 1;

  const nvidia = detectNvidiaGpu();
  const amd = !nvidia ? detectAmdGpu() : null;
  const gpu = nvidia || amd;

  const vramGB = gpu ? Math.round((gpu.vramMB / 1024) * 10) / 10 : null;
  const bandwidth = gpu?.bandwidthGBs ?? (ramGB ? Math.min(ramGB * 4, 100) : 50);
  const totalUsable = vramGB ? Math.max(vramGB, ramGB ?? 0) : ramGB;

  return {
    gpuRenderer: gpu?.name ?? cpuName,
    gpuVendor: gpu?.vendor ?? "CPU-only",
    gpuCores: null,
    ramGB,
    estimatedVRAM: vramGB,
    memoryBandwidth: bandwidth,
    systemRAM: ramGB,
    deviceMemoryRaw: vramGB ? vramGB * 1024 * 1024 * 1024 : null,
    webgpu: false,
    webgpuDevice: null,
    webgpuArch: null,
    isAppleSilicon: false,
    totalUsableRAM: totalUsable,
    platform: "Linux",
    cpuBenchmark: cpuCores * 8,
    isMobile: false,
    deviceName: gpu ? `${gpu.name} (${gpu.vramMB} MB)` : cpuName,
  };
}

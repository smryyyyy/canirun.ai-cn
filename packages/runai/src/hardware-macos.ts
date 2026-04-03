import { CHIP_BW_GBS } from "./config";
import type { CliHardwareInfo } from "./types";

async function runAsync(command: string, args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.trim();
  } catch {
    return "";
  }
}

function parseAppleChip(value: string): string | null {
  const lower = value.toLowerCase();
  const candidates = Object.keys(CHIP_BW_GBS).sort((a, b) => b.length - a.length);
  for (const chip of candidates) {
    if (lower.includes(chip)) return chip;
  }
  return null;
}

function parseGpuCores(systemProfile: string): number | null {
  const match = systemProfile.match(/Total Number of Cores:\s*(\d+)/i);
  if (!match?.[1]) return null;
  return Number.parseInt(match[1], 10);
}

export async function detectMacHardware(): Promise<CliHardwareInfo> {
  const [memBytes, cpuBrand, cpuCoresRaw, gpuProfile] = await Promise.all([
    runAsync("sysctl", ["-n", "hw.memsize"]),
    runAsync("sysctl", ["-n", "machdep.cpu.brand_string"]),
    runAsync("sysctl", ["-n", "hw.perflevel0.physicalcpu"]),
    runAsync("system_profiler", ["SPDisplaysDataType"]),
  ]);

  const chip = parseAppleChip(cpuBrand) || "m1";
  const totalRamGB = Math.round((Number(memBytes || "0") / (1024 ** 3)) * 10) / 10 || null;
  const cpuCores = Number.parseInt(cpuCoresRaw || "0", 10) || null;
  const gpuCores = parseGpuCores(gpuProfile);
  const bandwidth = CHIP_BW_GBS[chip] || 68;

  return {
    gpuRenderer: `Apple ${chip.toUpperCase()}`,
    gpuVendor: "Apple",
    gpuCores,
    ramGB: totalRamGB,
    estimatedVRAM: null,
    memoryBandwidth: bandwidth,
    systemRAM: null,
    deviceMemoryRaw: null,
    webgpu: false,
    webgpuDevice: null,
    webgpuArch: chip,
    isAppleSilicon: true,
    totalUsableRAM: totalRamGB,
    platform: "macOS",
    cpuBenchmark: cpuCores ? cpuCores * 10 : null,
    isMobile: false,
    deviceName: `Apple ${chip.toUpperCase()}`,
  };
}

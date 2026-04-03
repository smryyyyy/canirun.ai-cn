import { platform } from "node:os";
import type { CliHardwareInfo } from "./types";

export async function detectHardware(): Promise<CliHardwareInfo> {
  const os = platform();

  if (os === "darwin") {
    const { detectMacHardware } = await import("./hardware-macos");
    return detectMacHardware();
  }

  if (os === "linux") {
    const { detectLinuxHardware } = await import("./hardware-linux");
    return detectLinuxHardware();
  }

  const totalMem = (await import("node:os")).totalmem();
  const ramGB = Math.round((totalMem / (1024 ** 3)) * 10) / 10;

  return {
    gpuRenderer: null,
    gpuVendor: null,
    gpuCores: null,
    ramGB,
    estimatedVRAM: null,
    memoryBandwidth: Math.min(ramGB * 4, 100),
    systemRAM: ramGB,
    deviceMemoryRaw: null,
    webgpu: false,
    webgpuDevice: null,
    webgpuArch: null,
    isAppleSilicon: false,
    totalUsableRAM: ramGB,
    platform: os,
    cpuBenchmark: null,
    isMobile: false,
    deviceName: `${os} (${ramGB} GB RAM)`,
  };
}

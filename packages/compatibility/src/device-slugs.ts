import { GPU_DB, APPLE_DB, MOBILE_GPU_DB, SBC_DB } from "./index.js";

export function deviceKeyToSlug(key: string): string {
  const name = key.includes(":") ? key.split(":").slice(1).join(":") : key;
  return name
    .toLowerCase()
    .replace(/[()]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function slugToDeviceKey(slug: string): string | null {
  for (const chip of Object.keys(APPLE_DB)) {
    if (deviceKeyToSlug(`apple:${chip}`) === slug) return `apple:${chip}`;
  }
  for (const name of Object.keys(GPU_DB)) {
    if (deviceKeyToSlug(`gpu:${name}`) === slug) return `gpu:${name}`;
  }
  for (const name of Object.keys(MOBILE_GPU_DB)) {
    if (deviceKeyToSlug(`mobile:${name}`) === slug) return `mobile:${name}`;
  }
  for (const name of Object.keys(SBC_DB)) {
    if (deviceKeyToSlug(`sbc:${name}`) === slug) return `sbc:${name}`;
  }
  return null;
}

export interface DeviceSlugEntry {
  slug: string;
  key: string;
  name: string;
}

export function getAllDeviceSlugs(): DeviceSlugEntry[] {
  const entries: DeviceSlugEntry[] = [];

  for (const chip of Object.keys(APPLE_DB)) {
    const key = `apple:${chip}`;
    entries.push({
      slug: deviceKeyToSlug(key),
      key,
      name: chip.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
    });
  }

  for (const name of Object.keys(GPU_DB)) {
    const key = `gpu:${name}`;
    entries.push({ slug: deviceKeyToSlug(key), key, name });
  }

  for (const name of Object.keys(MOBILE_GPU_DB)) {
    const key = `mobile:${name}`;
    entries.push({ slug: deviceKeyToSlug(key), key, name });
  }

  for (const name of Object.keys(SBC_DB)) {
    const key = `sbc:${name}`;
    entries.push({ slug: deviceKeyToSlug(key), key, name });
  }

  return entries;
}

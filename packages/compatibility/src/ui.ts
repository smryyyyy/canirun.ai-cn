import {
  GPU_DB,
  APPLE_DB,
  MOBILE_GPU_DB,
  SBC_DB,
  getGPUCategory,
  DEVICE_CATEGORY_ORDER,
  buildSelectOptions,
} from "./index.js";

// ── Chip Name Formatting ──────────────────────────────────

export function formatChipName(chip: string): string {
  return chip.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ── Select Width Measurement ──────────────────────────────

let _measureEl: HTMLSpanElement | null = null;

function getMeasureEl(): HTMLSpanElement {
  if (!_measureEl) {
    _measureEl = document.createElement("span");
    _measureEl.style.cssText = "visibility:hidden;position:absolute;white-space:nowrap;pointer-events:none";
  }
  if (!_measureEl.isConnected) document.body.appendChild(_measureEl);
  return _measureEl;
}

export function fitSelectWidth(select: HTMLSelectElement): void {
  const el = getMeasureEl();
  const text = select.options[select.selectedIndex]?.textContent ?? "";
  el.style.font = getComputedStyle(select).font;
  el.textContent = text;
  select.style.width = `${el.offsetWidth + 28}px`;
}

// ── Numeric Select Population ─────────────────────────────

export function populateSelect(
  select: HTMLSelectElement,
  presets: number[],
  detected: number | null,
  override: number | undefined,
  formatter: (v: number) => string,
): void {
  const options = buildSelectOptions(presets, detected);
  if (override !== undefined && override > 0 && !options.includes(override)) {
    options.push(override);
    options.sort((a, b) => a - b);
  }
  select.innerHTML = "";
  for (const v of options) {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = formatter(v) + (v === detected ? " ✱" : "");
    select.appendChild(opt);
  }
  select.value = String(override ?? detected ?? "");
  fitSelectWidth(select);
}

// ── Device Options Grouping ───────────────────────────────

export interface DeviceOption {
  value: string;
  label: string;
}

export function buildGroupedDeviceOptions(): Record<string, DeviceOption[]> {
  const grouped: Record<string, DeviceOption[]> = {};

  for (const [chip, data] of Object.entries(APPLE_DB)) {
    const cat = "Apple Silicon";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({ value: `apple:${chip}`, label: `${formatChipName(chip)} (${data.ram} GB)` });
  }

  for (const [name, data] of Object.entries(GPU_DB)) {
    const cat = getGPUCategory(name);
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({ value: `gpu:${name}`, label: `${name} (${data.vram} GB)` });
  }

  for (const [name, data] of Object.entries(MOBILE_GPU_DB)) {
    const cat = "Mobile";
    if (!grouped[cat]) grouped[cat] = [];
    const label = data.ram ? `${name} (${data.ram} GB)` : name;
    grouped[cat].push({ value: `mobile:${name}`, label });
  }

  for (const [name, data] of Object.entries(SBC_DB)) {
    const cat = "SBC / Embedded";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({ value: `sbc:${name}`, label: `${name} — ${data.ram} GB` });
  }

  return grouped;
}

export function appendDeviceOptgroups(
  select: HTMLSelectElement,
  storedDevice?: string,
): void {
  const grouped = buildGroupedDeviceOptions();
  for (const cat of DEVICE_CATEGORY_ORDER) {
    const items = grouped[cat];
    if (!items?.length) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = cat;
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item.value;
      opt.textContent = item.label;
      if (item.value === storedDevice) opt.selected = true;
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }
}

export type RunaiEventName =
  | "recommendation_generated"
  | "catalog_browse"
  | "inference_completed";

export interface SanitizedRunaiMetricBase {
  event: RunaiEventName;
  timestamp: string;
  runaiVersion: string;
  anonymous: true;
}

export interface SanitizedRecommendationMetric extends SanitizedRunaiMetricBase {
  event: "recommendation_generated";
  hardware: {
    platform: string | null;
    deviceClass: "apple_silicon" | "discrete_or_other";
    ramBucketGB: number | null;
    bandwidthBucketGBs: number | null;
  };
  recommendations: Array<{
    modelId: string;
    quant: string;
    score: number;
    status: string;
    expectedTokensPerSec: number | null;
    memoryNeededGB: number;
  }>;
}

export interface SanitizedBrowseMetric extends SanitizedRunaiMetricBase {
  event: "catalog_browse";
  queryLength: number;
  resultCount: number;
}

export interface SanitizedInferenceMetric extends SanitizedRunaiMetricBase {
  event: "inference_completed";
  model: string;
  stream: boolean;
  success: boolean;
  latencyMs: number;
  outputTokensApprox: number;
  temperature: number;
  maxTokens: number;
}

export type SanitizedRunaiMetric =
  | SanitizedRecommendationMetric
  | SanitizedBrowseMetric
  | SanitizedInferenceMetric;

const MAX_RECOMMENDATIONS = 5;
const MAX_SCORE = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) return null;
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function parseBase(payload: Record<string, unknown>): SanitizedRunaiMetricBase | null {
  const event = payload.event;
  if (
    event !== "recommendation_generated" &&
    event !== "catalog_browse" &&
    event !== "inference_completed"
  ) {
    return null;
  }

  const timestamp = toIsoDate(payload.timestamp);
  if (!timestamp) return null;

  const runaiVersion = typeof payload.runaiVersion === "string" ? payload.runaiVersion.slice(0, 32) : "unknown";
  const anonymous = payload.anonymous === true;
  if (!anonymous) return null;

  return {
    event,
    timestamp,
    runaiVersion,
    anonymous: true,
  };
}

function parseRecommendation(
  payload: Record<string, unknown>,
  base: SanitizedRunaiMetricBase,
): SanitizedRecommendationMetric | null {
  if (!isRecord(payload.hardware)) return null;
  const rawRecommendations = Array.isArray(payload.recommendations) ? payload.recommendations : [];

  const hardware = {
    platform: typeof payload.hardware.platform === "string" ? payload.hardware.platform.slice(0, 20) : null,
    deviceClass:
      payload.hardware.deviceClass === "apple_silicon" ? "apple_silicon" : "discrete_or_other",
    ramBucketGB: toFiniteNumber(payload.hardware.ramBucketGB),
    bandwidthBucketGBs: toFiniteNumber(payload.hardware.bandwidthBucketGBs),
  };

  const recommendations = rawRecommendations
    .filter(isRecord)
    .slice(0, MAX_RECOMMENDATIONS)
    .map((item) => ({
      modelId: typeof item.modelId === "string" ? item.modelId.slice(0, 80) : "unknown",
      quant: typeof item.quant === "string" ? item.quant.slice(0, 20) : "unknown",
      score: clamp(Math.round(toFiniteNumber(item.score) ?? 0), 0, MAX_SCORE),
      status: typeof item.status === "string" ? item.status.slice(0, 24) : "unknown",
      expectedTokensPerSec: (() => {
        const value = toFiniteNumber(item.expectedTokensPerSec);
        if (value === null) return null;
        return clamp(Math.round(value), 0, 10000);
      })(),
      memoryNeededGB: clamp(toFiniteNumber(item.memoryNeededGB) ?? 0, 0, 10000),
    }));

  return {
    ...base,
    event: "recommendation_generated",
    hardware,
    recommendations,
  };
}

function parseBrowse(
  payload: Record<string, unknown>,
  base: SanitizedRunaiMetricBase,
): SanitizedBrowseMetric {
  return {
    ...base,
    event: "catalog_browse",
    queryLength: clamp(Math.round(toFiniteNumber(payload.queryLength) ?? 0), 0, 500),
    resultCount: clamp(Math.round(toFiniteNumber(payload.resultCount) ?? 0), 0, 10000),
  };
}

function parseInference(
  payload: Record<string, unknown>,
  base: SanitizedRunaiMetricBase,
): SanitizedInferenceMetric {
  return {
    ...base,
    event: "inference_completed",
    model: typeof payload.model === "string" ? payload.model.slice(0, 120) : "unknown",
    stream: payload.stream === true,
    success: payload.success === true,
    latencyMs: clamp(Math.round(toFiniteNumber(payload.latencyMs) ?? 0), 0, 3_600_000),
    outputTokensApprox: clamp(Math.round(toFiniteNumber(payload.outputTokensApprox) ?? 0), 0, 1_000_000),
    temperature: clamp(toFiniteNumber(payload.temperature) ?? 0, 0, 2),
    maxTokens: clamp(Math.round(toFiniteNumber(payload.maxTokens) ?? 0), 0, 1_000_000),
  };
}

export function sanitizeRunaiMetric(input: unknown): SanitizedRunaiMetric | null {
  if (!isRecord(input)) return null;
  const base = parseBase(input);
  if (!base) return null;

  if (base.event === "recommendation_generated") {
    return parseRecommendation(input, base);
  }
  if (base.event === "catalog_browse") {
    return parseBrowse(input, base);
  }
  return parseInference(input, base);
}

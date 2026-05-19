import { describe, expect, test } from "vitest";
import { sanitizeRunaiMetric } from "../src/lib/runai-metrics";

describe("sanitizeRunaiMetric", () => {
  test("accepts and normalizes recommendation payload", () => {
    const metric = sanitizeRunaiMetric({
      event: "recommendation_generated",
      timestamp: "2026-01-01T00:00:00.000Z",
      runaiVersion: "0.1.0",
      anonymous: true,
      hardware: {
        platform: "macOS",
        deviceClass: "apple_silicon",
        ramBucketGB: 24,
        bandwidthBucketGBs: 275,
      },
      recommendations: [
        {
          modelId: "qwen3-8b",
          quant: "Q4_K_M",
          score: 98.2,
          status: "can-run",
          expectedTokensPerSec: 54,
          memoryNeededGB: 5.4,
        },
      ],
    });

    expect(metric).not.toBeNull();
    expect(metric?.event).toBe("recommendation_generated");
    if (metric?.event === "recommendation_generated") {
      expect(metric.recommendations.length).toBe(1);
      expect(metric.recommendations[0]?.score).toBe(98);
    }
  });

  test("rejects non-anonymous payload", () => {
    const metric = sanitizeRunaiMetric({
      event: "catalog_browse",
      timestamp: "2026-01-01T00:00:00.000Z",
      runaiVersion: "0.1.0",
      anonymous: false,
      queryLength: 12,
      resultCount: 5,
    });
    expect(metric).toBeNull();
  });

  test("clamps inference values to safe ranges", () => {
    const metric = sanitizeRunaiMetric({
      event: "inference_completed",
      timestamp: "2026-01-01T00:00:00.000Z",
      runaiVersion: "0.1.0",
      anonymous: true,
      model: "qwen3-8b",
      stream: true,
      success: true,
      latencyMs: 99_999_999,
      outputTokensApprox: -10,
      temperature: 9,
      maxTokens: 9_999_999,
    });

    expect(metric?.event).toBe("inference_completed");
    if (metric?.event === "inference_completed") {
      expect(metric.latencyMs).toBe(3_600_000);
      expect(metric.outputTokensApprox).toBe(0);
      expect(metric.temperature).toBe(2);
      expect(metric.maxTokens).toBe(1_000_000);
    }
  });
});

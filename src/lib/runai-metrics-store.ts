import { createClient, type Client } from "@libsql/client";
import type {
  SanitizedBrowseMetric,
  SanitizedInferenceMetric,
  SanitizedRecommendationMetric,
  SanitizedRunaiMetric,
} from "./runai-metrics";

let client: Client | null = null;
let tableReady = false;

function getClient(): Client {
  if (client) return client;

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    throw new Error("Turso is not configured. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.");
  }

  client = createClient({
    url,
    authToken,
  });
  return client;
}

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  const db = getClient();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS runai_metrics (
      id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL,
      event_name TEXT NOT NULL,
      runai_version TEXT NOT NULL,
      metric_json TEXT NOT NULL,
      platform TEXT,
      device_class TEXT,
      model TEXT,
      success INTEGER,
      stream INTEGER,
      latency_ms INTEGER,
      output_tokens_approx INTEGER
    )
  `);
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_runai_metrics_event_time ON runai_metrics(event_name, received_at)",
  );
  tableReady = true;
}

function recommendationProjections(metric: SanitizedRecommendationMetric): {
  platform: string | null;
  deviceClass: string | null;
} {
  return {
    platform: metric.hardware.platform,
    deviceClass: metric.hardware.deviceClass,
  };
}

function inferenceProjections(metric: SanitizedInferenceMetric): {
  model: string;
  success: number;
  stream: number;
  latencyMs: number;
  outputTokensApprox: number;
} {
  return {
    model: metric.model,
    success: metric.success ? 1 : 0,
    stream: metric.stream ? 1 : 0,
    latencyMs: metric.latencyMs,
    outputTokensApprox: metric.outputTokensApprox,
  };
}

function browseProjections(_metric: SanitizedBrowseMetric): Record<string, never> {
  return {};
}

export async function insertRunaiMetric(metric: SanitizedRunaiMetric): Promise<void> {
  await ensureTable();
  const db = getClient();

  const base = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    eventName: metric.event,
    runaiVersion: metric.runaiVersion,
    metricJson: JSON.stringify(metric),
    platform: null as string | null,
    deviceClass: null as string | null,
    model: null as string | null,
    success: null as number | null,
    stream: null as number | null,
    latencyMs: null as number | null,
    outputTokensApprox: null as number | null,
  };

  if (metric.event === "recommendation_generated") {
    const projection = recommendationProjections(metric);
    base.platform = projection.platform;
    base.deviceClass = projection.deviceClass;
  } else if (metric.event === "inference_completed") {
    const projection = inferenceProjections(metric);
    base.model = projection.model;
    base.success = projection.success;
    base.stream = projection.stream;
    base.latencyMs = projection.latencyMs;
    base.outputTokensApprox = projection.outputTokensApprox;
  } else {
    browseProjections(metric);
  }

  await db.execute({
    sql: `
      INSERT INTO runai_metrics (
        id, received_at, event_name, runai_version, metric_json,
        platform, device_class, model, success, stream, latency_ms, output_tokens_approx
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      base.id,
      base.receivedAt,
      base.eventName,
      base.runaiVersion,
      base.metricJson,
      base.platform,
      base.deviceClass,
      base.model,
      base.success,
      base.stream,
      base.latencyMs,
      base.outputTokensApprox,
    ],
  });
}

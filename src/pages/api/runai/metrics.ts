import type { APIRoute } from "astro";
import { insertRunaiMetric } from "../../../lib/runai-metrics-store";
import { sanitizeRunaiMetric } from "../../../lib/runai-metrics";

export const prerender = false;

const MAX_BODY_BYTES = 32 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const metric = sanitizeRunaiMetric(payload);
  if (!metric) {
    return json({ error: "invalid_metric_payload" }, 400);
  }

  try {
    await insertRunaiMetric(metric);
  } catch {
    return json({ error: "metrics_storage_unavailable" }, 503);
  }

  return json({ ok: true }, 202);
};

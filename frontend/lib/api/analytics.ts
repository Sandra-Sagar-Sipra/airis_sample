/**
 * PIPE-007: Pipeline Analytics API helpers.
 *
 * GET  /api/v1/pipeline-analytics         → PipelineAnalytics
 * GET  /api/v1/pipeline-analytics/export  → CSV download (window.location redirect)
 */
import { apiRequest, getApiBaseUrl } from "@/lib/api/client";
import type { PipelineAnalytics, PipelineAnalyticsParams } from "@/lib/api/types";

function buildAnalyticsParams(params: PipelineAnalyticsParams): URLSearchParams {
  const p = new URLSearchParams();
  if (params.jobId) p.set("job_id", params.jobId);
  if (params.startDate) p.set("start_date", params.startDate);
  if (params.endDate) p.set("end_date", params.endDate);
  return p;
}

/**
 * Fetch full pipeline analytics.
 * Pass `jobId` for per-job view, omit for cross-job org-wide view.
 * Date range (YYYY-MM-DD) is inclusive on both ends.
 */
export async function getPipelineAnalytics(
  params: PipelineAnalyticsParams = {}
): Promise<PipelineAnalytics> {
  const qs = buildAnalyticsParams(params);
  const path = `/pipeline-analytics${qs.toString() ? `?${qs.toString()}` : ""}`;
  return apiRequest<PipelineAnalytics>(path, {}, 0);
}

/**
 * Fetch the CSV export as a Blob and trigger a browser file download.
 * Uses the Authorization header (same as apiRequest) so the token is never
 * exposed as a query parameter.
 */
export async function downloadAnalyticsCsv(
  params: PipelineAnalyticsParams = {}
): Promise<void> {
  const qs = buildAnalyticsParams(params);
  const path = `/pipeline-analytics/export${qs.toString() ? `?${qs.toString()}` : ""}`;

  // apiRequest returns the parsed body, but for CSV we need raw text.
  // Fetch directly here so we can call .text() instead of .json().
  const base = getApiBaseUrl();
  const token =
    typeof window !== "undefined"
      ? window.localStorage.getItem("airis_access_token")
      : null;

  const response = await fetch(`${base}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) throw new Error(`Export failed: ${response.status}`);

  const csv = await response.text();
  const contentDisposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = contentDisposition.match(/filename="([^"]+)"/);
  const filename = filenameMatch?.[1] ?? "pipeline_analytics.csv";

  // Trigger browser download via a temporary object URL.
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

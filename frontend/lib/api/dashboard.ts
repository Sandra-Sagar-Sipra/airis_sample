import { apiRequest } from "@/lib/api/client";

export type DashboardPipelineStages = {
  sourced: number;
  ai_interview: number;
  interview: number;
  offer: number;
  placed: number;
};

export type DashboardRecentJob = {
  id: string;
  title: string;
  status: string;
  location: string | null;
  employment_type: string | null;
  created_at: string;
  candidate_count: number;
};

export type DashboardActivityItem = {
  id: string;
  type: "candidate_stage" | "job_created" | "placement";
  title: string;
  subtitle: string;
  timestamp: string;
};

export type DashboardSummary = {
  total_candidates: number;
  candidates_trend: number;
  active_jobs: number;
  jobs_trend: number;
  in_pipeline: number;
  pipeline_trend: number;
  placements: number;
  placements_trend: number;
  pipeline_stages: DashboardPipelineStages;
  recent_jobs: DashboardRecentJob[];
  activities: DashboardActivityItem[];
};

const DASHBOARD_SUMMARY_PATH = "/dashboard/summary";

/** In-memory GET cache TTL — dashboard aggregates are safe to reuse briefly. */
const DASHBOARD_API_CACHE_MS = 60_000;

export async function getDashboardSummary(): Promise<DashboardSummary> {
  return apiRequest<DashboardSummary>(DASHBOARD_SUMMARY_PATH, {}, DASHBOARD_API_CACHE_MS);
}

const SESSION_CACHE_KEY = "airis_dashboard_summary_v1";
const SESSION_CACHE_TTL_MS = 5 * 60_000;

export function readCachedDashboardSummary(): DashboardSummary | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(SESSION_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { savedAt: number; data: DashboardSummary };
    if (Date.now() - parsed.savedAt > SESSION_CACHE_TTL_MS) {
      window.sessionStorage.removeItem(SESSION_CACHE_KEY);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export function writeCachedDashboardSummary(data: DashboardSummary): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.setItem(
      SESSION_CACHE_KEY,
      JSON.stringify({ savedAt: Date.now(), data })
    );
  } catch {
    // Quota or private mode — ignore.
  }
}

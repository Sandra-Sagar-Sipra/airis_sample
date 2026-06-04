import { apiRequest, invalidateApiCache } from "@/lib/api/client";
import type {
  AIScreeningListItem,
  Candidate,
  Pipeline,
  PipelineListResponse,
  PipelineStage,
  PipelineStageHistory,
  PipelineStatusChangePayload,
  PipelineStatusHistory,
  WithdrawPipelinePayload,
} from "@/lib/api/types";

export type PipelineBoardAtsEntry = {
  score: number;
  recommendation: string;
  recruiter_summary?: string | null;
  ai_enrichment_status?: string | null;
};

export type PipelineBoardCache = {
  pipelines: Pipeline[];
  candidates: Candidate[];
  atsByCandidateId: Record<string, PipelineBoardAtsEntry>;
  screeningsByCandidateId: Record<string, AIScreeningListItem>;
};

const PIPELINE_BOARD_CACHE_PREFIX = "airis_pipeline_board_v1:";
const PIPELINE_BOARD_CACHE_TTL_MS = 5 * 60_000;

export function readPipelineBoardCache(jobId: string): PipelineBoardCache | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(`${PIPELINE_BOARD_CACHE_PREFIX}${jobId}`);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { savedAt: number; data: PipelineBoardCache };
    if (Date.now() - parsed.savedAt > PIPELINE_BOARD_CACHE_TTL_MS) {
      window.sessionStorage.removeItem(`${PIPELINE_BOARD_CACHE_PREFIX}${jobId}`);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export function writePipelineBoardCache(jobId: string, data: PipelineBoardCache): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.setItem(
      `${PIPELINE_BOARD_CACHE_PREFIX}${jobId}`,
      JSON.stringify({ savedAt: Date.now(), data })
    );
  } catch {
    // Ignore quota errors.
  }
}

/** Clear stale kanban data after a candidate is permanently deleted. */
export function clearPipelineBoardCache(jobId?: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (jobId) {
      window.sessionStorage.removeItem(`${PIPELINE_BOARD_CACHE_PREFIX}${jobId}`);
      return;
    }
    const keys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (key?.startsWith(PIPELINE_BOARD_CACHE_PREFIX)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore storage errors.
  }
}

export type PipelineCreatePayload = {
  candidate_id: string;
  job_id: string;
  stage?: PipelineStage;
  status?: "active" | "on_hold" | "withdrawn" | "closed";
  notes?: string;
};

export type PipelineUpdatePayload = {
  stage?: PipelineStage;
  status?: "active" | "on_hold" | "withdrawn" | "closed";
  notes?: string;
};

/** PIPE-002: payload for a validated stage transition. */
export type PipelineTransitionPayload = {
  stage: PipelineStage;
  /** Required (≥ 10 chars) when transitioning to "rejected". */
  reason?: string;
};

/** PIPE-004: Filter + sort + pagination options for the pipeline list endpoint. */
export type PipelineListParams = {
  limit?: number;
  offset?: number;
  jobId?: string;
  candidateId?: string;
  /** Filter pipelines to those whose linked job belongs to this client workspace. */
  clientId?: string;
  stage?: PipelineStage;
  status?: "active" | "on_hold" | "withdrawn" | "closed";
  sortBy?: "created_at" | "stage_updated_at";
  sortDir?: "asc" | "desc";
};

function buildPipelineParams(params: PipelineListParams): URLSearchParams {
  const p = new URLSearchParams({
    limit: String(params.limit ?? 200),
    offset: String(params.offset ?? 0),
  });
  if (params.jobId) p.set("job_id", params.jobId);
  if (params.candidateId) p.set("candidate_id", params.candidateId);
  if (params.clientId) p.set("client_id", params.clientId);
  if (params.stage) p.set("stage", params.stage);
  if (params.status) p.set("status", params.status);
  if (params.sortBy) p.set("sort_by", params.sortBy);
  if (params.sortDir) p.set("sort_dir", params.sortDir);
  return p;
}

/**
 * Fetch pipelines — returns `Pipeline[]` for backward compatibility.
 * All existing callers (board, candidate detail, etc.) continue to work.
 *
 * Internally calls the new PIPE-004 paginated endpoint and extracts `.data`.
 */
export async function getPipelines(
  limit = 200,
  offset = 0,
  jobId?: string,
  candidateId?: string
): Promise<Pipeline[]> {
  const params = buildPipelineParams({ limit, offset, jobId, candidateId });
  try {
    const response = await apiRequest<PipelineListResponse>(`/pipelines?${params.toString()}`);
    return response.data;
  } catch (err: unknown) {
    // Some running backend variants don't expose /pipelines; treat as empty list.
    const s = (err as { status?: number })?.status;
    if (s === 404 || s === 405) return [];
    throw err;
  }
}

/**
 * PIPE-004: Fetch pipelines with full metadata (total count + stage counts).
 * Used by the pipeline list/table page.
 */
export async function getPipelinesWithMeta(
  params: PipelineListParams = {}
): Promise<PipelineListResponse> {
  const qp = buildPipelineParams(params);
  return apiRequest<PipelineListResponse>(`/pipelines?${qp.toString()}`, { silentErrors: true }, 0);
}

export async function createPipeline(payload: PipelineCreatePayload): Promise<Pipeline> {
  const result = await apiRequest<Pipeline>("/pipelines", {
    method: "POST",
    body: JSON.stringify(payload),
  }, 0);
  invalidateApiCache("/pipelines");
  return result;
}

export async function updatePipeline(
  pipelineId: string,
  payload: PipelineUpdatePayload
): Promise<Pipeline> {
  const result = await apiRequest<Pipeline>(`/pipelines/${pipelineId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  }, 0);
  invalidateApiCache("/pipelines");
  return result;
}

/**
 * PIPE-002: Apply a validated stage transition.
 *
 * Only transitions that follow the defined flow are accepted.
 * Returns HTTP 422 for invalid transitions or missing rejection reason.
 */
export async function transitionPipelineStage(
  pipelineId: string,
  payload: PipelineTransitionPayload
): Promise<Pipeline> {
  const result = await apiRequest<Pipeline>(`/pipelines/${pipelineId}/transition`, {
    method: "POST",
    body: JSON.stringify(payload),
  }, 0);
  invalidateApiCache("/pipelines");
  return result;
}

/**
 * PIPE-002: Fetch the full stage-transition audit history for a pipeline.
 */
export async function getPipelineStageHistory(
  pipelineId: string
): Promise<PipelineStageHistory[]> {
  return apiRequest<PipelineStageHistory[]>(`/pipelines/${pipelineId}/history`, {}, 0);
}

// ── PIPE-003: Status tracking ──────────────────────────────────────────────

/**
 * PIPE-003: Change the pipeline status (active / on_hold / withdrawn / closed).
 * Each change is recorded in the status history audit log.
 */
export async function changePipelineStatus(
  pipelineId: string,
  payload: PipelineStatusChangePayload
): Promise<Pipeline> {
  const result = await apiRequest<Pipeline>(`/pipelines/${pipelineId}/status`, {
    method: "POST",
    body: JSON.stringify(payload),
  }, 0);
  invalidateApiCache("/pipelines");
  return result;
}

/**
 * PIPE-003: Withdraw a pipeline (candidate-requested removal).
 * A non-empty reason (≥ 5 chars) is required.
 */
export async function withdrawPipeline(
  pipelineId: string,
  payload: WithdrawPipelinePayload
): Promise<Pipeline> {
  const result = await apiRequest<Pipeline>(`/pipelines/${pipelineId}/withdraw`, {
    method: "POST",
    body: JSON.stringify(payload),
  }, 0);
  invalidateApiCache("/pipelines");
  return result;
}

/**
 * PIPE-003: Fetch the full status-change audit history for a pipeline.
 */
export async function getPipelineStatusHistory(
  pipelineId: string
): Promise<PipelineStatusHistory[]> {
  return apiRequest<PipelineStatusHistory[]>(`/pipelines/${pipelineId}/status-history`, {}, 0);
}

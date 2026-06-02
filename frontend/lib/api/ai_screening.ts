import { apiRequest } from "@/lib/api/client";
import type {
  AIScreening,
  AIScreeningCreatePayload,
  AIScreeningDetail,
  AIScreeningListItem,
  AnswerUpsertPayload,
  AIScreeningAnswer,
  RecruiterDecisionPayload,
  StartScreeningPayload,
} from "@/lib/api/types";

const BASE = "/ai-screenings";

// ── Create ────────────────────────────────────────────────────────────────────

export async function createScreening(
  payload: AIScreeningCreatePayload
): Promise<AIScreening> {
  return apiRequest<AIScreening>(BASE, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ── Start (create + optional pipeline stage move) ─────────────────────────────

export async function startScreening(
  payload: StartScreeningPayload
): Promise<AIScreening> {
  return apiRequest<AIScreening>(`${BASE}/start`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ── Retry (re-trigger failed background task) ─────────────────────────────────

export async function retryScreening(screeningId: string): Promise<AIScreening> {
  return apiRequest<AIScreening>(`${BASE}/${screeningId}/retry`, { method: "POST" });
}

// ── Move pipeline stage ───────────────────────────────────────────────────────

export async function movePipelineStage(
  screeningId: string,
  pipelineId: string,
  stage: string
): Promise<AIScreening> {
  return apiRequest<AIScreening>(`${BASE}/${screeningId}/move-stage`, {
    method: "POST",
    body: JSON.stringify({ pipeline_id: pipelineId, stage }),
  });
}

// ── List ──────────────────────────────────────────────────────────────────────

export async function listScreenings(params?: {
  candidate_id?: string;
  job_id?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<AIScreeningListItem[]> {
  const q = new URLSearchParams();
  if (params?.candidate_id) q.set("candidate_id", params.candidate_id);
  if (params?.job_id) q.set("job_id", params.job_id);
  if (params?.status) q.set("status", params.status);
  if (params?.limit !== undefined) q.set("limit", String(params.limit));
  if (params?.offset !== undefined) q.set("offset", String(params.offset));
  const qs = q.toString();
  return apiRequest<AIScreeningListItem[]>(qs ? `${BASE}?${qs}` : BASE);
}

// ── Detail ────────────────────────────────────────────────────────────────────

export async function getScreeningDetail(
  screeningId: string
): Promise<AIScreeningDetail> {
  return apiRequest<AIScreeningDetail>(`${BASE}/${screeningId}`);
}

// ── Regenerate questions ──────────────────────────────────────────────────────

export async function regenerateQuestions(
  screeningId: string
): Promise<AIScreening> {
  return apiRequest<AIScreening>(
    `${BASE}/${screeningId}/regenerate-questions`,
    { method: "POST" }
  );
}

// ── Upsert answer ─────────────────────────────────────────────────────────────

export async function upsertAnswer(
  screeningId: string,
  questionId: string,
  payload: AnswerUpsertPayload
): Promise<AIScreeningAnswer> {
  return apiRequest<AIScreeningAnswer>(
    `${BASE}/${screeningId}/answers/${questionId}`,
    {
      method: "PUT",
      body: JSON.stringify(payload),
    }
  );
}

// ── Trigger evaluation ────────────────────────────────────────────────────────

export async function triggerEvaluation(
  screeningId: string
): Promise<AIScreening> {
  return apiRequest<AIScreening>(`${BASE}/${screeningId}/evaluate`, {
    method: "POST",
  });
}

// ── Recruiter decision ────────────────────────────────────────────────────────

export async function recordDecision(
  screeningId: string,
  payload: RecruiterDecisionPayload
): Promise<AIScreening> {
  return apiRequest<AIScreening>(`${BASE}/${screeningId}/decision`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deleteScreening(screeningId: string): Promise<void> {
  await apiRequest<void>(`${BASE}/${screeningId}`, { method: "DELETE" });
}

// ── Polling helper ────────────────────────────────────────────────────────────

/**
 * Poll a screening until it exits a transient status.
 * Resolves when status is one of: questions_ready | completed | failed | cancelled.
 * Rejects after maxAttempts.
 */
export async function pollUntilSettled(
  screeningId: string,
  {
    intervalMs = 2500,
    maxAttempts = 60,
    onUpdate,
  }: {
    intervalMs?: number;
    maxAttempts?: number;
    onUpdate?: (screening: AIScreeningDetail) => void;
  } = {}
): Promise<AIScreeningDetail> {
  const TRANSIENT = new Set([
    "pending",
    "generating_questions",
    "evaluating",
  ]);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const detail = await getScreeningDetail(screeningId);
    onUpdate?.(detail);
    if (!TRANSIENT.has(detail.status)) return detail;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Screening ${screeningId} did not settle after ${maxAttempts} polls`);
}

// ── Live Interview ────────────────────────────────────────────────────────────

export interface LiveInterviewMessage {
  id: string;
  role: "interviewer" | "candidate" | "system";
  content: string;
  sequence_number: number;
  question_number: number | null;
  is_followup: boolean;
  created_at: string;
}

export interface LiveInterview {
  id: string;
  candidate_id: string;
  job_id: string | null;
  status: string;
  session_token: string | null;
  livekit_room_name: string | null;
  candidate_name_snapshot: string | null;
  job_title_snapshot: string | null;
  interview_mode: string;
  overall_score: number | null;
  recommendation: string | null;
  ai_summary: string | null;
  strengths: string[] | null;
  concerns: string[] | null;
  salary_expectation: string | null;
  notice_period: string | null;
  career_goals: string | null;
  key_projects_mentioned: string[] | null;
  communication_score: number | null;
  experience_score: number | null;
  confidence_score: number | null;
  culture_fit_score: number | null;
  duration_seconds: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  messages: LiveInterviewMessage[];
  // Completeness validation
  incomplete_reason: string | null;
}

export interface LiveInterviewCreatePayload {
  candidate_id: string;
  job_id?: string | null;
  max_questions?: number;
}

export async function createLiveInterview(
  payload: LiveInterviewCreatePayload
): Promise<LiveInterview> {
  return apiRequest<LiveInterview>(`${BASE}/live`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getLiveInterviewByToken(token: string): Promise<LiveInterview> {
  return apiRequest<LiveInterview>(`${BASE}/live/join/${token}`);
}

export async function getLiveInterview(id: string): Promise<LiveInterview> {
  return apiRequest<LiveInterview>(`${BASE}/live/${id}`);
}

export async function getAssemblyAIToken(
  screeningId: string,
  sessionToken: string
): Promise<{ token: string | null; available: boolean; ws_url?: string }> {
  // Returns {token: null, available: false} when AssemblyAI is not configured
  // or its API is temporarily unavailable — interview continues with text fallback.
  return apiRequest<{ token: string | null; available: boolean; ws_url?: string }>(
    `${BASE}/live/${screeningId}/assemblyai-token?token=${encodeURIComponent(sessionToken)}`
  );
}

// ── Pipeline Queue ────────────────────────────────────────────────────────────

export interface PipelineQueueEntry {
  pipeline_id: string;
  candidate_id: string;
  job_id: string | null;
  pipeline_stage: string;
  pipeline_status: string;
  stage_updated_at: string | null;
  candidate_name: string;
  candidate_email: string;
  job_title: string | null;
  client_name: string | null;
  screening_id: string | null;
  interview_status: string; // "not_started" | "pending" | "in_progress" | "completed" | "failed" | "incomplete"
  overall_score: number | null;
  recommendation: string | null;
  session_token: string | null;
  interview_mode: string | null;
  started_at: string | null;
  ended_at: string | null;
  incomplete_reason: string | null;
  duration_seconds: number | null;
}

export async function getPipelineScreeningQueue(params?: {
  limit?: number;
  offset?: number;
}): Promise<PipelineQueueEntry[]> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.offset) qs.set("offset", String(params.offset));
  const q = qs.toString() ? `?${qs}` : "";
  return apiRequest<PipelineQueueEntry[]>(`${BASE}/pipeline-queue${q}`);
}

export async function getOrCreateCandidateScreening(
  candidateId: string
): Promise<LiveInterview> {
  return apiRequest<LiveInterview>(`${BASE}/for-candidate/${candidateId}`);
}

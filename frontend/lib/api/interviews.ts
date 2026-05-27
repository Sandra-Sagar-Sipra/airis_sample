import { apiRequest, invalidateApiCache } from "@/lib/api/client";
import type {
  AISummaryResponse,
  AISummaryUpdatePayload,
  Interview,
  InterviewCreatePayload,
  InterviewFeedback,
  InterviewFeedbackPayload,
  InterviewNote,
  InterviewParticipant,
  InterviewReminder,
  InterviewUpdatePayload,
  InterviewerProfile,
  QueueInterview,
  WorkspaceData,
} from "@/lib/api/types";

const BASE = "/interviews";

export async function getInterviews(params?: {
  limit?: number;
  offset?: number;
  pipeline_id?: string;
  candidate_id?: string;
  job_id?: string;
  status?: string;
}): Promise<Interview[]> {
  const q = new URLSearchParams({
    limit: String(params?.limit ?? 50),
    offset: String(params?.offset ?? 0),
  });
  if (params?.pipeline_id) q.set("pipeline_id", params.pipeline_id);
  if (params?.candidate_id) q.set("candidate_id", params.candidate_id);
  if (params?.job_id) q.set("job_id", params.job_id);
  if (params?.status) q.set("status", params.status);
  return apiRequest<Interview[]>(`${BASE}?${q.toString()}`);
}

export async function getInterviewById(interviewId: string): Promise<Interview> {
  return apiRequest<Interview>(`${BASE}/${interviewId}`);
}

export async function getInterviewQueue(params?: {
  limit?: number;
  offset?: number;
  round_type?: string;
  job_id?: string;
}): Promise<QueueInterview[]> {
  const q = new URLSearchParams({
    limit: String(params?.limit ?? 50),
    offset: String(params?.offset ?? 0),
  });
  if (params?.round_type) q.set("round_type", params.round_type);
  if (params?.job_id) q.set("job_id", params.job_id);
  return apiRequest<QueueInterview[]>(`${BASE}/queue?${q.toString()}`);
}

export async function getMyInterviews(params?: { limit?: number; offset?: number }): Promise<Interview[]> {
  const q = new URLSearchParams({
    limit: String(params?.limit ?? 100),
    offset: String(params?.offset ?? 0),
  });
  return apiRequest<Interview[]>(`${BASE}/my?${q.toString()}`);
}

export async function createInterview(payload: InterviewCreatePayload): Promise<Interview> {
  const result = await apiRequest<Interview>(BASE, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  invalidateApiCache(BASE);
  return result;
}

export async function updateInterview(
  interviewId: string,
  payload: InterviewUpdatePayload,
): Promise<Interview> {
  const result = await apiRequest<Interview>(`${BASE}/${interviewId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  invalidateApiCache(BASE);
  return result;
}

export async function deleteInterview(interviewId: string): Promise<void> {
  await apiRequest<void>(`${BASE}/${interviewId}`, { method: "DELETE" });
  invalidateApiCache(BASE);
}

export async function claimInterview(interviewId: string): Promise<InterviewParticipant> {
  const result = await apiRequest<InterviewParticipant>(`${BASE}/${interviewId}/claim`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  invalidateApiCache(BASE);
  return result;
}

export async function getParticipants(interviewId: string): Promise<InterviewParticipant[]> {
  return apiRequest<InterviewParticipant[]>(`${BASE}/${interviewId}/participants`);
}

export async function addParticipant(
  interviewId: string,
  payload: { user_id: string; participant_role: string },
): Promise<InterviewParticipant> {
  const result = await apiRequest<InterviewParticipant>(`${BASE}/${interviewId}/participants`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  invalidateApiCache(`${BASE}/${interviewId}`);
  return result;
}

export async function removeParticipant(interviewId: string, participantId: string): Promise<void> {
  await apiRequest<void>(`${BASE}/${interviewId}/participants/${participantId}`, { method: "DELETE" });
  invalidateApiCache(`${BASE}/${interviewId}`);
}

export async function submitFeedback(
  interviewId: string,
  payload: InterviewFeedbackPayload,
): Promise<InterviewFeedback> {
  const result = await apiRequest<InterviewFeedback>(`${BASE}/${interviewId}/feedback`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  invalidateApiCache(`${BASE}/${interviewId}`);
  return result;
}

export async function getFeedback(interviewId: string): Promise<InterviewFeedback[]> {
  return apiRequest<InterviewFeedback[]>(`${BASE}/${interviewId}/feedback`);
}

export async function getMyProfile(): Promise<InterviewerProfile | null> {
  return apiRequest<InterviewerProfile | null>(`${BASE}/profile/me`);
}

export async function upsertMyProfile(payload: Partial<InterviewerProfile> & { skills?: string[] }): Promise<InterviewerProfile> {
  return apiRequest<InterviewerProfile>(`${BASE}/profile/me`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

// ── Workspace ────────────────────────────────────────────────────────────

export async function getWorkspace(interviewId: string): Promise<WorkspaceData> {
  return apiRequest<WorkspaceData>(`${BASE}/${interviewId}/workspace`);
}

export async function getNotes(interviewId: string): Promise<InterviewNote[]> {
  return apiRequest<InterviewNote[]>(`${BASE}/${interviewId}/notes`);
}

export async function upsertNote(
  interviewId: string,
  payload: { section?: string | null; content: string; finalized?: boolean },
): Promise<InterviewNote> {
  const result = await apiRequest<InterviewNote>(`${BASE}/${interviewId}/notes`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  invalidateApiCache(`${BASE}/${interviewId}`);
  return result;
}

export async function startInterview(interviewId: string): Promise<Interview> {
  const result = await apiRequest<Interview>(`${BASE}/${interviewId}/start`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  invalidateApiCache(`${BASE}/${interviewId}`);
  return result;
}

export async function completeInterview(interviewId: string): Promise<Interview> {
  const result = await apiRequest<Interview>(`${BASE}/${interviewId}/complete`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  invalidateApiCache(`${BASE}/${interviewId}`);
  return result;
}

export async function markNoShow(interviewId: string): Promise<Interview> {
  const result = await apiRequest<Interview>(`${BASE}/${interviewId}/no-show`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  invalidateApiCache(`${BASE}/${interviewId}`);
  return result;
}

// ── Reminders (SCHED-006) ────────────────────────────────────────────────

export async function getInterviewReminders(interviewId: string): Promise<InterviewReminder[]> {
  return apiRequest<InterviewReminder[]>(`${BASE}/${interviewId}/reminders`);
}

// ── AI Summary (AI-004) ──────────────────────────────────────────────────

export async function getAISummary(interviewId: string): Promise<AISummaryResponse> {
  return apiRequest<AISummaryResponse>(`${BASE}/${interviewId}/summary`);
}

export async function generateAISummary(interviewId: string): Promise<{ status: string; interview_id: string }> {
  return apiRequest<{ status: string; interview_id: string }>(`${BASE}/${interviewId}/summary/generate`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function updateAISummary(
  interviewId: string,
  payload: AISummaryUpdatePayload,
): Promise<AISummaryResponse> {
  const result = await apiRequest<AISummaryResponse>(`${BASE}/${interviewId}/summary`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  invalidateApiCache(`${BASE}/${interviewId}`);
  return result;
}

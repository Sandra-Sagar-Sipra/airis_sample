import { assertAllowedDocumentFile } from "@/lib/documents/fileSecurityValidator";
import { apiRequest, ApiError, API_BASE_URL, invalidateApiCache } from "@/lib/api/client";
import type {
  Job,
  JobCandidateListItem,
  JobMatchesResponse,
  JobMetrics,
  JobStatus,
  JobSubmission,
  JobSubmissionStatus,
} from "@/lib/api/types";

export type JobParseResult = {
  title: string | null;
  location: string | null;
  employment_type: string | null;
  experience_min_years: number | null;
  experience_max_years: number | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string;
  urgency: string;
  description: string | null;
  required_skills: string[];
  preferred_skills: string[];
  key_responsibilities?: string[];
  raw_jd_text?: string;
  parsing_source?: string;
  parsing_status?: string;
};

/**
 * Calls POST /jobs/parse-jd with multipart/form-data.
 * We use raw fetch here because apiRequest forces Content-Type: application/json
 * which breaks file uploads (browser must set the multipart boundary itself).
 */
export async function parseJD(
  input: { type: "text"; text: string } | { type: "file"; file: File }
): Promise<JobParseResult> {
  const token =
    typeof window !== "undefined"
      ? window.localStorage.getItem("airis_access_token")
      : null;

  const form = new FormData();
  if (input.type === "text") {
    form.append("raw_text", input.text);
  } else {
    form.append("pdf_file", input.file);
  }

  const response = await fetch(`${API_BASE_URL}/jobs/parse-jd`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });

  if (!response.ok) {
    let detail: unknown = null;
    try {
      detail = await response.json();
    } catch {
      detail = await response.text();
    }
    const msg =
      detail && typeof detail === "object" && "detail" in detail
        ? String((detail as { detail: unknown }).detail)
        : `Parse failed (${response.status})`;
    throw new ApiError(msg, response.status, detail);
  }

  return (await response.json()) as JobParseResult;
}

const JOBS_LIST_SESSION_KEY = "airis_jobs_list_v1";
const JOBS_LIST_SESSION_TTL_MS = 5 * 60_000;

export function readCachedJobsList(): Job[] | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(JOBS_LIST_SESSION_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { savedAt: number; jobs: Job[] };
    if (Date.now() - parsed.savedAt > JOBS_LIST_SESSION_TTL_MS) {
      window.sessionStorage.removeItem(JOBS_LIST_SESSION_KEY);
      return null;
    }
    return parsed.jobs;
  } catch {
    return null;
  }
}

export function writeCachedJobsList(jobs: Job[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.setItem(JOBS_LIST_SESSION_KEY, JSON.stringify({ savedAt: Date.now(), jobs }));
  } catch {
    // Ignore quota errors.
  }
}

export async function getJobs(limit = 50, offset = 0) {
  return apiRequest<Job[]>(`/jobs?limit=${limit}&offset=${offset}`, {}, 60_000);
}

/** Jobs for dropdowns/filters — never throws; uses session cache on failure. */
export async function getJobsForSelect(limit = 100, offset = 0): Promise<Job[]> {
  const cached = readCachedJobsList();
  try {
    const jobs = await apiRequest<Job[]>(
      `/jobs?limit=${limit}&offset=${offset}`,
      { silentErrors: true },
      60_000
    );
    writeCachedJobsList(jobs);
    return jobs;
  } catch {
    return cached ?? [];
  }
}

export async function getJobById(jobId: string) {
  return apiRequest<Job>(`/jobs/${jobId}`);
}

export async function getJobCandidates(jobId: string) {
  return apiRequest<JobCandidateListItem[]>(`/jobs/${jobId}/candidates`);
}

export async function submitCandidateToJob(
  jobId: string,
  candidateId: string,
  notes?: string
) {
  const payload = JSON.stringify({ candidate_id: candidateId, notes: notes ?? null });
  // Canonical endpoint that creates BOTH the job submission AND an initial pipeline card.
  return apiRequest(`/jobs/${jobId}/submit`, {
    method: "POST",
    body: payload,
  });
}

export async function uploadJobJdDocument(jobId: string, file: File) {
  assertAllowedDocumentFile(file);
  const token =
    typeof window !== "undefined" ? window.localStorage.getItem("airis_access_token") : null;
  const orgId =
    typeof window !== "undefined" ? window.localStorage.getItem("airis_organization_id") : null;
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${API_BASE_URL}/jobs/${jobId}/jd-document`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(orgId ? { "X-Workspace-Id": orgId } : {}),
    },
    body: form,
  });
  if (!response.ok) {
    let detail: unknown = null;
    try {
      detail = await response.json();
    } catch {
      detail = await response.text();
    }
    const msg =
      detail && typeof detail === "object" && "detail" in detail
        ? String((detail as { detail: unknown }).detail)
        : `Upload failed (${response.status})`;
    throw new ApiError(msg, response.status, detail);
  }
  return (await response.json()) as Job;
}

export async function createJob(payload: {
  client_id?: string | null;
  title: string;
  description?: string | null;
  status?: JobStatus;
  location?: string;
  salary_min?: number | null;
  salary_max?: number | null;
  salary_currency?: string | null;
  experience_min_years?: number | null;
  experience_max_years?: number | null;
  employment_type?: string | null;
  urgency?: string | null;
  required_skills?: string[];
  preferred_skills?: string[];
  key_responsibilities?: string[];
  raw_jd_text?: string | null;
  parsing_source?: string | null;
  parsing_status?: string | null;
}) {
  return apiRequest<Job>(`/jobs`, {
    method: "POST",
    body: JSON.stringify(payload),
    timeoutMs: 25_000,
  });
}

export type DuplicateJobMatchOut = {
  job_id: string;
  title: string;
  status: string;
  created_at: string;
  client_id: string | null;
  location: string | null;
  confidence: number;
};

export async function checkDuplicateJob(payload: { title: string; client_id?: string; location?: string }) {
  return apiRequest<{ has_duplicates: boolean; matches: DuplicateJobMatchOut[] }>(
    `/jobs/check-duplicate`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
}

export async function updateJob(jobId: string, payload: any) {
  return apiRequest(`/jobs/${jobId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function changeJobStatus(jobId: string, status: JobStatus, reason?: string) {
  return apiRequest(`/jobs/${jobId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status, reason: reason ?? null }),
  });
}

export async function deleteJob(jobId: string) {
  const result = await apiRequest(`/jobs/${jobId}`, {
    method: "DELETE",
  });
  // Drop cached GETs for this job and list queries so UI does not briefly show a deleted job.
  invalidateApiCache(`/jobs/${jobId}`);
  invalidateApiCache("/jobs?");
  return result;
}

export async function getJobSubmissions(jobId: string, params?: { submission_status?: JobSubmissionStatus; limit?: number; offset?: number }) {
  const limit = params?.limit ?? 50;
  const offset = params?.offset ?? 0;
  const submissionStatus = params?.submission_status;
  const query = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (submissionStatus) query.set("submission_status", submissionStatus);
  return apiRequest<{ data: JobSubmission[], total: number }>(`/jobs/${jobId}/submissions?${query.toString()}`);
}

export async function triggerJobMatching(jobId: string, refresh = false) {
  if (refresh) {
    return apiRequest(`/jobs/${jobId}/rescore`, {
      method: "POST",
    });
  }
  return apiRequest(`/jobs/${jobId}/match`, {
    method: "POST",
    body: JSON.stringify({ refresh }),
  });
}

export async function getJobMatches(jobId: string, params?: { limit?: number; offset?: number }) {
  const limit = params?.limit ?? 50;
  const offset = params?.offset ?? 0;
  return apiRequest<JobMatchesResponse>(`/jobs/${jobId}/matches?limit=${limit}&offset=${offset}`);
}

export async function updateJobSubmissionStatus(jobId: string, submissionId: string, status: JobSubmissionStatus) {
  return apiRequest<JobSubmission>(`/jobs/${jobId}/submissions/${submissionId}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export async function getJobsMetrics() {
  return apiRequest<JobMetrics[]>("/jobs/metrics");
}

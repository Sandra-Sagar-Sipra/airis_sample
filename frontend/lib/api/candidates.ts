import { API_BASE_URL, ApiError, apiRequest, invalidateApiCache } from "@/lib/api/client";
import { CANDIDATES_BULK_STAGE_PATH } from "@/lib/api/candidateManagementPaths";
import type { Candidate } from "@/lib/api/types";

const AIRIS_META_PREFIX = "__AIRIS_META__:";

type CandidateManagementEnvelope<T> = {
  success: boolean;
  data: T;
  error: string | null;
  details: unknown;
};

export type CandidateManagementParseResult = {
  parsed_resume_data: Record<string, unknown>;
  parse_confidence: number | null;
  ai_parse_version: string | null;
  extracted_skills: Array<{
    name: string;
    proficiency: string | null;
    years_experience: number | null;
    confidence: number | null;
    source: string | null;
  }>;
};

type CandidateManagementResumeUploadResponse = {
  candidate: CandidateManagementCandidate;
  parse_result: CandidateManagementParseResult;
};

type CandidateManagementListData = {
  candidates: CandidateManagementCandidate[];
  total_count: number;
  limit: number;
  offset: number;
};

type CandidateManagementCandidate = {
  id: string;
  org_id: string;
  workspace_id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  years_experience: number | null;
  headline: string | null;
  summary: string | null;
  stage: "applied" | "screening" | "shortlisted" | "interview" | "offered" | "hired" | "rejected";
  job_id: string | null;
  recruiter_id: string | null;
  resume_s3_key: string | null;
  resume_file_name: string | null;
  source: "manual" | "resume_upload" | "bulk_upload" | "referral" | "agency" | "import" | "merge";
  status: "active" | "archived" | "deleted";
  created_at: string;
  updated_at: string;
  parse_status?: "pending" | "processing" | "completed" | "failed" | null;
  parse_error?: string | null;
  parsed_at?: string | null;
  parsed_resume_data?: Candidate["parsed_resume_data"] | Record<string, unknown> | null;
};

function shouldUseCandidateManagementApi(): boolean {
  return (process.env.NEXT_PUBLIC_USE_CANDIDATE_MANAGEMENT ?? "false").toLowerCase() === "true";
}

export function getWorkspaceHeader(): Record<string, string> {
  if (typeof window === "undefined") {
    return {};
  }
  const orgId = window.localStorage.getItem("airis_organization_id");
  // Until workspace is explicitly modeled in frontend auth state, org ID is used as scoped workspace header.
  return orgId ? { "X-Workspace-Id": orgId } : {};
}

function mapCandidateManagementCandidate(candidate: CandidateManagementCandidate): Candidate {
  const pr = candidate.parsed_resume_data;
  let educationFromParse: string | null = null;
  if (pr && typeof pr === "object" && "education" in pr) {
    const edu = (pr as { education?: unknown }).education;
    if (typeof edu === "string" && edu.trim()) educationFromParse = edu.trim();
    else if (Array.isArray(edu)) {
      const joined = edu.map(String).filter(Boolean).join(", ");
      educationFromParse = joined || null;
    }
  }
  return {
    id: candidate.id,
    organization_id: candidate.org_id,
    first_name: candidate.first_name,
    last_name: candidate.last_name,
    email: candidate.email ?? "",
    phone: candidate.phone,
    location: candidate.location,
    role: candidate.headline,
    stage: candidate.stage,
    job_id: candidate.job_id,
    recruiter_id: candidate.recruiter_id,
    resume_s3_key: candidate.resume_s3_key,
    resume_file_name: candidate.resume_file_name,
    source: candidate.source,
    status: candidate.status,
    years_experience: candidate.years_experience,
    experience_summary: candidate.summary,
    education: educationFromParse,
    notes: null,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
    parse_status: candidate.parse_status ?? undefined,
    parse_error: candidate.parse_error ?? undefined,
    parsed_at: candidate.parsed_at ?? undefined,
    parsed_resume_data:
      pr && typeof pr === "object"
        ? (pr as Candidate["parsed_resume_data"])
        : undefined,
  };
}

function mapLegacyCandidate(candidate: Candidate): Candidate {
  const meta = extractLegacyMeta(candidate.notes);
  return {
    ...candidate,
    role: meta.role ?? extractRoleFromNotes(candidate.notes),
    years_experience: meta.yearsExperience ?? extractYearsFromSummary(candidate.experience_summary),
    notes: meta.cleanNotes,
  };
}

type CreateCandidatePayload = {
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  location?: string;
  headline?: string;
  years_experience?: number;
  summary?: string;
  source?: "manual" | "resume_upload" | "bulk_upload" | "referral" | "agency" | "import" | "merge";
  stage?: "applied" | "screening" | "shortlisted" | "interview" | "offered" | "hired" | "rejected";
  job_id?: string;
  resume_s3_key?: string;
  resume_file_name?: string;
  parse_confidence?: number;
  parsed_resume_data?: Record<string, unknown>;
};

type UpdateCandidatePayload = {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  location?: string;
  headline?: string;
  years_experience?: number;
  summary?: string;
  status?: "active" | "archived" | "deleted";
  source?: "manual" | "resume_upload" | "bulk_upload" | "referral" | "agency" | "import" | "merge";
  stage?: "applied" | "screening" | "shortlisted" | "interview" | "offered" | "hired" | "rejected";
  job_id?: string;
};

type CandidateStageFilter =
  | "applied"
  | "screening"
  | "shortlisted"
  | "interview"
  | "offered"
  | "hired"
  | "rejected";
type CandidateSourceFilter = "manual" | "resume_upload" | "bulk_upload" | "referral" | "agency";

type CandidateInteractionPayload = {
  interaction_type:
    | "note"
    | "email"
    | "stage_change"
    | "interview"
    | "call"
    | "meeting"
    | "system";
  title?: string;
  body?: string;
  interaction_metadata?: Record<string, unknown>;
};

export type CandidateInteraction = {
  id: string;
  candidate_id: string;
  interaction_type:
    | "note"
    | "email"
    | "stage_change"
    | "interview"
    | "call"
    | "meeting"
    | "system";
  title: string | null;
  body: string | null;
  metadata: Record<string, unknown> | null;
  actor_user_id: string | null;
  actor_role: string | null;
  created_at: string;
};

export type CommunicationConnection = {
  id: string;
  provider: "gmail" | "outlook" | "whatsapp";
  channel: "email" | "whatsapp";
  external_account_email: string | null;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type CommunicationTemplate = {
  id: string;
  channel: "email" | "whatsapp";
  provider: "gmail" | "outlook" | "whatsapp" | null;
  name: string;
  category: string | null;
  subject_template: string | null;
  body_template: string;
  placeholders: string[];
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
};

export type CommunicationMessage = {
  id: string;
  candidate_id: string;
  channel: "email" | "whatsapp";
  provider: "gmail" | "outlook" | "whatsapp";
  direction: "outbound" | "inbound";
  status: "draft" | "queued" | "sent" | "delivered" | "read" | "replied" | "failed";
  to_address: string | null;
  from_address: string | null;
  subject: string | null;
  body: string | null;
  attachments: Array<{ filename?: string; content_type?: string; content_base64?: string }>;
  provider_message_id: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type CommunicationReminder = {
  id: string;
  candidate_id: string;
  channel: "email" | "whatsapp";
  provider: "gmail" | "outlook" | "whatsapp";
  to_address: string | null;
  subject: string | null;
  body: string | null;
  status: string;
  failure_reason: string | null;
  scheduled_for: string;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
};

type BulkUploadRequestPayload = {
  files: string[];
  source?: "import";
};

type BulkUploadItemStatus = {
  id: string;
  status: "pending" | "processing" | "completed" | "failed" | "skipped_duplicate";
  original_file_name: string | null;
  resume_s3_key: string | null;
  error_message: string | null;
};

export type BulkUploadJobStatus = {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  total_items: number;
  processed_items: number;
  success_items: number;
  failed_items: number;
  skipped_items: number;
  items: BulkUploadItemStatus[];
};

type CandidateStatusFilter = "active" | "archived" | "deleted";

export type CandidatesListFilters = {
  query?: string;
  location?: string;
  min_years_experience?: number;
  max_years_experience?: number;
  status?: CandidateStatusFilter;
  stage?: CandidateStageFilter;
  source?: CandidateSourceFilter;
  job_id?: string;
  candidate_ids?: string[];
};

export type CandidatesPageResult = {
  candidates: Candidate[];
  total_count: number;
  limit: number;
  offset: number;
};

function buildCandidatesListParams(limit: number, offset: number, filters?: CandidatesListFilters) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (filters?.query) {
    params.set("query", filters.query);
    params.set("search_mode", "fast");
  }
  if (filters?.location) params.set("location", filters.location);
  if (filters?.min_years_experience !== undefined) {
    params.set("min_years_experience", String(filters.min_years_experience));
  }
  if (filters?.max_years_experience !== undefined) {
    params.set("max_years_experience", String(filters.max_years_experience));
  }
  if (filters?.status) {
    params.set("status", filters.status);
  }
  if (filters?.stage) params.set("stage", filters.stage);
  if (filters?.source) params.set("source", filters.source);
  if (filters?.job_id) params.set("job_id", filters.job_id);
  if (filters?.candidate_ids?.length) {
    for (const id of filters.candidate_ids) {
      params.append("candidate_ids", id);
    }
  }
  return params;
}

const CANDIDATES_LIST_SESSION_KEY = "airis_candidates_list_page_v1";
const CANDIDATES_LIST_SESSION_TTL_MS = 5 * 60_000;

export function isDefaultCandidatesListFilters(filters?: CandidatesListFilters): boolean {
  if (!filters) {
    return true;
  }
  return (
    !filters.query &&
    !filters.location &&
    !filters.status &&
    !filters.stage &&
    !filters.source &&
    filters.min_years_experience === undefined &&
    filters.max_years_experience === undefined &&
    !filters.job_id &&
    !filters.candidate_ids?.length
  );
}

export function readCachedCandidatesListPage(): CandidatesPageResult | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(CANDIDATES_LIST_SESSION_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { savedAt: number; page: CandidatesPageResult };
    if (Date.now() - parsed.savedAt > CANDIDATES_LIST_SESSION_TTL_MS) {
      window.sessionStorage.removeItem(CANDIDATES_LIST_SESSION_KEY);
      return null;
    }
    return parsed.page;
  } catch {
    return null;
  }
}

export function writeCachedCandidatesListPage(page: CandidatesPageResult): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.setItem(
      CANDIDATES_LIST_SESSION_KEY,
      JSON.stringify({ savedAt: Date.now(), page })
    );
  } catch {
    // Ignore quota errors.
  }
}

export async function getCandidatesPage(
  limit = 50,
  offset = 0,
  filters?: CandidatesListFilters
): Promise<CandidatesPageResult> {
  const params = buildCandidatesListParams(limit, offset, filters);
  const path = `/candidate-management/candidates?${params.toString()}`;

  const cacheTtlMs = filters?.query?.trim() ? 15_000 : 60_000;

  try {
    const response = await apiRequest<CandidateManagementEnvelope<CandidateManagementListData>>(
      path,
      {
        headers: {
          ...getWorkspaceHeader(),
        },
      },
      cacheTtlMs
    );
    return {
      candidates: response.data.candidates.map(mapCandidateManagementCandidate),
      total_count: response.data.total_count,
      limit: response.data.limit,
      offset: response.data.offset,
    };
  } catch {
    if (shouldUseCandidateManagementApi()) {
      throw new Error("Unable to load candidates from candidate-management API.");
    }
  }

  const legacy = await apiRequest<Candidate[]>(`/candidates?limit=${limit}&offset=${offset}`);
  const mapped = legacy.map(mapLegacyCandidate);
  return {
    candidates: mapped,
    total_count: mapped.length < limit ? offset + mapped.length : offset + limit + 1,
    limit,
    offset,
  };
}

export async function getCandidatesByIds(candidateIds: string[], filters?: Pick<CandidatesListFilters, "status">) {
  const uniqueIds = [...new Set(candidateIds.filter(Boolean))];
  if (uniqueIds.length === 0) {
    return [] as Candidate[];
  }

  const chunkSize = 100;
  const all: Candidate[] = [];
  for (let index = 0; index < uniqueIds.length; index += chunkSize) {
    const chunk = uniqueIds.slice(index, index + chunkSize);
    const page = await getCandidatesPage(chunk.length, 0, {
      ...filters,
      candidate_ids: chunk,
    });
    all.push(...page.candidates);
  }
  return all;
}

export async function getCandidates(limit = 50, offset = 0, filters?: CandidatesListFilters) {
  const page = await getCandidatesPage(limit, offset, filters);
  return page.candidates;
}

export async function getCandidateById(candidateId: string) {
  if (shouldUseCandidateManagementApi()) {
    const response = await apiRequest<CandidateManagementEnvelope<CandidateManagementCandidate>>(
      `/candidate-management/candidates/${candidateId}`,
      {
        headers: {
          ...getWorkspaceHeader(),
        },
      }
    );
    return mapCandidateManagementCandidate(response.data);
  }
  // Mixed deployments may list candidate-management IDs that don't exist in legacy.
  // Try candidate-management detail first without noisy API error logging.
  try {
    const token = typeof window !== "undefined" ? window.localStorage.getItem("airis_access_token") : null;
    const response = await fetch(`${API_BASE_URL}/candidate-management/candidates/${candidateId}`, {
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...getWorkspaceHeader(),
      },
    });
    if (response.ok) {
      const cm = (await response.json()) as CandidateManagementEnvelope<CandidateManagementCandidate>;
      return mapCandidateManagementCandidate(cm.data);
    }
  } catch {
    // Ignore and continue to legacy fallback.
  }

  const legacy = await apiRequest<Candidate>(`/candidates/${candidateId}`);
  return mapLegacyCandidate(legacy);
}

export async function createCandidate(payload: CreateCandidatePayload) {
  const requiresCandidateManagementCreate = Boolean(
    payload.resume_s3_key ||
    payload.resume_file_name ||
    payload.parsed_resume_data ||
    payload.parse_confidence !== undefined
  );

  if (shouldUseCandidateManagementApi() || requiresCandidateManagementCreate) {
    const response = await apiRequest<CandidateManagementEnvelope<CandidateManagementCandidate>>(
      "/candidate-management/candidates",
      {
        method: "POST",
        body: JSON.stringify(payload),
        headers: {
          ...getWorkspaceHeader(),
        },
      }
    );
    return mapCandidateManagementCandidate(response.data);
  }
  const legacyPayload = {
    first_name: payload.first_name,
    last_name: payload.last_name,
    email: payload.email,
    phone: payload.phone,
    location: payload.location,
    experience_summary:
      payload.years_experience !== undefined && payload.years_experience !== null
        ? `${payload.years_experience} years`
        : payload.summary,
    notes: payload.headline ? composeLegacyNotes({ role: payload.headline }) : undefined,
  };
  const created = await apiRequest<Candidate>("/candidates", {
    method: "POST",
    body: JSON.stringify(legacyPayload),
  });
  return mapLegacyCandidate(created);
}

export async function uploadResume(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  const token = typeof window !== "undefined" ? window.localStorage.getItem("airis_access_token") : null;
  const response = await fetch(
    `${API_BASE_URL}/candidate-management/candidates/upload-resume-file`,
    {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...getWorkspaceHeader(),
      },
      body: formData,
    }
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || "Resume upload failed");
  }
  const payload = (await response.json()) as CandidateManagementEnvelope<CandidateManagementResumeUploadResponse>;
  return {
    candidate: mapCandidateManagementCandidate(payload.data.candidate),
    parseResult: payload.data.parse_result,
  };
}

export async function uploadRawResume(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  const token = typeof window !== "undefined" ? window.localStorage.getItem("airis_access_token") : null;
  const response = await fetch(
    `${API_BASE_URL}/candidate-management/candidates/upload-raw-resume`,
    {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...getWorkspaceHeader(),
      },
      body: formData,
    }
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || "Raw resume upload failed");
  }
  const payload = (await response.json()) as CandidateManagementEnvelope<{
    resume_s3_key: string;
    resume_file_name: string;
  }>;
  return payload.data;
}

export async function uploadResumeForReview(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  const token = typeof window !== "undefined" ? window.localStorage.getItem("airis_access_token") : null;
  const response = await fetch(
    `${API_BASE_URL}/candidate-management/candidates/parse-resume-file`,
    {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...getWorkspaceHeader(),
      },
      body: formData,
    }
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || "Resume parse failed");
  }
  const payload = (await response.json()) as CandidateManagementEnvelope<{
    draft: {
      first_name: string;
      last_name: string;
      email: string;
      phone: string;
      location: string;
      headline: string;
      years_experience: number | null;
      summary: string;
      resume_s3_key: string;
      resume_file_name: string;
    };
    parse_result: CandidateManagementParseResult;
  }>;
  return payload.data;
}

export async function addCandidateInteraction(candidateId: string, payload: CandidateInteractionPayload) {
  invalidateApiCache(`/candidate-management/candidates/${candidateId}/interactions`);
  const response = await apiRequest<CandidateManagementEnvelope<CandidateInteraction>>(
    `/candidate-management/candidates/${candidateId}/interactions`,
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: {
        ...getWorkspaceHeader(),
      },
    }
  );
  return response.data;
}

export async function getCandidateInteractions(
  candidateId: string,
  limit = 100,
  offset = 0,
  options?: { skipCache?: boolean }
) {
  try {
    const response = await apiRequest<CandidateManagementEnvelope<CandidateInteraction[]>>(
      `/candidate-management/candidates/${candidateId}/interactions?limit=${limit}&offset=${offset}`,
      {
        headers: {
          ...getWorkspaceHeader(),
        },
      },
      options?.skipCache ? 0 : undefined
    );
    return response.data;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return [];
    }
    throw error;
  }
}

export async function getCommunicationConnections() {
  const response = await apiRequest<CandidateManagementEnvelope<CommunicationConnection[]>>(
    "/candidate-management/communication/connections",
    {
      headers: { ...getWorkspaceHeader() },
    }
  );
  return response.data;
}

export async function startCommunicationOAuth(provider: "gmail" | "outlook") {
  const response = await apiRequest<
    CandidateManagementEnvelope<{ provider: string; authorization_url: string; state: string }>
  >("/candidate-management/communication/oauth/connect", {
    method: "POST",
    body: JSON.stringify({ provider }),
    headers: { ...getWorkspaceHeader() },
  });
  return response.data;
}

export async function disconnectCommunicationProvider(provider: "gmail" | "outlook") {
  const response = await apiRequest<CandidateManagementEnvelope<{ disconnected: boolean }>>(
    "/candidate-management/communication/disconnect",
    {
      method: "POST",
      body: JSON.stringify({ provider }),
      headers: { ...getWorkspaceHeader() },
    }
  );
  return response.data;
}

export async function getCommunicationTemplates(
  channel: "email" | "whatsapp" = "email",
  options?: { search?: string; category?: string }
) {
  const params = new URLSearchParams({ channel });
  if (options?.search) params.set("search", options.search);
  if (options?.category) params.set("category", options.category);
  const response = await apiRequest<CandidateManagementEnvelope<CommunicationTemplate[]>>(
    `/candidate-management/communication/templates?${params.toString()}`,
    {
      headers: { ...getWorkspaceHeader() },
    }
  );
  return response.data;
}

export async function renderCommunicationTemplate(
  templateId: string,
  values: Record<string, unknown>
) {
  const response = await apiRequest<
    CandidateManagementEnvelope<{
      subject: string | null;
      body: string;
      unresolved_placeholders: string[];
    }>
  >("/candidate-management/communication/templates/render", {
    method: "POST",
    body: JSON.stringify({ template_id: templateId, values }),
    headers: { ...getWorkspaceHeader() },
  });
  return response.data;
}

export async function createCommunicationTemplate(payload: {
  channel?: "email" | "whatsapp";
  provider?: "gmail" | "outlook" | "whatsapp";
  name: string;
  category?: string;
  subject_template?: string;
  body_template: string;
}) {
  const response = await apiRequest<CandidateManagementEnvelope<CommunicationTemplate>>(
    "/candidate-management/communication/templates",
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { ...getWorkspaceHeader() },
    }
  );
  return response.data;
}

export async function updateCommunicationTemplate(
  templateId: string,
  payload: Partial<{
    name: string;
    category: string;
    subject_template: string;
    body_template: string;
    is_deleted: boolean;
  }>
) {
  const response = await apiRequest<CandidateManagementEnvelope<CommunicationTemplate>>(
    `/candidate-management/communication/templates/${templateId}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
      headers: { ...getWorkspaceHeader() },
    }
  );
  return response.data;
}

export async function duplicateCommunicationTemplate(templateId: string) {
  const response = await apiRequest<CandidateManagementEnvelope<CommunicationTemplate>>(
    `/candidate-management/communication/templates/${templateId}/duplicate`,
    {
      method: "POST",
      headers: { ...getWorkspaceHeader() },
    }
  );
  return response.data;
}

export async function sendCandidateEmail(
  candidateId: string,
  payload: {
    provider: "gmail" | "outlook";
    to_email: string;
    subject?: string;
    body?: string;
    save_as_draft?: boolean;
    quick_action?: string;
    attachments?: Array<{ filename: string; content_type: string; content_base64: string }>;
    template_id?: string;
    template_values?: Record<string, unknown>;
    idempotency_key?: string;
  }
) {
  const response = await apiRequest<CandidateManagementEnvelope<CommunicationMessage>>(
    `/candidate-management/candidates/${candidateId}/communication/send-email`,
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { ...getWorkspaceHeader() },
    }
  );
  return response.data;
}

export async function sendCandidateWhatsApp(
  candidateId: string,
  payload: {
    to_phone: string;
    body?: string;
    template_id?: string;
    template_values?: Record<string, unknown>;
    idempotency_key?: string;
    quick_action?: string;
  }
) {
  const response = await apiRequest<CandidateManagementEnvelope<CommunicationMessage>>(
    `/candidate-management/candidates/${candidateId}/communication/send-whatsapp`,
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { ...getWorkspaceHeader() },
    }
  );
  return response.data;
}

export async function getCandidateCommunicationMessages(candidateId: string, limit = 50) {
  const response = await apiRequest<CandidateManagementEnvelope<CommunicationMessage[]>>(
    `/candidate-management/candidates/${candidateId}/communication/messages?limit=${limit}`,
    {
      headers: { ...getWorkspaceHeader() },
    }
  );
  return response.data;
}

export async function createCandidateCommunicationReminder(
  candidateId: string,
  payload: {
    channel: "email" | "whatsapp";
    provider: "gmail" | "outlook" | "whatsapp";
    to_address: string;
    template_id?: string;
    template_values?: Record<string, unknown>;
    subject?: string;
    body?: string;
    scheduled_for: string;
  }
) {
  const response = await apiRequest<CandidateManagementEnvelope<CommunicationReminder>>(
    `/candidate-management/candidates/${candidateId}/communication/reminders`,
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { ...getWorkspaceHeader() },
    }
  );
  return response.data;
}

export async function getCandidateCommunicationReminders(candidateId: string) {
  const response = await apiRequest<CandidateManagementEnvelope<CommunicationReminder[]>>(
    `/candidate-management/candidates/${candidateId}/communication/reminders`,
    {
      headers: { ...getWorkspaceHeader() },
    }
  );
  return response.data;
}

export async function runDueCommunicationReminders() {
  const response = await apiRequest<CandidateManagementEnvelope<{ processed: number }>>(
    "/candidate-management/communication/reminders/run-due",
    {
      method: "POST",
      headers: { ...getWorkspaceHeader() },
    }
  );
  return response.data;
}

export async function createBulkUploadJob(payload: BulkUploadRequestPayload) {
  const response = await apiRequest<CandidateManagementEnvelope<BulkUploadJobStatus>>("/candidate-management/bulk-upload", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      ...getWorkspaceHeader(),
    },
  });
  return response.data;
}

export type InterviewRecord = {
  id: string;
  pipeline_id: string;
  scheduled_at: string;
  status: "scheduled" | "completed" | "cancelled" | "no_show" | "rescheduled";
  interviewer_name: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export async function createCandidateInterview(payload: {
  candidate_id: string;
  job_id?: string;
  scheduled_at: string;
  interviewer_name?: string;
  interview_type?: "HR" | "TECH";
  status?: "scheduled" | "completed" | "cancelled";
  feedback?: string;
  rating?: number;
}) {
  const response = await apiRequest<CandidateManagementEnvelope<InterviewRecord>>("/candidate-management/interviews", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      ...getWorkspaceHeader(),
    },
  });
  return response.data;
}

export async function getCandidateInterviews(candidateId: string) {
  const response = await apiRequest<CandidateManagementEnvelope<InterviewRecord[]>>(
    `/candidate-management/candidates/${candidateId}/interviews`,
    {
      headers: {
        ...getWorkspaceHeader(),
      },
    }
  );
  return response.data;
}

export async function updateCandidateInterview(
  interviewId: string,
  payload: {
    scheduled_at?: string;
    status?: "scheduled" | "completed" | "cancelled" | "rescheduled";
    interviewer_name?: string;
    notes?: string;
    interview_type?: "HR" | "TECH";
    rating?: number;
  }
) {
  const response = await apiRequest<CandidateManagementEnvelope<InterviewRecord>>(
    `/candidate-management/interviews/${interviewId}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
      headers: {
        ...getWorkspaceHeader(),
      },
    }
  );
  return response.data;
}

export async function bulkUpdateCandidateStage(payload: {
  candidate_ids: string[];
  stage: "applied" | "screening" | "shortlisted" | "interview" | "offered" | "hired" | "rejected";
}) {
  return apiRequest<CandidateManagementEnvelope<{ updated_count: number }>>(CANDIDATES_BULK_STAGE_PATH, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      ...getWorkspaceHeader(),
    },
  });
}

/** AIR-510: Bulk archive (soft-delete). */
export async function bulkArchiveCandidates(payload: { candidate_ids: string[] }) {
  return apiRequest<CandidateManagementEnvelope<{ archived_count?: number; deleted_count: number }>>(
    "/candidate-management/candidates/bulk/delete",
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: {
        ...getWorkspaceHeader(),
      },
    }
  );
}

/** @deprecated Use bulkArchiveCandidates — bulk/delete is the archive endpoint. */
export async function bulkDeleteCandidates(payload: { candidate_ids: string[] }) {
  return bulkArchiveCandidates(payload);
}

export async function bulkUnarchiveCandidates(payload: { candidate_ids: string[] }) {
  return apiRequest<CandidateManagementEnvelope<{ unarchived_count: number }>>("/candidate-management/candidates/bulk/unarchive", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      ...getWorkspaceHeader(),
    },
  });
}

export async function bulkHardDeleteCandidates(payload: { candidate_ids: string[] }) {
  return apiRequest<CandidateManagementEnvelope<{ deleted_count: number }>>("/candidate-management/candidates/bulk/hard-delete", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      ...getWorkspaceHeader(),
    },
  });
}

export async function bulkAssignRecruiter(payload: { candidate_ids: string[]; recruiter_id: string }) {
  return apiRequest<CandidateManagementEnvelope<{ updated_count: number }>>(
    "/candidate-management/candidates/bulk/assign-recruiter",
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: {
        ...getWorkspaceHeader(),
      },
    }
  );
}

export async function assignCandidateRecruiter(candidateId: string, recruiterId: string) {
  const response = await apiRequest<CandidateManagementEnvelope<CandidateManagementCandidate>>(
    `/candidate-management/candidates/${candidateId}/assign-recruiter`,
    {
      method: "POST",
      body: JSON.stringify({ recruiter_id: recruiterId }),
      headers: {
        ...getWorkspaceHeader(),
      },
    }
  );
  return mapCandidateManagementCandidate(response.data);
}

export async function getBulkUploadJobStatus(jobId: string) {
  const response = await apiRequest<CandidateManagementEnvelope<BulkUploadJobStatus>>(
    `/candidate-management/bulk-upload/${jobId}`,
    {
      headers: {
        ...getWorkspaceHeader(),
      },
    }
  );
  return response.data;
}

export async function uploadResumeAndCreateCandidate(file: File) {
  const payload = await uploadResume(file);
  return payload.candidate;
}

/** Permanent hard delete (not archive). */
export async function deleteCandidate(candidateId: string) {
  if (shouldUseCandidateManagementApi()) {
    await apiRequest<CandidateManagementEnvelope<{ deleted: boolean; hard_deleted?: boolean; candidate_id: string }>>(
      `/candidate-management/candidates/${candidateId}`,
      {
        method: "DELETE",
        headers: {
          ...getWorkspaceHeader(),
        },
      }
    );
    invalidateApiCache();
    const { clearPipelineBoardCache } = await import("@/lib/api/pipeline");
    clearPipelineBoardCache();
    return;
  }
  await apiRequest<{ deleted: boolean; hard_deleted?: boolean; candidate_id: string }>(
    `/candidates/${candidateId}`,
    {
      method: "DELETE",
    }
  );
  invalidateApiCache();
  const { clearPipelineBoardCache } = await import("@/lib/api/pipeline");
  clearPipelineBoardCache();
}

/** AIR-510: Archive (soft-delete) a single candidate. */
export async function archiveCandidate(candidateId: string) {
  if (shouldUseCandidateManagementApi()) {
    await apiRequest<CandidateManagementEnvelope<{ archived: boolean; candidate_id: string }>>(
      `/candidate-management/candidates/${candidateId}/archive`,
      {
        method: "POST",
        headers: { ...getWorkspaceHeader() },
      }
    );
    return;
  }
  await apiRequest<{ archived: boolean; candidate_id: string }>(`/candidates/${candidateId}/archive`, {
    method: "POST",
  });
}

/** AIR-512: Admin restore soft-deleted candidate. */
export async function restoreCandidate(candidateId: string) {
  if (shouldUseCandidateManagementApi()) {
    const response = await apiRequest<CandidateManagementEnvelope<CandidateManagementCandidate>>(
      `/candidate-management/candidates/${candidateId}/restore`,
      {
        method: "PATCH",
        headers: { ...getWorkspaceHeader() },
      }
    );
    return response.data;
  }
  return apiRequest<Candidate>(`/candidates/${candidateId}/restore`, { method: "PATCH" });
}

export async function updateCandidate(candidateId: string, payload: UpdateCandidatePayload) {
  if (shouldUseCandidateManagementApi()) {
    const response = await apiRequest<CandidateManagementEnvelope<CandidateManagementCandidate>>(
      `/candidate-management/candidates/${candidateId}`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
        headers: {
          ...getWorkspaceHeader(),
        },
      }
    );
    return mapCandidateManagementCandidate(response.data);
  }
  // Mixed deployments: candidate may exist only in candidate-management.
  try {
    const response = await apiRequest<CandidateManagementEnvelope<CandidateManagementCandidate>>(
      `/candidate-management/candidates/${candidateId}`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
        headers: {
          ...getWorkspaceHeader(),
        },
      }
    );
    return mapCandidateManagementCandidate(response.data);
  } catch {
    // Fallback to legacy update for legacy-only candidates.
  }

  const legacyPayload = {
    first_name: payload.first_name,
    last_name: payload.last_name,
    email: payload.email,
    phone: payload.phone,
    location: payload.location,
    experience_summary:
      payload.years_experience !== undefined && payload.years_experience !== null
        ? `${payload.years_experience} years`
        : payload.summary,
    notes: payload.headline ? composeLegacyNotes({ role: payload.headline }) : undefined,
  };
  const updated = await apiRequest<Candidate>(`/candidates/${candidateId}`, {
    method: "PUT",
    body: JSON.stringify(legacyPayload),
  });
  return mapLegacyCandidate(updated);
}

function extractRoleFromNotes(notes: string | null): string | null {
  if (!notes) {
    return null;
  }
  const marker = "ROLE:";
  if (!notes.startsWith(marker)) {
    return null;
  }
  const value = notes.slice(marker.length).trim();
  return value || null;
}

function extractYearsFromSummary(summary: string | null): number | null {
  if (!summary) {
    return null;
  }
  const match = summary.match(/(\d+)/);
  if (!match) {
    return null;
  }
  const years = Number.parseInt(match[1], 10);
  return Number.isNaN(years) ? null : years;
}

function composeLegacyNotes(meta: { role?: string | null }): string | undefined {
  const role = meta.role?.trim();
  if (!role) {
    return undefined;
  }
  return `${AIRIS_META_PREFIX}${JSON.stringify({ role })}`;
}

function extractLegacyMeta(notes: string | null): { role: string | null; yearsExperience: number | null; cleanNotes: string | null } {
  if (!notes) {
    return { role: null, yearsExperience: null, cleanNotes: null };
  }
  if (!notes.startsWith(AIRIS_META_PREFIX)) {
    const legacyRole = extractRoleFromNotes(notes);
    if (legacyRole) {
      return { role: legacyRole, yearsExperience: null, cleanNotes: null };
    }
    return { role: null, yearsExperience: null, cleanNotes: notes };
  }

  const raw = notes.slice(AIRIS_META_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(raw) as { role?: string; years_experience?: number };
    return {
      role: parsed.role ?? null,
      yearsExperience: parsed.years_experience ?? null,
      cleanNotes: null,
    };
  } catch {
    return { role: null, yearsExperience: null, cleanNotes: notes };
  }
}

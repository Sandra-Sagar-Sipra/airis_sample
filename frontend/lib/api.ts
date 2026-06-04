import { apiRequest } from "@/lib/api/client";
import type {
  Job,
  JobCandidateListItem,
  JobCandidateRow,
  JobMetrics,
  JobVendorAssignment,
  OrganizationUser,
  Pipeline,
} from "@/lib/api/types";

export type Role = {
  id: string;
  organization_id: string;
  name: string;
  key: string;
  user_count?: number;
};

export type PermissionItem = {
  code: string;
  display_name: string;
};

export type PermissionModuleGroup = {
  module: string;
  permissions: PermissionItem[];
};

export async function getRoles() {
  return apiRequest<Role[]>("/roles");
}

export async function createRole(payload: { name: string }) {
  return apiRequest<Role>("/roles", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getPermissions() {
  return apiRequest<PermissionModuleGroup[]>("/permissions");
}

export async function assignPermissions(roleId: string, permissions: string[]) {
  return apiRequest<string[]>(`/roles/${roleId}/permissions`, {
    method: "POST",
    body: JSON.stringify({ permissions }),
  });
}

export async function getRolePermissions(roleId: string) {
  return apiRequest<string[]>(`/roles/${roleId}/permissions`);
}

// --- Recruiter dashboard: jobs, vendors, job candidates ---

export async function listPipelines(options?: { limit?: number; offset?: number; jobId?: string }) {
  const params = new URLSearchParams();
  params.set("limit", String(options?.limit ?? 200));
  params.set("offset", String(options?.offset ?? 0));
  if (options?.jobId) {
    params.set("job_id", options.jobId);
  }
  return apiRequest<Pipeline[]>(`/pipelines?${params.toString()}`);
}

export async function getJobs(limit = 50, offset = 0) {
  return apiRequest<Job[]>(`/jobs?limit=${limit}&offset=${offset}`);
}

export async function getJobById(id: string) {
  return apiRequest<Job>(`/jobs/${id}`);
}

export async function getJobsMetrics() {
  return apiRequest<JobMetrics[]>("/jobs/metrics");
}

export async function getJobVendors(jobId: string) {
  return apiRequest<JobVendorAssignment[]>(`/jobs/${jobId}/vendors`);
}

export async function assignVendorToJob(jobId: string, vendorId: string) {
  return apiRequest<{ job_id: string; vendor_id: string }>(`/jobs/${jobId}/vendors`, {
    method: "POST",
    body: JSON.stringify({ vendor_id: vendorId }),
  });
}

export async function removeVendorFromJob(jobId: string, vendorId: string) {
  return apiRequest<void>(`/jobs/${jobId}/vendors/${vendorId}`, {
    method: "DELETE",
  });
}

/** In-memory cache for GET /users?role=vendor (reduces repeat loads e.g. assign modal). */
let vendorListCache: { at: number; data: OrganizationUser[] } | null = null;
const VENDOR_LIST_TTL_MS = 5 * 60 * 1000;

export function invalidateVendorListCache() {
  vendorListCache = null;
}

/**
 * Vendor users in the org via GET /users?role=vendor, with a short TTL cache.
 */
export async function getVendors(options?: { force?: boolean }) {
  if (!options?.force && vendorListCache && Date.now() - vendorListCache.at < VENDOR_LIST_TTL_MS) {
    return vendorListCache.data;
  }
  const users = await apiRequest<OrganizationUser[]>(`/users?role=vendor`);
  vendorListCache = { at: Date.now(), data: users };
  return users;
}

function mapJobCandidateListItem(row: JobCandidateListItem): JobCandidateRow {
  const source_type =
    row.source_type === "vendor" || row.source_type === "internal" ? row.source_type : undefined;
  return {
    pipeline_id: row.pipeline_id,
    candidate: {
      id: row.id,
      organization_id: "",
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.email,
      role: null,
      source_type,
      phone: null,
      location: null,
      years_experience: null,
      experience_summary: null,
      education: null,
      notes: null,
      created_at: "",
      updated_at: "",
    },
  };
}

/**
 * Candidates applied to this job (GET /jobs/:jobId/candidates — single round-trip).
 */
export async function getJobCandidates(jobId: string): Promise<JobCandidateRow[]> {
  const rows = await apiRequest<JobCandidateListItem[]>(`/jobs/${jobId}/candidates`);
  return rows.map(mapJobCandidateListItem);
}


/**
 * CAND-006: Candidate duplicate detection & merge API client.
 */

import { apiRequest } from "@/lib/api/client";

export interface DuplicateMatch {
  candidate_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  location: string | null;
  pipeline_count: number;
  confidence: number;
  match_type: "email" | "phone";
}

export interface DuplicateCheckResult {
  has_duplicates: boolean;
  matches: DuplicateMatch[];
}

export interface MergeResponse {
  survivor_id: string;
  duplicate_id: string;
  message: string;
}

/**
 * Check whether a candidate with the given email/phone already exists.
 *
 * Returns up to N matches sorted by confidence descending.
 * Call this *before* `createCandidate()` to surface potential duplicates.
 */
export async function checkDuplicate(
  email: string | null | undefined,
  phone: string | null | undefined,
  excludeId?: string,
): Promise<DuplicateCheckResult> {
  return apiRequest<DuplicateCheckResult>("/candidates/check-duplicate", {
    method: "POST",
    body: JSON.stringify({
      email: email?.trim() || null,
      phone: phone?.trim() || null,
      exclude_id: excludeId ?? null,
    }),
  });
}

/**
 * Merge a duplicate candidate into the survivor (admin-only).
 *
 * `survivorId` is the candidate to **keep**.
 * `duplicateId` is the candidate that will be soft-deleted after
 * its pipeline/interview history is reassigned.
 */
export async function mergeCandidates(
  survivorId: string,
  duplicateId: string,
): Promise<MergeResponse> {
  return apiRequest<MergeResponse>(`/candidates/${survivorId}/merge`, {
    method: "POST",
    body: JSON.stringify({ duplicate_id: duplicateId }),
  });
}

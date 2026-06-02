/** AIR-504: Read-only placement history — GET list only; no create/update/delete client APIs. */
import { apiRequest } from "@/lib/api/client";

export type PlacementOutcome =
  | "pending"
  | "applied"
  | "ai_interview"
  | "interview"
  | "offer"
  | "placed"
  | "rejected";

export type CandidatePlacement = {
  id: string;
  candidate_id: string;
  job_id: string;
  job_title: string;
  outcome: PlacementOutcome;
  placement_date: string;
  created_at: string;
  /** Present when outcome is rejected — recruiter note from pipeline transition. */
  rejection_reason?: string | null;
};

export type CandidatePlacementListResponse = {
  data: CandidatePlacement[];
  total: number;
};

export async function getCandidatePlacements(
  candidateId: string,
  options?: { skipCache?: boolean }
): Promise<CandidatePlacementListResponse> {
  const path = `/candidates/${candidateId}/placements`;
  return apiRequest<CandidatePlacementListResponse>(
    path,
    { silentErrors: true },
    options?.skipCache ? 0 : undefined
  );
}

"use client";

/** AIR-505 / AIR-504: Read-only placement history tab — GET /candidates/{id}/placements only. */

import { Fragment, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, XCircle } from "lucide-react";
import { ApiError } from "@/lib/api/client";
import { getCandidatePlacements, type CandidatePlacement } from "@/lib/api/placements";
import { cn } from "@/lib/utils";

const OUTCOME_LABEL: Record<PlacementOutcome, string> = {
  pending: "Pending",
  applied: "Applied",
  ai_interview: "AI Interview Screening",
  interview: "Interview",
  offer: "Offered",
  placed: "Hired",
  rejected: "Rejected",
};

const OUTCOME_CLASS: Record<PlacementOutcome, string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  applied: "bg-violet-50 text-violet-700 border-violet-200",
  ai_interview: "bg-orange-50 text-orange-700 border-orange-200",
  interview: "bg-emerald-50 text-emerald-700 border-emerald-200",
  offer: "bg-yellow-50 text-yellow-800 border-yellow-200",
  placed: "bg-emerald-50 text-emerald-800 border-emerald-300",
  rejected: "bg-red-50 text-red-700 border-red-200",
};

type PlacementOutcome = CandidatePlacement["outcome"];

function outcomeLabel(outcome: string): string {
  return OUTCOME_LABEL[outcome as PlacementOutcome] ?? outcome.replace(/_/g, " ");
}

function outcomeClass(outcome: string): string {
  return (
    OUTCOME_CLASS[outcome as PlacementOutcome] ??
    "bg-slate-50 text-slate-700 border-slate-200"
  );
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const EMPTY_RESPONSE = { data: [] as CandidatePlacement[], total: 0 };

type PlacementHistoryTabProps = {
  candidateId: string;
  /** Bump after job submit so the tab refetches fresh rows (cache bypass). */
  refreshToken?: number;
};

export function PlacementHistoryTab({ candidateId, refreshToken = 0 }: PlacementHistoryTabProps) {
  const [rows, setRows] = useState<CandidatePlacement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRejectionJobId, setExpandedRejectionJobId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setExpandedRejectionJobId(null);
    getCandidatePlacements(candidateId, { skipCache: refreshToken > 0 })
      .then((res) => {
        if (!cancelled) {
          setRows(res.data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          if (err instanceof ApiError && err.status === 404) {
            setRows(EMPTY_RESPONSE.data);
            setError(null);
          } else {
            setError(
              (err as { message?: string })?.message ?? "Failed to load placement history."
            );
          }
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [candidateId, refreshToken]);

  function toggleRejectionDetail(jobId: string) {
    setExpandedRejectionJobId((current) => (current === jobId ? null : jobId));
  }

  if (loading) {
    return (
      <div
        data-testid="placement-history-loading"
        className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center"
      >
        <p className="text-sm text-slate-400">Loading placement history…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="placement-history-error"
        className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center"
      >
        <p className="text-sm text-red-500">{error}</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div
        data-testid="placement-history-empty"
        className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center"
      >
        <p className="text-sm text-slate-500 italic">No placement history recorded yet.</p>
        <p className="text-xs text-slate-400 mt-2">
          Submit this candidate to a job to start tracking placements.
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="placement-history-panel"
      className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden"
    >
      <div className="border-b border-gray-100 bg-gray-50/50 px-5 py-4">
        <h2 className="text-base font-semibold text-gray-900">Placement History</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Pipeline and placement events for this candidate (newest first). Click Rejected to see
          why.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table data-testid="placement-history-table" className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
              <th className="px-5 py-3">Job</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3">Date</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isRejected = row.outcome === "rejected";
              const isExpanded = isRejected && expandedRejectionJobId === row.job_id;
              return (
                <Fragment key={row.id}>
                  <tr
                    data-testid={`placement-history-row-${row.id}`}
                    className={cn(
                      "border-b border-gray-50 hover:bg-gray-50/50",
                      isExpanded && "bg-red-50/30"
                    )}
                  >
                    <td className="px-5 py-3 font-medium text-gray-900">{row.job_title}</td>
                    <td className="px-5 py-3">
                      {isRejected ? (
                        <button
                          type="button"
                          onClick={() => toggleRejectionDetail(row.job_id)}
                          aria-expanded={isExpanded}
                          aria-label={
                            isExpanded
                              ? "Hide rejection reason"
                              : "Show rejection reason"
                          }
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
                            OUTCOME_CLASS.rejected,
                            "hover:bg-red-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FF5A1F]/40"
                          )}
                        >
                          {OUTCOME_LABEL.rejected}
                          {isExpanded ? (
                            <ChevronUp className="h-3 w-3 shrink-0" />
                          ) : (
                            <ChevronDown className="h-3 w-3 shrink-0" />
                          )}
                        </button>
                      ) : (
                        <span
                          className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${outcomeClass(row.outcome)}`}
                        >
                          {outcomeLabel(row.outcome)}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-gray-600">{fmtDate(row.placement_date)}</td>
                  </tr>
                  {isExpanded && (
                    <tr
                      key={`${row.id}-reason`}
                      data-testid={`placement-history-rejection-${row.job_id}`}
                      className="border-b border-gray-100 bg-red-50/40"
                    >
                      <td colSpan={3} className="px-5 py-4">
                        <div className="flex gap-3 rounded-lg border border-red-100 bg-white px-4 py-3">
                          <XCircle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <p className="text-xs font-semibold uppercase tracking-wider text-red-700">
                              Rejection reason
                            </p>
                            {row.rejection_reason ? (
                              <p className="mt-1.5 text-sm text-gray-700 italic leading-relaxed">
                                &ldquo;{row.rejection_reason}&rdquo;
                              </p>
                            ) : (
                              <p className="mt-1.5 text-sm text-gray-500">
                                No rejection note was recorded for this job.
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

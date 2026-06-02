"use client";

/**
 * PipelineStageHistoryPanel
 *
 * Shows the full stage-transition audit log for a single pipeline record.
 * Fetches from GET /pipelines/{id}/history (PIPE-002).
 */

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Clock, XCircle } from "lucide-react";
import { getPipelineStageHistory } from "@/lib/api/pipeline";
import type { PipelineStageHistory } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const STAGE_LABELS: Record<string, string> = {
  applied: "Applied",
  ai_interview: "AI Interview",
  interview: "Interview",
  offer: "Offer",
  placed: "Placed",
  rejected: "Rejected",
};

const STAGE_COLOR: Record<string, string> = {
  applied: "bg-violet-50 text-violet-700 border-violet-200",
  ai_interview: "bg-orange-50 text-orange-700 border-orange-200",
  interview: "bg-blue-50 text-blue-700 border-blue-200",
  offer: "bg-indigo-50 text-indigo-700 border-indigo-200",
  placed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
};

function StageBadge({ stage }: { stage: string }) {
  const color = STAGE_COLOR[stage] ?? "bg-gray-50 text-gray-700 border-gray-200";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        color
      )}
    >
      {STAGE_LABELS[stage] ?? stage}
    </span>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

type Props = {
  pipelineId: string;
  /** If false, the panel starts collapsed and requires a click to expand. */
  defaultExpanded?: boolean;
};

export function PipelineStageHistoryPanel({ pipelineId, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [history, setHistory] = useState<PipelineStageHistory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    setLoading(true);
    setError(null);
    getPipelineStageHistory(pipelineId)
      .then(setHistory)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load history.");
      })
      .finally(() => setLoading(false));
  }, [pipelineId, expanded]);

  return (
    <div className="mt-2 rounded-md border border-gray-100 bg-gray-50/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-gray-600 hover:bg-gray-100/80 rounded-md transition-colors"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Clock className="h-3.5 w-3.5 shrink-0 text-[#FF5A1F]" />
          <span className="truncate">Stage history</span>
          {history.length > 0 ? (
            <span className="shrink-0 rounded-full bg-white border border-gray-200 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500">
              {history.length}
            </span>
          ) : null}
        </span>
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-gray-400" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400" />
        )}
      </button>

      {expanded ? (
        <div className="border-t border-gray-100 px-3 py-2">
          {loading ? (
            <p className="text-[11px] text-gray-400 animate-pulse">Loading…</p>
          ) : null}

          {error ? <p className="text-[11px] text-red-600">{error}</p> : null}

          {!loading && !error && history.length === 0 ? (
            <p className="text-[11px] text-gray-400">No stage transitions yet.</p>
          ) : null}

          {!loading && !error && history.length > 0 ? (
            <ul className="divide-y divide-gray-100">
              {history.map((row) => {
                const isRejection = row.new_stage === "rejected";
                return (
                  <li key={row.id} className="flex gap-2 py-2 first:pt-0 last:pb-0">
                    <div className="mt-0.5 shrink-0">
                      {isRejection ? (
                        <XCircle className="h-4 w-4 text-red-400" />
                      ) : (
                        <span className="block h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-emerald-100" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        {row.previous_stage ? (
                          <>
                            <StageBadge stage={row.previous_stage} />
                            <span className="text-[10px] text-gray-400">→</span>
                          </>
                        ) : null}
                        <StageBadge stage={row.new_stage} />
                        <span className="text-[10px] text-gray-400">·</span>
                        <span className="text-[10px] text-gray-500 whitespace-nowrap">
                          {formatDate(row.transitioned_at)}
                        </span>
                      </div>
                      {row.reason ? (
                        <p className="text-[11px] text-gray-600 leading-snug">
                          &ldquo;{row.reason}&rdquo;
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

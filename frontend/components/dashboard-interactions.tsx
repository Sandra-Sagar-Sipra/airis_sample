"use client";

import { useState, useEffect, useRef } from "react";
import { getPipelinesWithMeta } from "@/lib/api/pipeline";
import { getCandidatesByIds } from "@/lib/api/candidates";
import type { Pipeline, PipelineStage } from "@/lib/api/types";
import { Loader2, X } from "lucide-react";
import Link from "next/link";

function getRelativeTimeString(dateString: string | null): string {
  if (!dateString) return "";
  const timeMs = new Date(dateString).getTime();
  const deltaSeconds = Math.round((timeMs - Date.now()) / 1000);
  const cutoffs = [60, 3600, 86400, 86400 * 7, 86400 * 30, 86400 * 365, Infinity];
  const units: Intl.RelativeTimeFormatUnit[] = ["second", "minute", "hour", "day", "week", "month", "year"];
  const unitIndex = cutoffs.findIndex(cutoff => cutoff > Math.abs(deltaSeconds));
  const divider = unitIndex ? cutoffs[unitIndex - 1] : 1;
  const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  return rtf.format(Math.floor(deltaSeconds / divider), units[unitIndex]);
}

export function PipelineStageTooltipWrapper({
  stage,
  children,
  onClick,
  onMouseEnter,
  className = "relative flex",
  position = "top",
}: {
  stage: PipelineStage | "active_pipeline" | "placements";
  children: React.ReactNode;
  onClick: () => void;
  onMouseEnter?: () => void;
  className?: string;
  position?: "top" | "bottom";
}) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [candidates, setCandidates] = useState<Pipeline[] | null>(null);
  const [candidatesMap, setCandidatesMap] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const hoverTimeoutRef = useRef<number | null>(null);

  const fetchTooltipData = async () => {
    if (hasFetched || loading) return;
    setLoading(true);
    
    const params: any = { limit: 10 };
    if (stage === "active_pipeline") {
      params.status = "active";
    } else if (stage === "placements") {
      params.stage = "placed";
    } else {
      params.stage = stage;
      params.status = "active";
    }
    
    try {
      const res = await getPipelinesWithMeta(params);
      setCandidates(res.data);
      if (res.data.length > 0) {
        const candidateIds = res.data.map((p: Pipeline) => p.candidate_id);
        const cands = await getCandidatesByIds(candidateIds);
        const map: Record<string, any> = {};
        cands.forEach((c: any) => { map[c.id] = c; });
        setCandidatesMap(map);
      }
      setHasFetched(true);
    } catch (err) {
      console.error("Failed to fetch tooltip data", err);
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  };

  const handleMouseEnter = () => {
    if (onMouseEnter) onMouseEnter();
    fetchTooltipData();
    if (hoverTimeoutRef.current) window.clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = window.setTimeout(() => {
      setShowTooltip(true);
    }, 150);
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) window.clearTimeout(hoverTimeoutRef.current);
    setShowTooltip(false);
  };

  return (
    <div
      className={className}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={onClick}
    >
      {children}
      {showTooltip && (
        <div className={`absolute z-50 ${position === "top" ? "bottom-full mb-2" : "top-full mt-2"} left-1/2 -translate-x-1/2 w-56 rounded-xl bg-white border border-slate-200 text-slate-800 p-3 shadow-xl text-left transition-opacity animate-in fade-in zoom-in-95 duration-200 cursor-default`} onClick={(e) => e.stopPropagation()}>
          <div className={`absolute ${position === "top" ? "-bottom-1.5 border-b border-r" : "-top-1.5 border-t border-l"} left-1/2 -translate-x-1/2 w-3 h-3 bg-white border-slate-200 rotate-45`} />
          {loading ? (
            <div className="flex justify-center py-2">
              <Loader2 className="w-4 h-4 animate-spin text-[#FF5A1F]" />
            </div>
          ) : candidates && candidates.length > 0 ? (
            <div className="flex flex-col gap-1.5 max-h-[200px] overflow-y-auto scrollbar-thin scrollbar-thumb-slate-200 pr-1">
              {candidates.map((p) => {
                const cand = candidatesMap[p.candidate_id];
                const candName = cand ? `${cand.first_name} ${cand.last_name}` : `Candidate ${p.candidate_id.substring(0, 4)}`;
                return (
                  <Link key={p.id} href={`/candidates/${p.candidate_id}`} prefetch={true} className="flex flex-col gap-0.5 py-1.5 border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors px-1 -mx-1 rounded group">
                    <div className="text-[13px] font-medium truncate flex items-center gap-1.5 text-slate-700 group-hover:text-orange-600 transition-colors">
                      <div className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />
                      <span className="truncate">{candName}</span>
                    </div>
                    {p.job_title && (
                      <div className="text-[11px] text-slate-400 font-medium truncate pl-3">
                        {p.job_title}
                      </div>
                    )}
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="text-[12px] text-slate-400 font-medium text-center py-1">
              No candidates found
            </div>
          )}
        </div>
      )}
    </div>
  );
}

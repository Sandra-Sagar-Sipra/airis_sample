"use client";

import { AlertOctagon, TrendingDown, Sparkles } from "lucide-react";
import type { DropOffEntry } from "@/lib/api/types";

function rateColor(rate: number): string {
  if (rate >= 50) return "text-red-500";
  if (rate >= 30) return "text-orange-500";
  if (rate >= 15) return "text-amber-500";
  return "text-slate-500";
}

function rateBarColor(rate: number): string {
  if (rate >= 50) return "from-red-500 to-red-400 shadow-red-500/20";
  if (rate >= 30) return "from-orange-500 to-orange-400 shadow-orange-500/20";
  if (rate >= 15) return "from-amber-500 to-amber-400 shadow-amber-500/20";
  return "from-slate-400 to-slate-350 shadow-slate-400/20";
}

interface DropoffInsightsPanelProps {
  dropOff: DropOffEntry[];
}

export function DropoffInsightsPanel({ dropOff }: DropoffInsightsPanelProps) {
  if (dropOff.length === 0) {
    return (
      <p className="py-12 text-center text-sm font-semibold text-slate-400 italic">
        No rejections recorded in the selected period.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {dropOff.map((entry) => (
        <div
          key={entry.stage}
          className={`relative rounded-[16px] border p-4.5 transition-all duration-300 group ${
            entry.is_bottleneck
              ? "border-red-200/60 bg-gradient-to-r from-red-50/20 to-transparent shadow-[0_2px_12px_rgba(239,68,68,0.01)] hover:shadow-[0_4px_20px_rgba(239,68,68,0.03)]"
              : "border-slate-100 bg-white hover:border-slate-200/80 hover:shadow-[0_4px_16px_rgba(0,0,0,0.02)]"
          }`}
        >
          {/* Bottleneck badge */}
          {entry.is_bottleneck && (
            <div className="absolute -top-2.5 left-4 flex items-center gap-1 rounded-full bg-[#FF5A1F] px-2.5 py-0.5 text-[9px] font-bold text-white uppercase tracking-wider shadow-sm shadow-orange-500/20 animate-pulse">
              <AlertOctagon className="h-2.5 w-2.5" />
              Critical Bottleneck
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2.5">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-slate-100 text-[10px] font-black text-slate-400 uppercase">
                #{entry.rank}
              </span>
              <span className="text-[14px] font-bold text-slate-800 transition-colors duration-300 group-hover:text-[#FF5A1F]">
                {entry.label}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap text-slate-500 text-[12px] font-semibold">
              <TrendingDown className={`h-3.5 w-3.5 ${rateColor(entry.drop_off_rate)}`} />
              <span className={`text-[15px] font-black ${rateColor(entry.drop_off_rate)}`}>
                {entry.drop_off_rate.toFixed(1)}%
              </span>
              <span className="text-slate-400 font-medium">
                drop-off ({entry.rejected_count.toLocaleString()} rejected)
              </span>
            </div>
          </div>

          {/* Premium Drop-off rate bar */}
          <div className="h-2.5 w-full bg-slate-50 border border-slate-100/50 rounded-full overflow-hidden relative shadow-inner">
            <div
              className={`h-full bg-gradient-to-r ${rateBarColor(entry.drop_off_rate)} rounded-full transition-all duration-500`}
              style={{ width: `${Math.min(entry.drop_off_rate, 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

"use client";

import { AlertTriangle, Clock } from "lucide-react";
import type { StageDurationEntry } from "@/lib/api/types";

interface StageDurationChartProps {
  durations: StageDurationEntry[];
}

export function StageDurationChart({ durations }: StageDurationChartProps) {
  if (durations.length === 0) {
    return (
      <p className="py-12 text-center text-sm font-semibold text-slate-400 italic">
        No completed stage transitions yet.
      </p>
    );
  }

  const maxDays = Math.max(...durations.map((d) => d.avg_days), 1);

  return (
    <div className="space-y-5">
      {durations.map((entry) => {
        const barPct = (entry.avg_days / maxDays) * 100;
        const barColor = entry.is_slow
          ? "from-amber-400 to-orange-400 shadow-amber-500/20"
          : "from-sky-400 to-blue-500 shadow-sky-500/20";
        const textColor = entry.is_slow ? "text-amber-500" : "text-sky-500";
        const textBg = entry.is_slow ? "bg-amber-50 border border-amber-100" : "bg-sky-50 border border-sky-100";

        return (
          <div key={entry.stage} className="group cursor-default">
            {/* Label row */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 mb-2 px-1">
              <div className="flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-[14px] font-bold text-slate-800 transition-colors duration-300 group-hover:text-[#FF5A1F]">
                  {entry.label}
                </span>
                {entry.is_slow && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200/50 px-2 py-0.5 text-[9px] font-bold text-amber-500 uppercase tracking-wider">
                    <AlertTriangle className="h-2.5 w-2.5 animate-bounce" />
                    Slow Stage
                  </span>
                )}
              </div>
              <div className="text-right text-[12px] font-semibold text-slate-500 flex items-center gap-2.5 flex-wrap">
                <span className={`px-2 py-0.5 rounded-md font-bold ${textColor} ${textBg}`}>
                  {entry.avg_days.toFixed(1)}d avg
                </span>
                {entry.median_days !== null && (
                  <span className="bg-slate-100 px-2 py-0.5 rounded-md text-slate-500 font-bold">
                    {entry.median_days.toFixed(1)}d median
                  </span>
                )}
                <span className="text-slate-400 font-medium text-[11px]">
                  ({entry.sample_count.toLocaleString()} samples)
                </span>
              </div>
            </div>

            {/* Horizontal bar */}
            <div className="h-6 w-full bg-slate-50 border border-slate-100/50 rounded-xl overflow-hidden shadow-inner flex group-hover:scale-[1.005] group-hover:shadow-[0_4px_16px_rgba(0,0,0,0.02)] transition-all duration-300">
              <div
                className={`h-full bg-gradient-to-r ${barColor} rounded-xl transition-all duration-500`}
                style={{ width: `${barPct}%` }}
              />
            </div>
          </div>
        );
      })}

      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 pt-3 border-t border-slate-100 mt-5">
        * Based on completed stage transitions only. Active (in-progress) stages are not included.
      </p>
    </div>
  );
}

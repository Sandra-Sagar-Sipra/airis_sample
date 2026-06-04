"use client";

import { ChevronRight } from "lucide-react";
import type { StageFunnelEntry } from "@/lib/api/types";

interface ConversionFunnelChartProps {
  funnel: StageFunnelEntry[];
}

const STAGES = [
  { key: "applied",    label: "Applied",    color: "#FF5A1F" },
  { key: "ai_interview", label: "AI Interview Screening", color: "#FF5A1F" },
  { key: "interview",  label: "Interview",  color: "#FF5A1F" },
  { key: "offer",      label: "Offer",      color: "#FF5A1F" },
  { key: "placed",     label: "Placed",     color: "#10B981" },
];

export function ConversionFunnelChart({ funnel }: ConversionFunnelChartProps) {
  if (funnel.length === 0) {
    return (
      <p className="py-10 text-center text-[13px] text-slate-400">
        No pipeline data available for the selected filters.
      </p>
    );
  }

  const stageData = STAGES.map((s) => {
    const entered = funnel.find((f) => f.stage === s.key)?.entered ?? 0;
    return { ...s, entered };
  });

  const base = stageData[0].entered || 1;

  return (
    <div className="flex flex-col md:flex-row items-stretch gap-0 w-full">
      {stageData.map((step, i) => {
        const pct = ((step.entered / base) * 100);
        const isLast = i === stageData.length - 1;

        return (
          <div key={step.key} className="flex items-center flex-1">
            <div className="flex-1 flex flex-col items-center px-2 py-3 rounded-lg hover:bg-slate-50 transition-colors cursor-default group">
              {/* Count */}
              <span className="text-xl font-bold text-slate-900 leading-none">{step.entered.toLocaleString()}</span>
              {/* Percentage badge */}
              <div className="h-[16px] mt-0.5 flex items-center justify-center">
                {base > 1 && (
                  <span className="text-[11px] text-slate-400">
                    {pct > 0 ? `${pct.toFixed(0)}%` : "0%"}
                  </span>
                )}
              </div>
              {/* Label */}
              <span className="text-[12px] font-medium text-slate-600 mt-2">{step.label}</span>
              {/* Progress bar */}
              <div className="w-full mt-3 h-1 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${Math.max(0, Math.min(100, (step.entered / Math.max(base, 100)) * 100))}%`, backgroundColor: step.color }}
                />
              </div>
            </div>

            {!isLast && (
              <div className="hidden md:flex flex-shrink-0 mx-1">
                <ChevronRight className="w-4 h-4 text-slate-200" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

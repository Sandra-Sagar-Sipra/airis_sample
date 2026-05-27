"use client";

import { useEffect, useState } from "react";
import { getPipelineAnalyticsOverview } from "@/lib/api/analytics";
import type { PipelineOverviewResponse } from "@/lib/api/types";
import { Loader2, Users, BarChart2, Share2 } from "lucide-react";

export function PipelineMetrics({ view, onNavigate, data: propData }: { view?: 'kpi' | 'details'; onNavigate?: () => void; data?: PipelineOverviewResponse } = {}) {
  const [data, setData] = useState<PipelineOverviewResponse | null>(propData || null);
  const [loading, setLoading] = useState(!propData);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (propData) {
      setData(propData);
      setLoading(false);
      return;
    }
    let mounted = true;
    getPipelineAnalyticsOverview()
      .then((res) => {
        if (mounted) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err);
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (loading) {
    if (view === 'kpi') {
      return (
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5 flex h-32 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
        </div>
      );
    }
    return (
      <div className="contents">
        <div className="col-span-1 md:col-span-4 flex h-32 items-center justify-center rounded-xl bg-white shadow-sm border border-slate-100 order-last">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    if (view === 'kpi') {
      return (
        <div className="bg-red-50 border border-red-200 rounded-xl p-5 text-xs text-red-600">
          Failed to load KPI.
        </div>
      );
    }
    return (
      <div className="contents">
        <div className="col-span-1 md:col-span-4 rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-600 shadow-sm order-last">
          Failed to load Pipeline Metrics. Please try again.
        </div>
      </div>
    );
  }

  if (view === 'kpi') {
    return (
      <div className="col-span-1 bg-white rounded-xl shadow-sm border border-slate-100 p-5 flex flex-col justify-between group cursor-pointer transition-all duration-300 hover:shadow-md" onClick={onNavigate}>
        <div>
          <p className="text-[13px] font-semibold text-slate-600 mb-2 transition-colors duration-300 group-hover:text-[#FF5A1F]">Candidates in Pipeline</p>
          <p className="text-[32px] leading-none font-bold text-slate-900 transition-colors duration-300 group-hover:text-[#FF5A1F]">{data.total_candidates}</p>
        </div>
        <div className="flex items-center justify-between mt-4">
          <p className="text-[12px] font-bold text-emerald-500">↑ 24% <span className="text-slate-400 font-normal">vs last 7d</span></p>
          <span className="text-[12px] font-bold text-[#FF5A1F] group-hover:translate-x-1 transition-transform">View →</span>
        </div>
      </div>
    );
  }

  const sourceColors = ['#f97316', '#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b'];
  const sourceData = data.by_source.map((s, i) => ({ ...s, color: sourceColors[i % sourceColors.length] }));
  const totalSource = sourceData.reduce((sum, s) => sum + s.count, 0);

  return (
    <div className="contents">
      {/* Row 1 Col 2: KPI */}
      <div className="col-span-1 bg-white rounded-xl shadow-sm border border-slate-100 p-5 flex flex-col justify-between order-2">
        <div className="flex items-start justify-between group cursor-pointer">
          <div>
            <p className="text-[13px] font-semibold text-slate-600 mb-2 transition-colors duration-300 group-hover:text-[#FF5A1F]">Candidates in Pipeline</p>
            <p className="text-[32px] leading-none font-bold text-slate-900 transition-colors duration-300 group-hover:text-[#FF5A1F]">{data.total_candidates}</p>
          </div>

        </div>
        <p className="text-[12px] font-bold text-emerald-500 mt-4">↑ 24% <span className="text-slate-400 font-normal">vs last 7d</span></p>
      </div>

      {/* Row 2 Col 1-2: Candidates by Stage */}
      <div className="col-span-1 md:col-span-2 bg-white rounded-xl shadow-sm border border-slate-100 p-6 order-5">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-[16px] font-bold text-slate-900 tracking-tight">Candidates by stage</h3>
        </div>
        <div className="space-y-4">
          {data.by_stage.map((item, i) => {
            const orangeShades = [
              "bg-[#e04814]", // Deep/High Orange
              "bg-[#FF5A1F]", // Medium-High / Brand Orange
              "bg-[#ff7e4f]", // Medium Orange
              "bg-[#ffa27f]", // Light Orange
              "bg-[#ffc6af]", // Very Light Orange
            ];
            const color = orangeShades[i % orangeShades.length];
            const pct = data.total_candidates > 0 ? (item.count / data.total_candidates) * 100 : 0;
            return (
              <div key={item.stage} className="flex items-center gap-3 group cursor-pointer">
                <span className="w-24 text-sm font-medium text-slate-600 capitalize truncate transition-colors duration-300 group-hover:text-[#FF5A1F]">{item.stage.replace('_', ' ')}</span>
                <div className="flex-1 h-[18px] bg-slate-50 rounded-sm overflow-hidden">
                   <div className={`h-full ${color} rounded-sm transition-all`} style={{ width: `${pct}%` }} />
                </div>
                <span className="w-8 text-right text-sm font-bold text-slate-900">{item.count}</span>
              </div>
            );
          })}
          {data.by_stage.length === 0 && <div className="text-sm font-medium text-slate-500">No candidates by stage.</div>}
        </div>
      </div>

      {/* Row 2 Col 3-4: Candidates by Source */}
      <div className="col-span-1 md:col-span-2 bg-white rounded-xl shadow-sm border border-slate-100 p-6 order-6 flex gap-8 items-center">
        <div className="flex-1">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-[16px] font-bold text-slate-900 tracking-tight">Candidates by source</h3>
          </div>
          <div className="flex items-center gap-8">
            <div className="relative w-32 h-32 flex-shrink-0 group cursor-pointer">
              <div className="w-full h-full transition-all duration-1000 ease-in-out group-hover:rotate-[180deg] group-hover:scale-110 drop-shadow-sm group-hover:drop-shadow-md">
                {totalSource > 0 ? (
                  <svg viewBox="0 0 100 100" className="w-full h-full transform -rotate-90">
                    {(() => {
                      let cum = 0;
                      return sourceData.map((d, i) => {
                        const pct = d.count / totalSource;
                        const dashArray = `${pct * 251.2} 251.2`;
                        const offset = -(cum / totalSource) * 251.2;
                        cum += d.count;
                        return (
                          <circle key={i} cx="50" cy="50" r="40" fill="transparent" stroke={d.color} strokeWidth="16" strokeDasharray={dashArray} strokeDashoffset={offset} className="transition-all duration-1000 ease-in-out hover:opacity-80" />
                        );
                      });
                    })()}
                  </svg>
                ) : (
                  <div className="w-full h-full rounded-full border-8 border-slate-100" />
                )}
              </div>
              <div className="absolute inset-0 flex items-center justify-center flex-col transition-transform duration-1000 ease-in-out group-hover:scale-110">
                 <span className="text-2xl font-medium text-slate-900">{totalSource}</span>
              </div>
            </div>
            <div className="space-y-3 flex-1">
              {sourceData.map((s, i) => (
                <div key={i} className="flex items-center justify-between group/item cursor-default">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full transition-transform duration-300 group-hover/item:scale-150" style={{ backgroundColor: s.color }} />
                    <span className="text-sm font-medium text-slate-600 capitalize transition-colors duration-300 group-hover/item:text-[#FF5A1F]">{s.source.replace('_', ' ')}</span>
                  </div>
                  <span className="text-sm font-bold text-slate-900 transition-transform duration-300 group-hover/item:scale-110 group-hover/item:text-[#e04814]">{s.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

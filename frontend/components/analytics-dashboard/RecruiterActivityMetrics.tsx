"use client";

import { useEffect, useState } from "react";
import { getRecruiterActivity } from "@/lib/api/analytics";
import type { RecruiterActivityResponse } from "@/lib/api/types";
import { Loader2, Send, Activity } from "lucide-react";

export function RecruiterActivityMetrics({ view, onNavigate, data: propData }: { view?: 'kpi' | 'details' | 'tab-panel' | 'overview-panel'; onNavigate?: () => void; data?: RecruiterActivityResponse } = {}) {
  const [data, setData] = useState<RecruiterActivityResponse | null>(propData || null);
  const [loading, setLoading] = useState(!propData);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (propData) {
      setData(propData);
      setLoading(false);
      return;
    }
    let mounted = true;
    getRecruiterActivity()
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
    if (view === 'tab-panel' || view === 'overview-panel') {
      return (
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-8 flex h-[400px] items-center justify-center w-full">
          <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
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
    if (view === 'tab-panel' || view === 'overview-panel') {
      return (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-600 shadow-sm w-full h-[400px]">
          Failed to load Recruiter Activity Metrics. Please try again.
        </div>
      );
    }
    return (
      <div className="contents">
        <div className="col-span-1 md:col-span-4 rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-600 shadow-sm order-last">
          Failed to load Recruiter Activity Metrics. Please try again.
        </div>
      </div>
    );
  }

  const maxSubmissions = Math.max(...data.by_recruiter.map(r => r.submissions), 1);

  if (view === 'tab-panel') {
    const topRecruiterItem = data.by_recruiter.length > 0 
      ? [...data.by_recruiter].sort((a, b) => b.placements - a.placements)[0] 
      : null;
    const topRecruiterName = topRecruiterItem && topRecruiterItem.placements > 0 
      ? topRecruiterItem.recruiter_name 
      : "—";
    const conversionRate = data.total_submissions > 0 
      ? ((data.total_placements / data.total_submissions) * 100).toFixed(1) 
      : "0.0";

    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6 flex flex-col h-full w-full">
        <div className="flex items-start gap-3 mb-6">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-50 border border-orange-100/50">
            <Activity className="h-5 w-5 text-[#FF5A1F]" />
          </div>
          <div>
            <h3 className="text-[16px] font-bold text-slate-900 tracking-tight">Recruiter Intelligence</h3>
            <p className="text-[12px] text-slate-500 mt-0.5">Track recruiter productivity, interview flow, and placement performance.</p>
          </div>
        </div>
        
        <div className="grid grid-cols-3 gap-3 mb-6">
          <div className="bg-slate-50 rounded-lg p-3 group cursor-pointer transition-colors hover:bg-slate-100/80 border border-slate-100">
            <p className="text-[13px] font-semibold text-slate-600 mb-1 transition-colors duration-300 group-hover:text-[#FF5A1F]">Submissions</p>
            <p className="text-[28px] leading-none font-bold text-slate-900 transition-colors duration-300 group-hover:text-[#FF5A1F]">{data.total_submissions}</p>
          </div>
          <div className="bg-slate-50 rounded-lg p-3 group cursor-pointer transition-colors hover:bg-slate-100/80 border border-slate-100">
            <p className="text-[13px] font-semibold text-slate-600 mb-1 transition-colors duration-300 group-hover:text-[#FF5A1F]">Interviews</p>
            <p className="text-[28px] leading-none font-bold text-slate-900 transition-colors duration-300 group-hover:text-[#FF5A1F]">{data.total_interviews}</p>
          </div>
          <div className="bg-emerald-50/50 border border-emerald-100 rounded-lg p-3 flex justify-between items-start group cursor-pointer transition-colors hover:bg-emerald-50/80">
            <div>
              <p className="text-[13px] font-semibold text-emerald-700 mb-1">Placements</p>
              <p className="text-[28px] leading-none font-bold text-emerald-600">{data.total_placements}</p>
            </div>
          </div>
        </div>

        <div className="w-full overflow-x-auto flex-1">
          <div className="min-w-[400px]">
            <div className="grid grid-cols-12 px-2 py-2 border-b border-slate-100 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              <div className="col-span-1">#</div>
              <div className="col-span-5">Recruiter</div>
              <div className="col-span-2 text-right">Sub</div>
              <div className="col-span-2 text-right">Int</div>
              <div className="col-span-2 text-right">Plcd</div>
            </div>
            <div className="divide-y divide-slate-50 mt-1">
              {data.by_recruiter.length === 0 ? (
                <div className="text-sm font-medium text-slate-500 p-4 text-center">No recruiter activity found.</div>
              ) : (
                data.by_recruiter.map((rec, i) => (
                  <div key={i} className="px-2 py-3 hover:bg-slate-50/50 transition-colors">
                    <div className="grid grid-cols-12 items-center">
                      <div className="col-span-1 flex justify-start">
                        <span className="flex items-center justify-center w-6 h-6 bg-orange-50 text-[#FF5A1F] text-xs font-bold rounded-full">
                          {i + 1}
                        </span>
                      </div>
                      <div className="col-span-5 flex flex-col pr-2 group cursor-pointer">
                        <span className="text-sm font-semibold text-slate-800 truncate transition-colors duration-300 group-hover:text-[#FF5A1F]">{rec.recruiter_name}</span>
                        <div className="w-24 h-1 bg-slate-100 rounded-full mt-1.5 overflow-hidden">
                           <div className="h-full bg-[#FF5A1F] rounded-full transition-all" style={{ width: `${maxSubmissions > 0 ? (rec.submissions / maxSubmissions) * 100 : 0}%` }} />
                        </div>
                      </div>
                      <div className="col-span-2 text-right text-sm text-slate-600 font-medium">
                        {rec.submissions}
                      </div>
                      <div className="col-span-2 text-right text-sm text-slate-600 font-medium">
                        {rec.interviews}
                      </div>
                      <div className="col-span-2 text-right text-sm text-slate-600 font-medium">
                        {rec.placements}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Placement summary section below recruiter table */}
        <div className="mt-6 pt-6 border-t border-slate-100 shrink-0">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-3">Placement Intelligence</p>
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-slate-50/50 rounded-xl p-3.5 border border-slate-100/60 shadow-sm flex flex-col justify-center">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Total Placements</p>
              <p className="text-xl font-bold text-slate-800">{data.total_placements}</p>
            </div>
            <div className="bg-slate-50/50 rounded-xl p-3.5 border border-slate-100/60 shadow-sm flex flex-col justify-center truncate">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Top Recruiter</p>
              <p className="text-[13px] font-bold text-slate-800 truncate" title={topRecruiterName}>
                {topRecruiterName !== "—" ? topRecruiterName.split('@')[0] : "—"}
              </p>
            </div>
            <div className="bg-slate-50/50 rounded-xl p-3.5 border border-slate-100/60 shadow-sm flex flex-col justify-center">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Placement Rate</p>
              <p className="text-xl font-bold text-[#FF5A1F]">{conversionRate}%</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'kpi') {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5 flex flex-col justify-between cursor-pointer transition-all duration-300 hover:shadow-md" onClick={onNavigate}>
        <div>
          <p className="text-[13px] font-semibold text-slate-600 mb-2 transition-colors duration-300 group-hover:text-[#FF5A1F]">Submissions</p>
          <p className="text-[32px] leading-none font-bold text-slate-900 transition-colors duration-300 group-hover:text-[#FF5A1F]">{data.total_submissions}</p>
        </div>
        <p className="text-[12px] font-medium text-slate-400 mt-4">— no change <span className="font-normal">vs last 7d</span></p>
      </div>
    );
  }

  if (view === 'overview-panel') {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6 flex flex-col h-full w-full">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-[16px] font-bold text-slate-900 tracking-tight">Recruiter activity</h3>
        </div>
        
        <div className="grid grid-cols-3 gap-3 mb-6">
          <div className="bg-slate-50 rounded-lg p-3 group cursor-pointer transition-colors hover:bg-slate-100/80">
            <p className="text-[13px] font-semibold text-slate-600 mb-1 transition-colors duration-300 group-hover:text-[#FF5A1F]">Submissions</p>
            <p className="text-[28px] leading-none font-bold text-slate-900 transition-colors duration-300 group-hover:text-[#FF5A1F]">{data.total_submissions}</p>
          </div>
          <div className="bg-slate-50 rounded-lg p-3 group cursor-pointer transition-colors hover:bg-slate-100/80">
            <p className="text-[13px] font-semibold text-slate-600 mb-1 transition-colors duration-300 group-hover:text-[#FF5A1F]">Interviews</p>
            <p className="text-[28px] leading-none font-bold text-slate-900 transition-colors duration-300 group-hover:text-[#FF5A1F]">{data.total_interviews}</p>
          </div>
          <div className="bg-slate-50 rounded-lg p-3 group cursor-pointer transition-colors hover:bg-slate-100/80">
            <p className="text-[13px] font-semibold text-slate-600 mb-1 transition-colors duration-300 group-hover:text-[#FF5A1F]">Placements</p>
            <p className="text-[28px] leading-none font-bold text-slate-900 transition-colors duration-300 group-hover:text-[#FF5A1F]">{data.total_placements}</p>
          </div>
        </div>

        <div className="w-full overflow-y-auto max-h-[220px] scrollbar-thin">
          <div className="min-w-[400px]">
            <div className="grid grid-cols-12 px-2 py-2 border-b border-slate-100 text-[11px] font-bold uppercase tracking-wider text-slate-400 sticky top-0 bg-white z-10">
              <div className="col-span-1">#</div>
              <div className="col-span-5">Recruiter</div>
              <div className="col-span-2 text-right">Sub</div>
              <div className="col-span-2 text-right">Int</div>
              <div className="col-span-2 text-right">Plcd</div>
            </div>
            <div className="divide-y divide-slate-50 mt-1">
              {data.by_recruiter.length === 0 ? (
                <div className="text-sm font-medium text-slate-500 p-4 text-center">No recruiter activity found.</div>
              ) : (
                data.by_recruiter.map((rec, i) => (
                  <div key={i} className="px-2 py-3 hover:bg-slate-50/50 transition-colors">
                    <div className="grid grid-cols-12 items-center">
                      <div className="col-span-1 flex justify-start">
                        <span className="flex items-center justify-center w-6 h-6 bg-orange-50 text-[#FF5A1F] text-xs font-bold rounded-full">
                          {i + 1}
                        </span>
                      </div>
                      <div className="col-span-5 flex flex-col pr-2 group cursor-pointer">
                        <span className="text-sm font-semibold text-slate-800 truncate transition-colors duration-300 group-hover:text-[#FF5A1F]">{rec.recruiter_name}</span>
                        <div className="w-24 h-1 bg-slate-100 rounded-full mt-1.5 overflow-hidden">
                           <div className="h-full bg-[#FF5A1F] rounded-full transition-all" style={{ width: `${maxSubmissions > 0 ? (rec.submissions / maxSubmissions) * 100 : 0}%` }} />
                        </div>
                      </div>
                      <div className="col-span-2 text-right text-sm text-slate-600 font-medium">
                        {rec.submissions}
                      </div>
                      <div className="col-span-2 text-right text-sm text-slate-600 font-medium">
                        {rec.interviews}
                      </div>
                      <div className="col-span-2 text-right text-sm text-slate-600 font-medium">
                        {rec.placements}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

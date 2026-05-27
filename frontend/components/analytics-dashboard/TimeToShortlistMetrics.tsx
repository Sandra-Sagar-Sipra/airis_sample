"use client";

import { useEffect, useState } from "react";
import { getTimeToShortlist } from "@/lib/api/analytics";
import type { TimeToShortlistResponse } from "@/lib/api/types";
import { Loader2, Clock } from "lucide-react";

export function TimeToShortlistMetrics({ view, data: propData }: { view?: 'kpi' | 'details' | 'tab-panel'; data?: TimeToShortlistResponse } = {}) {
  const [data, setData] = useState<TimeToShortlistResponse | null>(propData || null);
  const [loading, setLoading] = useState(!propData);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (propData) {
      setData(propData);
      setLoading(false);
      return;
    }
    let mounted = true;
    getTimeToShortlist()
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
    if (view === 'tab-panel') {
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
    if (view === 'tab-panel') {
      return (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-600 shadow-sm w-full">
          Failed to load Time to Shortlist Metrics. Please try again.
        </div>
      );
    }
    return (
      <div className="contents">
        <div className="col-span-1 md:col-span-4 rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-600 shadow-sm order-last">
          Failed to load Time to Shortlist Metrics. Please try again.
        </div>
      </div>
    );
  }

  if (view === 'tab-panel') {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6 flex flex-col h-full w-full justify-between">
        <div className="w-full">
          <div className="flex items-start gap-3 mb-6">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-50 border border-orange-100/50">
              <Clock className="h-5 w-5 text-[#FF5A1F]" />
            </div>
            <div>
              <h3 className="text-[16px] font-bold text-slate-900 tracking-tight">Shortlist & Efficiency</h3>
              <p className="text-[12px] text-slate-500 mt-0.5">Monitor shortlist speed and recruiter efficiency.</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 flex-shrink-0">
            <div className="bg-slate-50 border-l-2 border-l-[#FF5A1F] rounded-r-xl p-3.5 shadow-sm border border-slate-100/60 border-l-0 group cursor-pointer transition-all hover:bg-slate-100/30">
              <p className="text-[12px] font-semibold text-slate-500 mb-1.5 transition-colors duration-300 group-hover:text-[#FF5A1F]">Average</p>
              <p className="text-2xl font-bold text-[#FF5A1F] flex items-end gap-0.5 transition-colors duration-300 group-hover:text-[#e04814]">
                {data.average_days.toFixed(1)} <span className="text-[11px] text-slate-400 font-medium mb-0.5 transition-colors duration-300 group-hover:text-[#FF5A1F]">days</span>
              </p>
            </div>
            <div className="bg-slate-50 border-l-2 border-l-emerald-500 rounded-r-xl p-3.5 shadow-sm border border-slate-100/60 border-l-0 group cursor-pointer transition-all hover:bg-slate-100/30">
              <p className="text-[12px] font-semibold text-slate-500 mb-1.5 transition-colors duration-300 group-hover:text-[#FF5A1F]">Fastest</p>
              <p className="text-2xl font-bold text-emerald-500 flex items-end gap-0.5 transition-colors duration-300 group-hover:text-[#e04814]">
                {data.fastest_days.toFixed(1)} <span className="text-[11px] text-slate-400 font-medium mb-0.5 transition-colors duration-300 group-hover:text-[#FF5A1F]">days</span>
              </p>
            </div>
            <div className="bg-slate-50 border-l-2 border-l-amber-500 rounded-r-xl p-3.5 shadow-sm border border-slate-100/60 border-l-0 group cursor-pointer transition-all hover:bg-slate-100/30">
              <p className="text-[12px] font-semibold text-slate-500 mb-1.5 transition-colors duration-300 group-hover:text-[#FF5A1F]">Slowest</p>
              <p className="text-2xl font-bold text-amber-500 flex items-end gap-0.5 transition-colors duration-300 group-hover:text-[#e04814]">
                {data.slowest_days.toFixed(1)} <span className="text-[11px] text-slate-400 font-medium mb-0.5 transition-colors duration-300 group-hover:text-[#FF5A1F]">days</span>
              </p>
            </div>
          </div>
        </div>

        {/* Small SVG Bar Distribution */}
        <div className="mt-8 w-full">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-4">Distribution</p>
          <div className="flex items-end h-20 gap-2.5 w-full px-2">
            {[4, 12, 28, 16, 8, 4].map((h, i) => (
              <div key={i} className="flex-1 bg-[#FF5A1F]/20 hover:bg-[#FF5A1F] cursor-pointer transition-all duration-300 rounded-t-md" style={{ height: `${h * 2.2}px` }} />
            ))}
          </div>
          <div className="flex items-center justify-between text-[11px] text-slate-400 font-bold w-full mt-3 px-2">
            <span>&lt;1d</span>
            <span>2-3d</span>
            <span>4-5d</span>
            <span>&gt;6d</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="contents">
      {/* Row 3 Col 3-4 */}
      <div className="col-span-1 md:col-span-2 bg-white rounded-xl shadow-sm border border-slate-100 p-6 order-8">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-[16px] font-bold text-slate-900 tracking-tight">Time to shortlist</h3>

        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="bg-slate-50 border-l-2 border-l-[#FF5A1F] rounded-r-lg p-4 shadow-sm border border-slate-100 border-l-0 group cursor-pointer">
            <p className="text-[13px] font-semibold text-slate-600 mb-2 transition-colors duration-300 group-hover:text-[#FF5A1F]">Average</p>
            <p className="text-3xl font-medium text-[#FF5A1F] flex items-end gap-1 transition-colors duration-300 group-hover:text-[#e04814]">
              {data.average_days.toFixed(1)} <span className="text-sm text-slate-500 font-normal mb-1 transition-colors duration-300 group-hover:text-[#FF5A1F]">days</span>
            </p>
          </div>
          <div className="bg-slate-50 border-l-2 border-l-emerald-500 rounded-r-lg p-4 shadow-sm border border-slate-100 border-l-0 group cursor-pointer">
            <p className="text-[13px] font-semibold text-slate-600 mb-2 transition-colors duration-300 group-hover:text-[#FF5A1F]">Fastest</p>
            <p className="text-[32px] leading-none font-bold text-emerald-500 flex items-end gap-1 transition-colors duration-300 group-hover:text-[#e04814]">
              {data.fastest_days.toFixed(1)} <span className="text-sm text-slate-500 font-normal mb-1 transition-colors duration-300 group-hover:text-[#FF5A1F]">days</span>
            </p>
          </div>
          <div className="bg-slate-50 border-l-2 border-l-amber-500 rounded-r-lg p-4 shadow-sm border border-slate-100 border-l-0 group cursor-pointer">
            <p className="text-[13px] font-semibold text-slate-600 mb-2 transition-colors duration-300 group-hover:text-[#FF5A1F]">Slowest</p>
            <p className="text-[32px] leading-none font-bold text-amber-500 flex items-end gap-1 transition-colors duration-300 group-hover:text-[#e04814]">
              {data.slowest_days.toFixed(1)} <span className="text-sm text-slate-500 font-normal mb-1 transition-colors duration-300 group-hover:text-[#FF5A1F]">days</span>
            </p>
          </div>
        </div>

        {/* Small SVG Bar Distribution */}
        <div className="mt-8">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-4">Distribution</p>
          <div className="flex items-end h-16 gap-2 w-full px-2">
            {[4, 12, 28, 16, 8, 4].map((h, i) => (
              <div key={i} className="flex-1 bg-[#FF5A1F]/20 hover:bg-[#FF5A1F] cursor-pointer transition-colors rounded-t-sm" style={{ height: `${h * 2}px` }} />
            ))}
          </div>
          <div className="flex items-center justify-between text-[11px] text-slate-400 font-bold w-full mt-3 px-2">
            <span>&lt;1d</span>
            <span>2-3d</span>
            <span>4-5d</span>
            <span>&gt;6d</span>
          </div>
        </div>
      </div>
    </div>
  );
}

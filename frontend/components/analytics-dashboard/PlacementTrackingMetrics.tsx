"use client";

import { useEffect, useState } from "react";
import { getPlacementTracking } from "@/lib/api/analytics";
import type { PlacementTrackingResponse } from "@/lib/api/types";
import { Loader2, Trophy, Building2, Award } from "lucide-react";

export function PlacementTrackingMetrics({ view, onNavigate, data: propData }: { view?: 'kpi' | 'details'; onNavigate?: () => void; data?: PlacementTrackingResponse } = {}) {
  const [data, setData] = useState<PlacementTrackingResponse | null>(propData || null);
  const [loading, setLoading] = useState(!propData);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (propData) {
      setData(propData);
      setLoading(false);
      return;
    }
    let mounted = true;
    getPlacementTracking()
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
          Failed to load Placement Tracking Metrics. Please try again.
        </div>
      </div>
    );
  }

  if (view === 'kpi') {
    return (
      <div className="col-span-1 bg-white rounded-xl shadow-sm border border-slate-100 p-5 flex flex-col justify-between group cursor-pointer transition-all duration-300 hover:shadow-md" onClick={onNavigate}>
        <div>
          <p className="text-[13px] font-semibold text-slate-600 mb-2 transition-colors duration-300 group-hover:text-[#FF5A1F]">Total Placements</p>
          <p className="text-[32px] leading-none font-bold text-slate-900 transition-colors duration-300 group-hover:text-[#FF5A1F]">{data.total_placements}</p>
        </div>
        <div className="flex items-center justify-between mt-4">
          <p className="text-[12px] font-medium text-slate-400">— 0% <span className="font-normal">this period</span></p>
          <span className="text-[12px] font-bold text-[#FF5A1F] group-hover:translate-x-1 transition-transform">View →</span>
        </div>
      </div>
    );
  }

  return (
    <div className="contents">
      {/* Row 1 Col 4: KPI Total Placements */}
      <div className="col-span-1 bg-white rounded-xl shadow-sm border border-slate-100 p-5 flex flex-col justify-between order-4">
        <div className="flex items-start justify-between group cursor-pointer">
          <div>
            <p className="text-[13px] font-semibold text-slate-600 mb-2 transition-colors duration-300 group-hover:text-[#FF5A1F]">Total Placements</p>
            <p className="text-[32px] leading-none font-bold text-slate-900 transition-colors duration-300 group-hover:text-[#FF5A1F]">{data.total_placements}</p>
          </div>

        </div>
        <p className="text-[12px] font-medium text-slate-400 font-medium mt-4">— 0% <span className="font-normal">this period</span></p>
      </div>

      {/* Row 4 Col 1-2: Details */}
      <div className="col-span-1 md:col-span-2 bg-white rounded-xl shadow-sm border border-slate-100 p-6 order-9 flex flex-col">
         <div className="flex items-center justify-between mb-6">
           <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Placement Tracking</h3>

         </div>
         
         <div className="mb-6 group cursor-pointer">
           <p className="text-[16px] font-bold text-slate-900 tracking-tight mb-2 transition-colors duration-300 group-hover:text-[#FF5A1F]">Total placements</p>
           <p className="text-[32px] leading-none font-bold text-slate-900 transition-colors duration-300 group-hover:text-[#FF5A1F]">{data.total_placements}</p>
           <p className="text-sm font-medium text-slate-500 mt-2 transition-colors duration-300 group-hover:text-[#FF5A1F]">No placements recorded this period</p>
         </div>

         <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 flex-1">
           <div className="bg-slate-50 rounded-xl p-6 flex flex-col items-center justify-center text-center border border-slate-100 shadow-sm group cursor-pointer">
             <Trophy className="h-8 w-8 text-slate-400 mb-3 transition-colors duration-300 group-hover:text-[#FF5A1F]" />
             <p className="text-[16px] font-bold text-slate-900 tracking-tight mb-1 transition-colors duration-300 group-hover:text-[#FF5A1F]">Top recruiters</p>
             <p className="text-xs font-medium text-slate-500">— no data yet</p>
           </div>
           <div className="bg-slate-50 rounded-xl p-6 flex flex-col items-center justify-center text-center border border-slate-100 shadow-sm group cursor-pointer">
             <Building2 className="h-8 w-8 text-slate-400 mb-3 transition-colors duration-300 group-hover:text-[#FF5A1F]" />
             <p className="text-[16px] font-bold text-slate-900 tracking-tight mb-1 transition-colors duration-300 group-hover:text-[#FF5A1F]">Top clients</p>
             <p className="text-xs font-medium text-slate-500">— no data yet</p>
           </div>
         </div>
      </div>
    </div>
  );
}

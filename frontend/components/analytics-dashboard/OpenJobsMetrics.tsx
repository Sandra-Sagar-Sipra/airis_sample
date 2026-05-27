"use client";

import { useEffect, useState } from "react";
import { getOpenJobsAnalytics } from "@/lib/api/analytics";
import type { OpenJobsResponse } from "@/lib/api/types";
import { Loader2, Briefcase, PieChart, List } from "lucide-react";
import Link from "next/link";

export function OpenJobsMetrics({ view, onNavigate, data: propData }: { view?: 'kpi' | 'details' | 'status-panel' | 'jobs-panel'; onNavigate?: () => void; data?: OpenJobsResponse } = {}) {
  const [data, setData] = useState<OpenJobsResponse | null>(propData || null);
  const [loading, setLoading] = useState(!propData);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (propData) {
      setData(propData);
      setLoading(false);
      return;
    }
    let mounted = true;
    getOpenJobsAnalytics()
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
    if (view === 'status-panel' || view === 'jobs-panel') {
      return (
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-8 flex h-[400px] items-center justify-center w-full">
          <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
        </div>
      );
    }
    return null;
  }

  if (error || !data) {
    if (view === 'kpi') {
      return (
        <div className="bg-red-50 border border-red-200 rounded-xl p-5 text-xs text-red-600">
          Failed to load KPI.
        </div>
      );
    }
    if (view === 'status-panel' || view === 'jobs-panel') {
      return (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-600 shadow-sm w-full h-[400px]">
          Failed to load Open Jobs Metrics. Please try again.
        </div>
      );
    }
    return null;
  }

  if (view === 'kpi') {
    return (
      <div className="col-span-1 bg-white rounded-xl shadow-sm border border-slate-100 p-5 flex flex-col justify-between group cursor-pointer transition-all duration-300 hover:shadow-md" onClick={onNavigate}>
        <div>
          <p className="text-[13px] font-semibold text-slate-600 mb-2 transition-colors duration-300 group-hover:text-[#FF5A1F]">Total Active Jobs</p>
          <p className="text-[32px] leading-none font-bold text-slate-900 transition-colors duration-300 group-hover:text-[#FF5A1F]">{data.total_active}</p>
        </div>
        <div className="flex items-center justify-between mt-4">
          <p className="text-[12px] font-bold text-emerald-500">↑ 12% <span className="text-slate-400 font-normal">vs last 7d</span></p>
          <span className="text-[12px] font-bold text-[#FF5A1F] group-hover:translate-x-1 transition-transform">View →</span>
        </div>
      </div>
    );
  }

  const colors = ['#f97316', '#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444'];
  const statusData = data.by_status.map((s, i) => ({ ...s, color: colors[i % colors.length] }));
  const totalStatus = statusData.reduce((sum, s) => sum + s.count, 0);

  if (view === 'status-panel') {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6 flex flex-col h-full w-full">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-[16px] font-bold text-slate-900 tracking-tight">Jobs by status</h3>
        </div>
        <div className="flex items-center justify-center gap-8 flex-1">
          <div className="relative w-32 h-32 flex-shrink-0 group cursor-pointer">
            <div className="w-full h-full transition-all duration-1000 ease-in-out group-hover:rotate-[180deg] group-hover:scale-110 drop-shadow-sm group-hover:drop-shadow-md">
              {totalStatus > 0 ? (
                <svg viewBox="0 0 100 100" className="w-full h-full transform -rotate-90">
                  {(() => {
                    let cum = 0;
                    return statusData.map((d, i) => {
                      const pct = d.count / totalStatus;
                      const dashArray = `${pct * 251.2} 251.2`;
                      const offset = -(cum / totalStatus) * 251.2;
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
               <span className="text-2xl font-medium text-slate-900">{totalStatus}</span>
            </div>
          </div>
          <div className="space-y-3">
            {statusData.map((s, i) => (
              <div key={i} className="flex items-center justify-between group/item cursor-default w-32">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full transition-transform duration-300 group-hover/item:scale-150" style={{ backgroundColor: s.color }} />
                  <span className="text-sm font-medium text-slate-600 capitalize transition-colors duration-300 group-hover/item:text-[#FF5A1F]">{s.status.replace('_', ' ')}</span>
                </div>
                <span className="text-sm font-bold text-slate-900 transition-transform duration-300 group-hover/item:scale-110 group-hover/item:text-[#e04814]">{s.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (view === 'jobs-panel') {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6 w-full">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-[16px] font-bold text-slate-900 tracking-tight">Recently created jobs</h3>
          <div className="flex items-center gap-4">
            <Link href="/jobs" className="text-[13px] font-bold text-[#FF5A1F] hover:text-[#e04814] transition-colors">View all →</Link>
          </div>
        </div>
        <div className="w-full overflow-x-auto">
          <div className="min-w-[700px]">
            <div className="grid grid-cols-12 px-4 py-3 border-b border-slate-100 text-[11px] font-bold uppercase tracking-wider text-slate-400 sticky top-0 bg-white z-10">
              <div className="col-span-5">Job Title</div>
              <div className="col-span-3">Client</div>
              <div className="col-span-2">Status</div>
              <div className="col-span-2 text-right">Created Date</div>
            </div>
            <div className="divide-y divide-slate-50 max-h-[350px] overflow-y-auto scrollbar-thin">
              {data.recent_jobs.map((job) => (
                <Link href={`/jobs/${job.id}`} prefetch={true} key={job.id} className="grid grid-cols-12 px-4 py-3.5 items-center hover:bg-slate-50 transition-colors group cursor-pointer block">
                  <div className="col-span-5 text-[14px] font-bold text-slate-900 group-hover:text-[#FF5A1F] transition-colors truncate pr-4">{job.title}</div>
                  <div className="col-span-3 text-[12px] font-medium text-slate-500 truncate pr-4 group-hover:text-[#FF5A1F] transition-colors">{job.client_name}</div>
                  <div className="col-span-2">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-[#f0fdf4] text-[#15803d]">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                      <span className="capitalize">{job.status.replace('_', ' ')}</span>
                    </span>
                  </div>
                  <div className="col-span-2 text-right text-[12px] font-semibold text-slate-500">
                    {job.created_at.split('T')[0]}
                  </div>
                </Link>
              ))}
              {data.recent_jobs.length === 0 && (
                <div className="p-8 text-center text-sm font-medium text-slate-500">No recent jobs found.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, Calendar, Briefcase, FilterX, ChevronDown } from "lucide-react";
import { getJobs } from "@/lib/api/jobs";
import { getPipelineAnalytics, downloadAnalyticsCsv, getPipelineAnalyticsOverview, getRecruiterActivity } from "@/lib/api/analytics";
import type { Job, PipelineAnalytics, PipelineOverviewResponse, RecruiterActivityResponse } from "@/lib/api/types";
import { ConversionFunnelChart } from "@/components/analytics/ConversionFunnelChart";
import { useAuthStore } from "@/store/auth-store";
import Link from "next/link";

// ── KPI Card ──────────────────────────────────────────────────────────────────
interface KpiCardProps {
  label: string;
  value: string | number;
}

function KpiCard({ label, value }: KpiCardProps) {
  return (
    <div className="rounded-xl bg-white px-4 py-4 border border-slate-200/70">
      <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide leading-none mb-2 truncate">{label}</p>
      <p className="text-xl font-bold text-slate-900 leading-none">{value}</p>
    </div>
  );
}

// ── Section Title ─────────────────────────────────────────────────────────────
function SectionTitle({ title }: { title: string }) {
  return <h2 className="text-[14px] font-semibold text-slate-800 mb-4">{title}</h2>;
}

// ── Main Component ─────────────────────────────────────────────────────────────
export function PipelineAnalyticsContent({ hideHeader = false }: { hideHeader?: boolean }) {
  const permissions = useAuthStore((s) => s.permissions);
  const canRead = permissions.includes("pipeline:read");

  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>("");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [dateFilterMode, setDateFilterMode] = useState("7D");

  const [analytics, setAnalytics] = useState<PipelineAnalytics | null>(null);
  const [overview, setOverview] = useState<PipelineOverviewResponse | null>(null);
  const [recruiterActivity, setRecruiterActivity] = useState<RecruiterActivityResponse | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const applyDatePreset = useCallback((days: number, label: string) => {
    setDateFilterMode(label);
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - days);
    const fmt = (d: Date) => d.toISOString().split("T")[0];
    setStartDate(fmt(start));
    setEndDate(fmt(end));
  }, []);

  // Apply default preset on mount
  useEffect(() => {
    applyDatePreset(7, "7D");
  }, [applyDatePreset]);

  useEffect(() => {
    if (!canRead) return;
    getJobs(200, 0).then(setJobs).catch(() => {});
  }, [canRead]);

  const fetchAllData = useCallback(async () => {
    if (!canRead || !startDate) return;
    setLoading(true);
    setError(null);
    try {
      const params = {
        jobId: selectedJobId || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      };
      const [analyticsData, overviewData, recruiterData] = await Promise.all([
        getPipelineAnalytics(params),
        getPipelineAnalyticsOverview(),
        getRecruiterActivity(),
      ]);
      setAnalytics(analyticsData);
      setOverview(overviewData);
      setRecruiterActivity(recruiterData);
    } catch (err) {
      setError((err as Error).message ?? "Failed to load analytics.");
    } finally {
      setLoading(false);
    }
  }, [canRead, selectedJobId, startDate, endDate]);

  useEffect(() => {
    void fetchAllData();
  }, [fetchAllData]);

  async function handleExport() {
    setExporting(true);
    try {
      await downloadAnalyticsCsv({
        jobId: selectedJobId || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });
    } catch {
      setError("Export failed.");
    } finally {
      setExporting(false);
    }
  }

  if (!canRead) return null;

  // ── Derived metrics ───────────────────────────────────────────────────────────
  const totalAvgDays = analytics?.stage_durations.reduce((acc, d) => acc + d.avg_days, 0) ?? 0;

  const funnel = analytics?.funnel ?? [];
  const appliedCount = funnel.find((f) => f.stage === "applied")?.entered ?? 0;
  const aiInterviewCount = funnel.find((f) => f.stage === "ai_interview")?.entered ?? 0;
  const interviewCount = funnel.find((f) => f.stage === "interview")?.entered ?? 0;
  const offerCount = funnel.find((f) => f.stage === "offer")?.entered ?? 0;
  const placedCount = funnel.find((f) => f.stage === "placed")?.entered ?? 0;

  const baseCandidates = appliedCount || analytics?.total_pipelines || 0;

  const dropOffs = [
    {
      from: "Applied",
      to: "AI Interview",
      drop: Math.max(0, appliedCount - aiInterviewCount),
      rate: appliedCount > 0 ? ((appliedCount - aiInterviewCount) / appliedCount) * 100 : 0,
    },
    {
      from: "AI Interview",
      to: "Interview",
      drop: Math.max(0, aiInterviewCount - interviewCount),
      rate: aiInterviewCount > 0 ? ((aiInterviewCount - interviewCount) / aiInterviewCount) * 100 : 0,
    },
    {
      from: "Interview",
      to: "Offer",
      drop: Math.max(0, interviewCount - offerCount),
      rate: interviewCount > 0 ? ((interviewCount - offerCount) / interviewCount) * 100 : 0,
    },
    {
      from: "Offer",
      to: "Placed",
      drop: Math.max(0, offerCount - placedCount),
      rate: offerCount > 0 ? ((offerCount - placedCount) / offerCount) * 100 : 0,
    },
  ];

  // Format email -> readable name
  const formatName = (email: string) => {
    if (!email.includes("@")) return email;
    return email
      .split("@")[0]
      .split(".")
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(" ");
  };

  // Source breakdown from overview
  const sources = overview?.by_source ?? [];

  return (
    <div className="w-full space-y-5 pb-12">
      {/* ── PAGE HEADER ─────────────────────────────────────────────────── */}
      {!hideHeader && (
        <div>
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5">
            <div>
              <h1 className="text-xl font-bold text-slate-900">Pipeline Intelligence</h1>
              <p className="text-[13px] text-slate-500 mt-0.5">
                Track your hiring pipeline, conversion, and recruiter performance.
              </p>
            </div>
            {/* Time Pills */}
            <div className="flex bg-slate-100 p-1 rounded-full border border-slate-200/60">
              {[
                { label: "7D", days: 7 },
                { label: "30D", days: 30 },
                { label: "90D", days: 90 },
              ].map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => applyDatePreset(preset.days, preset.label)}
                  className={`px-4 py-1.5 text-[12px] font-semibold rounded-full transition-all ${
                    dateFilterMode === preset.label
                      ? "bg-[#FF5A1F] text-white shadow-sm"
                      : "text-slate-500 hover:text-slate-800 hover:bg-slate-200/50"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Sub Nav */}
          <div className="border-b border-slate-200">
            <div className="flex gap-6 text-[13px] overflow-x-auto whitespace-nowrap scrollbar-none -mb-px">
              {[
                { label: "Overview", path: "/analytics" },
                { label: "Recruiters", path: "/analytics?tab=recruiters" },
                { label: "Pipeline Intelligence", path: "#" },
              ].map((tab) => (
                <Link
                  key={tab.label}
                  href={tab.path}
                  className={`pb-3 font-semibold border-b-2 transition-colors ${
                    tab.label === "Pipeline Intelligence"
                      ? "text-[#FF5A1F] border-[#FF5A1F]"
                      : "text-slate-500 border-transparent hover:text-slate-800"
                  }`}
                >
                  {tab.label}
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Filters row — always visible ──────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Briefcase className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <select
            value={selectedJobId}
            onChange={(e) => setSelectedJobId(e.target.value)}
            className="pl-8 pr-7 py-2 bg-white border border-slate-200 rounded-lg text-[12px] font-medium text-slate-700 appearance-none outline-none focus:border-[#FF5A1F] focus:ring-1 focus:ring-[#FF5A1F] min-w-[160px] cursor-pointer"
          >
            <option value="">All Jobs</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>{j.title}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
        </div>

        <div className="relative">
          <Calendar className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            type="date"
            value={startDate}
            onChange={(e) => { setStartDate(e.target.value); setDateFilterMode(""); }}
            className="pl-8 pr-3 py-2 bg-white border border-slate-200 rounded-lg text-[12px] font-medium text-slate-700 outline-none focus:border-[#FF5A1F] focus:ring-1 focus:ring-[#FF5A1F]"
          />
        </div>

        <span className="text-[12px] text-slate-400">to</span>

        <div className="relative">
          <Calendar className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            type="date"
            value={endDate}
            onChange={(e) => { setEndDate(e.target.value); setDateFilterMode(""); }}
            className="pl-8 pr-3 py-2 bg-white border border-slate-200 rounded-lg text-[12px] font-medium text-slate-700 outline-none focus:border-[#FF5A1F] focus:ring-1 focus:ring-[#FF5A1F]"
          />
        </div>

        {(selectedJobId || (dateFilterMode === "" && (startDate || endDate))) && (
          <button
            onClick={() => { setSelectedJobId(""); applyDatePreset(7, "7D"); }}
            title="Clear filters"
            className="p-2 text-slate-400 hover:text-red-500 transition-colors"
          >
            <FilterX className="w-3.5 h-3.5" />
          </button>
        )}

        <button
          onClick={() => void fetchAllData()}
          disabled={loading}
          className="p-2 text-slate-400 hover:text-[#FF5A1F] transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>

        <button
          onClick={handleExport}
          disabled={exporting || loading}
          className="inline-flex items-center gap-1.5 bg-[#FF5A1F] hover:bg-[#E04B15] text-white px-3 py-2 rounded-lg text-[12px] font-semibold transition-all disabled:opacity-50"
        >
          <Download className="w-3.5 h-3.5" />
          {exporting ? "Exporting..." : "Export CSV"}
        </button>
      </div>


      {/* Error */}
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-100 px-4 py-3 text-[13px] font-medium text-red-600">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && !analytics && (
        <div className="py-20 flex flex-col items-center justify-center text-center">
          <RefreshCw className="h-6 w-6 animate-spin text-[#FF5A1F] mb-3" />
          <p className="text-[13px] text-slate-500">Loading analytics...</p>
        </div>
      )}

      {analytics && (
        <div className="space-y-5">

          {/* ── KPI Cards ─────────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard label="In Pipeline"      value={analytics.total_pipelines} />
            <KpiCard label="Active Pipelines" value={analytics.total_pipelines} />
            <KpiCard label="Placed"           value={analytics.total_placed} />
            <KpiCard label="Rejected"         value={analytics.total_rejected} />
            <KpiCard label="Placement Rate"   value={`${analytics.overall_placement_rate.toFixed(1)}%`} />
            <KpiCard label="Avg. Pipeline Time" value={totalAvgDays > 0 ? `${totalAvgDays.toFixed(1)}d` : "—"} />
          </div>

          {/* ── Conversion Funnel ─────────────────────────────────────────────── */}
          <div className="bg-white rounded-xl p-5 border border-slate-200/70">
            <SectionTitle title="Pipeline Conversion Funnel" />
            <ConversionFunnelChart funnel={analytics.funnel} />
          </div>

          {/* ── Bento Grid ────────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Candidates by Stage */}
            <div className="bg-white rounded-xl p-5 border border-slate-200/70">
              <SectionTitle title="Candidates by Stage" />
              <div className="space-y-3.5">
                {[
                  { label: "Applied", val: appliedCount },
                  { label: "AI Interview", val: aiInterviewCount },
                  { label: "Interview", val: interviewCount },
                  { label: "Offer", val: offerCount },
                  { label: "Placed", val: placedCount },
                ].map((st) => {
                  const pct = baseCandidates > 0 ? (st.val / baseCandidates) * 100 : 0;
                  return (
                    <div key={st.label}>
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-[12px] font-medium text-slate-600">{st.label}</span>
                        <span className="text-[12px] font-semibold text-slate-800">
                          {st.val}
                          <span className="text-slate-400 font-normal ml-1">
                            ({pct > 0 ? pct.toFixed(0) : 0}%)
                          </span>
                        </span>
                      </div>
                      <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                        <div
                          className="bg-[#FF5A1F] h-full rounded-full transition-all duration-700"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 pt-3.5 border-t border-slate-100 flex justify-between text-[12px]">
                <span className="text-slate-400">Total candidates</span>
                <span className="font-semibold text-slate-800">{baseCandidates}</span>
              </div>
            </div>

            {/* Candidates by Source */}
            <div className="bg-white rounded-xl p-5 border border-slate-200/70 flex flex-col">
              <SectionTitle title="Candidates by Source" />
              {sources.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center">
                  {/* Generic donut when no source data */}
                  <div className="relative w-36 h-36 mb-4">
                    <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="38" fill="transparent" stroke="#F1F5F9" strokeWidth="12" />
                      {baseCandidates > 0 && (
                        <circle
                          cx="50" cy="50" r="38"
                          fill="transparent" stroke="#FF5A1F" strokeWidth="12"
                          strokeDasharray="238.76" strokeDashoffset="0"
                          strokeLinecap="round"
                        />
                      )}
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-2xl font-bold text-slate-900">{baseCandidates}</span>
                      <span className="text-[10px] text-slate-400 uppercase tracking-wider">Total</span>
                    </div>
                  </div>
                  <div className="w-full space-y-2">
                    <div className="flex justify-between items-center py-2 px-3 rounded-lg bg-slate-50 border border-slate-100">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-[#FF5A1F]" />
                        <span className="text-[12px] font-medium text-slate-700">All Sources</span>
                      </div>
                      <span className="text-[12px] font-semibold text-slate-800">{baseCandidates}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col">
                  <div className="relative w-36 h-36 mx-auto mb-4">
                    <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="38" fill="transparent" stroke="#F1F5F9" strokeWidth="12" />
                      <circle
                        cx="50" cy="50" r="38"
                        fill="transparent" stroke="#FF5A1F" strokeWidth="12"
                        strokeDasharray="238.76" strokeDashoffset="0"
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-2xl font-bold text-slate-900">{overview?.total_candidates ?? baseCandidates}</span>
                      <span className="text-[10px] text-slate-400 uppercase tracking-wider">Total</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {sources.slice(0, 4).map((src, i) => {
                      const total = overview?.total_candidates || 1;
                      const pct = ((src.count / total) * 100).toFixed(0);
                      const colors = ["bg-[#FF5A1F]", "bg-slate-400", "bg-emerald-500", "bg-purple-500"];
                      return (
                        <div key={src.source} className="flex justify-between items-center py-1.5 px-3 rounded-lg bg-slate-50 border border-slate-100">
                          <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${colors[i] ?? "bg-slate-300"}`} />
                            <span className="text-[12px] font-medium text-slate-700 capitalize">{src.source || "Unknown"}</span>
                          </div>
                          <span className="text-[12px] font-semibold text-slate-800">{src.count} ({pct}%)</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Drop-off Insights */}
            <div className="bg-white rounded-xl p-5 border border-slate-200/70">
              <SectionTitle title="Drop-off Insights" />
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr>
                    <th className="pb-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100">Stage</th>
                    <th className="pb-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100 text-right pr-3">Lost</th>
                    <th className="pb-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100 text-right">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {dropOffs.map((d, i) => (
                    <tr key={i} className="border-b border-slate-50 last:border-0">
                      <td className="py-2.5 text-[12px] text-slate-700">
                        {d.from} <span className="text-slate-300 mx-1">→</span> {d.to}
                      </td>
                      <td className="py-2.5 text-[12px] font-medium text-slate-600 text-right pr-3">{d.drop}</td>
                      <td className={`py-2.5 text-[12px] font-semibold text-right ${d.rate > 0 ? "text-red-500" : "text-slate-300"}`}>
                        {d.rate > 0 ? `${d.rate.toFixed(0)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Recruiter Performance ─────────────────────────────────────────── */}
          <div className="bg-white rounded-xl p-5 border border-slate-200/70">
            <SectionTitle title="Recruiter Pipeline Performance" />
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr>
                    <th className="pb-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100">Recruiter</th>
                    <th className="pb-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100 text-right">Submissions</th>
                    <th className="pb-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100 text-right">Interviews</th>
                    <th className="pb-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100 text-right">Placements</th>
                    <th className="pb-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100 text-right">Conversion</th>
                  </tr>
                </thead>
                <tbody>
                  {!recruiterActivity || recruiterActivity.by_recruiter.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-[13px] text-slate-400">
                        No recruiter data found for this period.
                      </td>
                    </tr>
                  ) : (
                    recruiterActivity.by_recruiter.map((rec) => {
                      const name = formatName(rec.recruiter_name);
                      const initial = name.charAt(0).toUpperCase();
                      const convRate = rec.submissions > 0
                        ? ((rec.placements / rec.submissions) * 100).toFixed(1)
                        : "0.0";

                      return (
                        <tr key={rec.recruiter_name} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/40 transition-colors">
                          <td className="py-3">
                            <div className="flex items-center gap-2.5">
                              <div className="w-8 h-8 rounded-full bg-orange-50 border border-orange-100 flex items-center justify-center text-[#FF5A1F] font-bold text-[12px] flex-shrink-0">
                                {initial}
                              </div>
                              <div>
                                <p className="text-[13px] font-medium text-slate-800 leading-tight">{name}</p>
                                <p className="text-[11px] text-slate-400">{rec.recruiter_name}</p>
                              </div>
                            </div>
                          </td>
                          <td className="py-3 text-[13px] text-slate-700 text-right">{rec.submissions}</td>
                          <td className="py-3 text-[13px] text-slate-700 text-right">{rec.interviews}</td>
                          <td className="py-3 text-[13px] text-slate-700 text-right">{rec.placements}</td>
                          <td className={`py-3 text-[13px] font-semibold text-right ${parseFloat(convRate) > 0 ? "text-emerald-600" : "text-slate-400"}`}>
                            {convRate}%
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}

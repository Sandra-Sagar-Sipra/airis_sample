"use client";

import { useState, useEffect } from "react";
import { OpenJobsMetrics } from "@/components/analytics-dashboard/OpenJobsMetrics";
import { PipelineMetrics } from "@/components/analytics-dashboard/PipelineMetrics";
import { RecruiterActivityMetrics } from "@/components/analytics-dashboard/RecruiterActivityMetrics";
import { TimeToShortlistMetrics } from "@/components/analytics-dashboard/TimeToShortlistMetrics";
import { PlacementTrackingMetrics } from "@/components/analytics-dashboard/PlacementTrackingMetrics";
import { PipelineAnalyticsContent } from "@/components/analytics/PipelineAnalyticsContent";
import { useAuthStore } from "@/store/auth-store";

import { getDashboardSummary } from "@/lib/api/analytics";
import type { DashboardSummaryResponse } from "@/lib/api/types";
import { Loader2 } from "lucide-react";

export default function AnalyticsDashboardPage() {
  const permissions = useAuthStore((s) => s.permissions);
  const canRead = permissions.includes("jobs:read");
  const [activeTab, setActiveTab] = useState("overview");
  
  const [summaryData, setSummaryData] = useState<DashboardSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!canRead) return;
    let mounted = true;
    getDashboardSummary()
      .then(res => {
        if (mounted) {
          setSummaryData(res);
          setLoading(false);
        }
      })
      .catch(err => {
        if (mounted) {
          setError(err);
          setLoading(false);
        }
      });
    return () => { mounted = false; };
  }, [canRead]);

  const analyticsTabs = [
    { key: "overview", label: "Overview" },
    { key: "recruiters", label: "Recruiters" },
    { key: "pipeline-analytics", label: "Pipeline" },
  ];

  if (!canRead) {
    return (
      <section className="py-16 text-center">
        <p className="text-sm text-slate-500">
          You do not have permission to view analytics.
        </p>
      </section>
    );
  }

  return (
    <div className="pb-16 bg-slate-50 min-h-screen p-6">
      {/* PAGE HEADER */}
      <h1 className="text-2xl font-bold tracking-tight text-slate-900 mb-4">
        Analytics Dashboard
      </h1>

      {/* HORIZONTAL TABS */}
      <div className="border-b border-slate-200 mb-6 px-1">
        <div className="flex gap-6 text-sm overflow-x-auto whitespace-nowrap scrollbar-none -mb-px">
          {analyticsTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`py-3 font-semibold text-sm border-b-2 transition-colors relative ${
                activeTab === tab.key
                  ? "text-[#FF5A1F] border-[#FF5A1F]"
                  : "text-slate-500 border-transparent hover:text-slate-800"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* TAB CONTENT PANELS */}
      <div className="transition-all duration-300">
        {loading && (
          <div className="flex h-64 items-center justify-center">
             <Loader2 className="h-8 w-8 animate-spin text-[#FF5A1F]" />
          </div>
        )}
        
        {error && !loading && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-600 shadow-sm w-full h-64 flex items-center justify-center">
            Failed to load dashboard metrics.
          </div>
        )}

        {/* OVERVIEW TAB */}
        {activeTab === "overview" && summaryData && (
          <div className="space-y-5">
            {/* Row 1 — 4 KPI cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <OpenJobsMetrics view="kpi" onNavigate={() => setActiveTab("jobs")} data={summaryData.open_jobs} />
              <PipelineMetrics view="kpi" onNavigate={() => setActiveTab("pipeline-analytics")} data={summaryData.pipeline} />
              <RecruiterActivityMetrics view="kpi" onNavigate={() => setActiveTab("recruiters")} data={summaryData.recruiter_activity} />
              <PlacementTrackingMetrics view="kpi" onNavigate={() => setActiveTab("recruiters")} data={summaryData.placement_tracking} />
            </div>

            {/* Row 2 — Recruiter activity + Jobs by status side by side */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <RecruiterActivityMetrics view="overview-panel" data={summaryData.recruiter_activity} />
              <OpenJobsMetrics view="status-panel" onNavigate={() => setActiveTab("jobs")} data={summaryData.open_jobs} />
            </div>

            {/* Row 3 — Recently created jobs scrollable */}
            <OpenJobsMetrics view="jobs-panel" onNavigate={() => setActiveTab("jobs")} data={summaryData.open_jobs} />
          </div>
        )}


        {/* RECRUITERS TAB */}
        {activeTab === "recruiters" && summaryData && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 auto-rows-min">
            <RecruiterActivityMetrics view="tab-panel" data={summaryData.recruiter_activity} />
            <TimeToShortlistMetrics view="tab-panel" data={summaryData.time_to_shortlist} />
          </div>
        )}



        {/* PIPELINE ANALYTICS TAB */}
        {activeTab === "pipeline-analytics" && (
          <div className="w-full">
            <PipelineAnalyticsContent hideHeader={true} />
          </div>
        )}
      </div>
    </div>
  );
}

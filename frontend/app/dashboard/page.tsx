"use client";
// Force rebuild to pick up api client changes

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatApiErrorForUser } from "@/lib/api/client";
import {
  getDashboardSummary,
  readCachedDashboardSummary,
  writeCachedDashboardSummary,
  type DashboardActivityItem,
  type DashboardRecentJob,
  type DashboardSummary,
} from "@/lib/api/dashboard";
import { getPipelinesWithMeta } from "@/lib/api/pipeline";
import { useAuthStore } from "@/store/auth-store";
import { Users, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { PipelineStageTooltipWrapper } from "@/components/dashboard-interactions";
import { DashboardDoughnutChart, DashboardAreaChart } from "@/components/dashboard-charts";
import { useRouter } from "next/navigation";

function getRelativeTimeString(date: Date | number, lang = "en-US"): string {
  const timeMs = typeof date === "number" ? date : date.getTime();
  const deltaSeconds = Math.round((timeMs - Date.now()) / 1000);
  const cutoffs = [60, 3600, 86400, 86400 * 7, 86400 * 30, 86400 * 365, Infinity];
  const units: Intl.RelativeTimeFormatUnit[] = ["second", "minute", "hour", "day", "week", "month", "year"];
  const unitIndex = cutoffs.findIndex(cutoff => cutoff > Math.abs(deltaSeconds));
  const divider = unitIndex ? cutoffs[unitIndex - 1] : 1;
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  return rtf.format(Math.floor(deltaSeconds / divider), units[unitIndex]);
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardSummary | null>(() => readCachedDashboardSummary());
  const [stageCounts, setStageCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(() => readCachedDashboardSummary() === null);
  const [error, setError] = useState<string | null>(null);

  const router = useRouter();

  const permissions = useAuthStore((state) => state.permissions);
  const hydrated = useAuthStore((state) => state.hydrated);
  const token = useAuthStore((state) => state.token);

  const hasAnyPermission =
    permissions.includes("candidates:read") ||
    permissions.includes("candidates:read_own") ||
    permissions.includes("jobs:read") ||
    permissions.includes("jobs:read_limited") ||
    permissions.includes("pipeline:read");

  async function loadData(cancelledRef?: { cancelled: boolean }, isBackground = false) {
    const hasCachedUi = !isBackground && (data !== null || readCachedDashboardSummary() !== null);
    if (!isBackground) {
      setLoading(!hasCachedUi);
      setError(null);
    }
    try {
      const [summary, pipelinesMeta] = await Promise.all([
        getDashboardSummary(),
        getPipelinesWithMeta({ limit: 1, status: "active" }).catch(() => null)
      ]);
      if (cancelledRef?.cancelled) return;

      setData(summary);
      if (pipelinesMeta) {
        setStageCounts(pipelinesMeta.meta.stage_counts || {});
      }
      writeCachedDashboardSummary(summary);
    } catch (err: unknown) {
      if (!cancelledRef?.cancelled && !isBackground && !hasCachedUi) {
        setError(formatApiErrorForUser(err));
      }
    } finally {
      if (!cancelledRef?.cancelled) {
        if (!isBackground) {
          setLoading(false);
        }
      }
    }
  }

  useEffect(() => {
    if (!hydrated || !token) return;
    const cancelledRef = { cancelled: false };
    void loadData(cancelledRef, false);
    const interval = window.setInterval(() => {
      void loadData(cancelledRef, true);
    }, 30_000);
    return () => {
      cancelledRef.cancelled = true;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token]);

  if (hydrated && !hasAnyPermission) {
    return (
      <section className="space-y-4">
        <div className="rounded-[24px] shadow-[0_2px_12px_rgba(0,0,0,0.03)] bg-white px-6 py-5 text-[14px] text-slate-800">
          <p className="font-semibold text-slate-900">Limited access</p>
          <p className="mt-1 text-slate-500">
            Nothing on this overview is available with your current permissions.
          </p>
        </div>
      </section>
    );
  }

  // Derived Chart Data
  const chartColors = ["#FF5A1F", "#3b82f6", "#a855f7", "#10b981", "#ec4899"];

  const candidateStatusData = [
    { name: "New", value: data?.candidates_by_status?.new || 0, color: chartColors[0] },
    { name: "In Process", value: data?.candidates_by_status?.in_process || 0, color: chartColors[1] },
    { name: "Interview", value: data?.candidates_by_status?.interview || 0, color: chartColors[2] },
    { name: "Offered", value: data?.candidates_by_status?.offered || 0, color: chartColors[3] },
    { name: "Placed", value: data?.candidates_by_status?.placed || 0, color: chartColors[4] },
  ];
  const totalCandidatesChart = candidateStatusData.reduce((acc, curr) => acc + curr.value, 0);

  const jobColors = chartColors;
  const topActiveJobsData = (data?.recent_jobs || [])
    .filter((job) => job.status === "open")
    .sort((a, b) => b.candidate_count - a.candidate_count)
    .slice(0, 5)
    .map((job, idx) => ({
      name: job.title.split(/ [/-] /)[0], // Truncate long titles
      value: job.candidate_count,
      color: jobColors[idx % jobColors.length],
    }));
  const totalTopJobsCandidates = topActiveJobsData.reduce((acc, curr) => acc + curr.value, 0);

  const pipelineStageData = [
    { name: "Sourced", value: data?.pipeline_stages?.sourced || 0, color: chartColors[0] },
    { name: "AI Interview Screening", value: data?.pipeline_stages?.ai_interview || 0, color: chartColors[1] },
    { name: "Interview", value: data?.pipeline_stages?.interview || 0, color: chartColors[2] },
    { name: "Offer", value: data?.pipeline_stages?.offer || 0, color: chartColors[3] },
    { name: "Placed", value: data?.pipeline_stages?.placed || 0, color: chartColors[4] },
  ];
  const totalPipeline = pipelineStageData.reduce((acc, curr) => acc + curr.value, 0);

  const candidatesAddedData = data?.candidates_added_trend || [];
  const jobsCreatedData = data?.jobs_created_trend || [];


  return (
    <section className="pb-10 max-w-[1400px] flex flex-col gap-6 lg:flex-row">
      {error && (
        <div className="col-span-full rounded-2xl bg-red-50 px-5 py-4 text-[14px] text-red-600 font-medium">
          {error}
        </div>
      )}

      {/* Main Left Column */}
      <div className="flex-1 space-y-8 min-w-0">

        {/* KPI cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Link href="/candidates" className="block focus:outline-none">
            <KpiCard title="Total Candidates" value={data?.total_candidates} trend={data?.candidates_trend} loading={loading} interactive />
          </Link>
          <Link href="/jobs" className="block focus:outline-none">
            <KpiCard title="Active Jobs" value={data?.active_jobs} trend={data?.jobs_trend} loading={loading} interactive />
          </Link>
          <PipelineStageTooltipWrapper
            stage="active_pipeline"
            onClick={() => router.push("/pipeline-details/active_pipeline")}
            onMouseEnter={() => router.prefetch("/pipeline-details/active_pipeline")}
            className="relative block w-full focus:outline-none"
            position="bottom"
          >
            <KpiCard title="In Pipeline" value={data?.in_pipeline} trend={data?.pipeline_trend} loading={loading} interactive />
          </PipelineStageTooltipWrapper>
          <PipelineStageTooltipWrapper
            stage="placements"
            onClick={() => router.push("/pipeline-details/placements")}
            onMouseEnter={() => router.prefetch("/pipeline-details/placements")}
            className="relative block w-full focus:outline-none"
            position="bottom"
          >
            <KpiCard title="Placements" value={data?.placements} trend={data?.placements_trend} loading={loading} interactive />
          </PipelineStageTooltipWrapper>
        </div>

        {/* Active Pipeline funnel */}
        <div className="space-y-4">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-[16px] font-bold text-slate-900 tracking-tight">Active Pipeline</h3>
          </div>

          <div className="rounded-[20px] shadow-[0_2px_12px_rgba(0,0,0,0.02)] bg-orange-50 p-6 relative border border-orange-100 min-h-[140px] flex items-center justify-center">
            <div className="absolute top-[3.8rem] left-16 right-16 h-[1px] border-b border-dashed border-orange-200 z-0" />
            <div className="flex items-center justify-between relative z-10 w-full px-4 gap-2">
              {(() => {
                const allStages = ['applied', 'ai_interview', 'interview', 'offer', 'placed', 'rejected'];

                return allStages.map(s => {
                  let finalCount = 0;
                  if (Object.keys(stageCounts).length > 0) {
                    finalCount = stageCounts[s] || 0;
                  } else {
                    // Fallback to DashboardSummary data
                    const ds = data?.pipeline_stages as Record<string, number> | undefined;
                    const dsKey = s === 'applied' ? 'sourced' : s;
                    finalCount = ds?.[dsKey] || 0;
                  }

                  // Hide unsupported/zero-count stages
                  if (!finalCount && ['rejected'].includes(s)) return null;

                  let displayTitle = s.charAt(0).toUpperCase() + s.slice(1);
                  if (s === 'applied') displayTitle = 'Sourced';
                  if (s === 'ai_interview') displayTitle = 'AI Interview Screening';

                  return (
                    <PipelineStageTooltipWrapper
                      key={s}
                      stage={s as any}
                      onClick={() => router.push(`/pipeline-details/${s}`)}
                      onMouseEnter={() => router.prefetch(`/pipeline-details/${s}`)}
                    >
                      <PipelineStage
                        title={displayTitle}
                        value={finalCount}
                        loading={loading}
                        highlight={s === 'interview'}
                        isSuccess={s === 'placed'}
                      />
                    </PipelineStageTooltipWrapper>
                  );
                });
              })()}
            </div>
          </div>
        </div>

        {/* Recent Jobs */}
        <div className="space-y-4">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-[16px] font-bold text-slate-900 tracking-tight">Recent Jobs</h3>
            <Link href="/jobs" className="text-[13px] font-bold text-[#FF5A1F] hover:text-[#e04814] cursor-pointer transition-colors">View All</Link>
          </div>

          <div className="rounded-[20px] shadow-[0_2px_12px_rgba(0,0,0,0.02)] bg-orange-50 overflow-hidden border border-orange-100">
            <div className="w-full">
              <div className="grid grid-cols-12 px-5 py-3.5 border-b border-slate-100/80 bg-slate-50/50 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                <div className="col-span-6">Job Role</div>
                <div className="col-span-2">Candidates</div>
                <div className="col-span-2">Status</div>
                <div className="col-span-2 text-right pr-6">Created</div>
              </div>
              <div className="divide-y divide-slate-100/60">
                {loading ? (
                  <div className="flex justify-center p-6">
                    <span className="text-[12px] text-slate-400 font-medium">Loading jobs...</span>
                  </div>
                ) : data?.recent_jobs && data.recent_jobs.length > 0 ? (
                  data.recent_jobs.map((job) => (
                    <Link key={job.id} href={`/jobs/${job.id}`} prefetch={true} className="block focus:outline-none">
                      <RecentJobRow job={job} />
                    </Link>
                  ))
                ) : (
                  <div className="flex justify-center p-8">
                    <span className="text-[13px] text-slate-400 font-medium">No recent jobs</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        {/* Analytics Charts (Bottom of Left Column) */}
        {!loading && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-2">
            <DashboardAreaChart title="Candidates Added" data={candidatesAddedData} color="#FF5A1F" gradientId="candidatesAddedGrad" />
            <DashboardAreaChart title="Jobs Created" data={jobsCreatedData} color="#FF5A1F" gradientId="jobsCreatedGrad" />
          </div>
        )}

      </div>

      {/* Right Column: Sidebar */}
      <div className="w-full lg:w-[320px] flex-shrink-0 space-y-4">

        {/* Analytics Doughnut Charts (Stacked) */}
        {!loading && (
          <div className="space-y-4 pb-4 border-b border-slate-100/60">
            <DashboardDoughnutChart title="Candidates by Status" data={candidateStatusData} total={totalCandidatesChart} totalLabel="Total" />
            <DashboardDoughnutChart title="Top Active Jobs" data={topActiveJobsData} total={totalTopJobsCandidates} totalLabel="Cands" />
            <DashboardDoughnutChart title="Pipeline by Stage" data={pipelineStageData} total={totalPipeline} totalLabel="Total" />
          </div>
        )}

        <div className="flex items-center justify-between px-1 pt-2">
          <h3 className="text-[15px] font-bold text-slate-900 tracking-tight">Activity Log</h3>
          <div className="flex items-center gap-1 text-[12px] font-bold text-slate-600">
            All Activities <ChevronDown className="w-3.5 h-3.5" />
          </div>
        </div>
        <div className="rounded-[20px] shadow-[0_2px_12px_rgba(0,0,0,0.02)] bg-orange-50 p-5 border border-orange-100 max-h-[310px] overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-slate-200 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent">
          {loading ? (
            <div className="flex justify-center p-6">
              <span className="text-[13px] text-slate-400 font-medium">Loading activity...</span>
            </div>
          ) : data?.activities && data.activities.length > 0 ? (
            <div className="space-y-6 pr-2">
              {data.activities.map((activity) => (
                <ActivityRow key={activity.id} activity={activity} />
              ))}
            </div>
          ) : (
            <div className="flex justify-center p-6">
              <span className="text-[13px] text-slate-400 font-medium">No recent activity</span>
            </div>
          )}
        </div>
      </div>

    </section>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function KpiCard({
  title, value, trend, loading, interactive = false
}: {
  title: string;
  value: number | undefined;
  trend: number | undefined;
  loading: boolean;
  interactive?: boolean;
}) {
  const display = loading ? "…" : value === undefined ? "0" : value;
  const isPositive = (trend ?? 0) >= 0;

  return (
    <div className={cn(
      "rounded-[20px] shadow-[0_2px_12px_rgba(0,0,0,0.02)] bg-orange-50 border border-orange-100 p-5 transition-all duration-300 group",
      interactive ? "cursor-pointer hover:shadow-[0_8px_24px_rgba(0,0,0,0.06)] hover:border-orange-200 hover:-translate-y-0.5" : "cursor-default hover:shadow-[0_8px_24px_rgba(0,0,0,0.04)]"
    )}>
      <div className="flex items-center justify-between mb-4">
        <p className="text-[13px] font-semibold text-slate-600 group-hover:text-[#FF5A1F] transition-colors duration-300">{title}</p>
      </div>
      <div className="flex items-center gap-2">
        <p className="text-[32px] leading-none font-bold text-slate-900 group-hover:text-[#FF5A1F] transition-colors duration-300">{display}</p>
      </div>
    </div>
  );
}

function PipelineStage({
  title, value, loading
}: {
  title: string;
  value: number | undefined;
  loading: boolean;
}) {
  const display = loading ? "…" : value === undefined ? "0" : value;

  return (
    <div className="flex flex-col items-center text-center relative bg-orange-50 w-20 pt-1 group cursor-pointer hover:-translate-y-1 transition-transform">
      <p className="text-[13px] font-semibold text-slate-600 mb-3 z-10 bg-orange-50 px-2 group-hover:text-[#FF5A1F] transition-colors duration-300">
        {title}
      </p>
      <p className="text-[28px] leading-none font-bold text-slate-900 mb-2 group-hover:text-[#FF5A1F] transition-colors duration-300">
        {display}
      </p>
    </div>
  );
}

function RecentJobRow({ job }: { job: DashboardRecentJob }) {
  const isOpen = job.status === "open";
  return (
    <div className="grid grid-cols-12 px-5 py-4 items-center hover:bg-slate-50/80 transition-colors group cursor-pointer focus:outline-none focus:bg-slate-50">
      <div className="col-span-6 flex flex-col gap-1.5 pr-4">
        <span className="text-[14px] font-bold text-slate-900 group-hover:text-[#FF5A1F] transition-colors truncate">{job.title}</span>
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-slate-500 truncate">{job.location || "Remote"}</span>
          {job.employment_type && (
            <>
              <div className="w-1 h-1 rounded-full bg-slate-300" />
              <span className="text-[12px] font-medium text-slate-500 capitalize whitespace-nowrap">
                {job.employment_type.replace("_", " ")}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="col-span-2 flex items-center gap-2 text-slate-600">
        <Users className="w-4 h-4 text-slate-400" />
        <span className="text-[13px] font-bold">{job.candidate_count}</span>
      </div>

      <div className="col-span-2">
        <span className={cn(
          "px-2.5 py-1 rounded-md text-[10px] font-bold inline-flex items-center gap-1.5 tracking-wider uppercase",
          isOpen ? "bg-emerald-50 text-emerald-600" :
            job.status === "draft" ? "bg-slate-100 text-slate-500" :
              "bg-blue-50 text-blue-600"
        )}>
          <div className={cn(
            "w-1.5 h-1.5 rounded-full",
            isOpen ? "bg-emerald-500" : job.status === "draft" ? "bg-slate-400" : "bg-blue-500"
          )} />
          {job.status}
        </span>
      </div>

      <div className="col-span-2 flex items-center justify-end pr-4 opacity-80 group-hover:opacity-100 transition-opacity">
        <span className="text-[12px] font-semibold text-slate-500 whitespace-nowrap">
          {getRelativeTimeString(new Date(job.created_at))}
        </span>
      </div>
    </div>
  );
}

function ActivityRow({ activity }: { activity: DashboardActivityItem }) {
  let iconColor = "bg-slate-300";
  let href = "/";

  if (activity.type === "job_created") {
    iconColor = "bg-blue-500";
    href = `/jobs/${activity.id.replace("j-", "")}`;
  } else if (activity.type === "placement") {
    iconColor = "bg-emerald-500";
    href = `/pipeline-details/placements`;
  } else if (activity.title.includes("Assessment")) {
    iconColor = "bg-pink-500";
    href = `/pipeline-details/assessment`;
  } else if (activity.title.includes("Interview")) {
    iconColor = "bg-purple-500";
    href = `/pipeline-details/interview`;
  } else if (activity.title.includes("Offer")) {
    iconColor = "bg-blue-500";
    href = `/pipeline-details/offer`;
  } else if (activity.title.includes("Screening")) {
    iconColor = "bg-[#FF5A1F]";
    href = `/pipeline-details/screening`;
  } else {
    iconColor = "bg-[#FF5A1F]";
    href = `/pipeline-details/active_pipeline`;
  }

  return (
    <Link href={href} prefetch={true} className="flex items-start gap-4 cursor-pointer group hover:bg-slate-50 p-2 -m-2 rounded-lg transition-colors focus:outline-none focus:bg-slate-50">
      <div className="pt-1.5 flex-shrink-0">
        <div className={cn("w-2 h-2 rounded-full", iconColor)} />
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <p className="text-[14px] font-bold text-slate-900 tracking-tight truncate leading-tight group-hover:text-[#FF5A1F] transition-colors duration-300">
          {activity.title}
        </p>
        <p className="text-[13px] font-medium text-slate-500 truncate">{activity.subtitle}</p>
        <p className="text-[12px] font-medium text-slate-400 mt-0.5">
          {getRelativeTimeString(new Date(activity.timestamp))}
        </p>
      </div>
    </Link>
  );
}

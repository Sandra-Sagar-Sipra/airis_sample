"use client";

import { useCallback, useEffect, useState } from "react";
import { List, RefreshCw, Filter, Calendar, Users, Play, Briefcase, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InterviewStatusBadge } from "@/components/interviews/InterviewStatusBadge";
import { claimInterview, getInterviewQueue } from "@/lib/api/interviews";
import { getJobs } from "@/lib/api/jobs";
import { useAuthStore } from "@/store/auth-store";
import type { Job, QueueInterview } from "@/lib/api/types";
import Link from "next/link";

const ROUND_TYPE_OPTIONS = [
  { value: "", label: "All Rounds" },
  { value: "hr", label: "HR" },
  { value: "technical", label: "Technical" },
  { value: "managerial", label: "Managerial" },
  { value: "final", label: "Final" },
  { value: "ai_screening", label: "AI Screening" },
];

const ROUND_LABELS: Record<string, string> = {
  hr: "HR", technical: "Technical", managerial: "Managerial", final: "Final", ai_screening: "AI Screening",
};

function QueueCard({
  item,
  jobs,
  onClaim,
  claiming,
}: {
  item: QueueInterview;
  jobs: Job[];
  onClaim: (id: string) => void;
  claiming: string | null;
}) {
  const scheduledDate = new Date(item.scheduled_at);

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden hover:border-[#FF5A1F]/30 transition-colors">

      <div className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-gray-900">
                {item.candidate_first_name || item.candidate_last_name
                  ? `${item.candidate_first_name ?? ""} ${item.candidate_last_name ?? ""}`.trim()
                  : "Candidate"}
              </h3>
              <InterviewStatusBadge status={item.status} />
              {item.interview_type && (
                <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                  {ROUND_LABELS[item.interview_type] ?? item.interview_type}
                </span>
              )}
            </div>
            {item.job_title && (
              <p className="text-xs text-gray-500 flex items-center gap-1.5">
                <Briefcase className="w-3 h-3 shrink-0" />
                {item.job_title}
              </p>
            )}
          </div>
        </div>

        {/* Meta row */}
        <div className="grid grid-cols-2 gap-2 text-xs text-gray-600">
          <div className="flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            <span>
              {scheduledDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            {scheduledDate.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            {item.duration_minutes && ` · ${item.duration_minutes}m`}
          </div>
          <div className="flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            {item.participant_count > 0
              ? `${item.participant_count} panelist${item.participant_count !== 1 ? "s" : ""}`
              : <span className="text-orange-600 font-medium">No panelists yet</span>
            }
          </div>
          {item.meeting_type && (
            <div className="flex items-center gap-1.5 text-gray-500 capitalize">
              {item.meeting_type.replace("_", " ")}
            </div>
          )}
        </div>

        {item.notes && (
          <p className="text-xs text-gray-500 italic line-clamp-2 border-t border-gray-50 pt-2">
            {item.notes}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between pt-2.5 border-t border-gray-100">
          <Button
            size="sm"
            className="h-7 text-[11px] bg-[#FF5A1F] hover:bg-orange-600 text-white px-3"
            onClick={() => onClaim(item.id)}
            disabled={claiming === item.id}
          >
            <Play className="w-3 h-3 mr-1" />
            {claiming === item.id ? "Claiming…" : "Take Interview"}
          </Button>
          <Link
            href={`/interviews/${item.id}`}
            className="text-[11px] text-[#FF5A1F] hover:underline font-medium"
          >
            Workspace →
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function InterviewQueuePage() {
  const [queue, setQueue] = useState<QueueInterview[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [roundFilter, setRoundFilter] = useState("");
  const [jobFilter, setJobFilter] = useState("");
  const [claimedIds, setClaimedIds] = useState<Set<string>>(new Set());

  const userId = useAuthStore((state) => state.userId);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    else setRefreshing(true);
    try {
      // 1. Fetch queue items and immediately update state
      const queueData = await getInterviewQueue({
        limit: 100,
        round_type: roundFilter || undefined,
        job_id: jobFilter || undefined,
      });
      setQueue(queueData);
      
      // 2. Stop loading spinner so UI renders instantly
      setLoading(false);

      // 3. Fetch jobs in the background to populate job titles and filters
      getJobs(50, 0)
        .then((jobsData) => setJobs(jobsData))
        .catch((err) => console.error("Background jobs fetch failed:", err));

    } catch (err) {
      console.error("Failed to load queue:", err);
      setLoading(false);
    } finally {
      setRefreshing(false);
    }
  }, [roundFilter, jobFilter]);

  useEffect(() => { void load(); }, [load]);

  async function handleClaim(interviewId: string) {
    setClaiming(interviewId);
    try {
      await claimInterview(interviewId);
      setClaimedIds((prev) => new Set([...prev, interviewId]));
      // Refresh queue silently
      await load({ silent: true });
    } catch (err) {
      // Claimed already or error — silent
    } finally {
      setClaiming(null);
    }
  }

  const visibleQueue = queue.filter((item) => !claimedIds.has(item.id));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <List className="w-6 h-6 text-[#FF5A1F]" />
            Interview Queue
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {visibleQueue.length} interview{visibleQueue.length !== 1 ? "s" : ""} needing panelists
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => load({ silent: true })}
          disabled={refreshing}
          className="gap-1.5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap bg-white rounded-xl border border-gray-200 p-4">
        <Filter className="w-4 h-4 text-gray-400 shrink-0" />
        <select
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-[#FF5A1F] bg-white"
          value={roundFilter}
          onChange={(e) => setRoundFilter(e.target.value)}
        >
          {ROUND_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-[#FF5A1F] bg-white"
          value={jobFilter}
          onChange={(e) => setJobFilter(e.target.value)}
        >
          <option value="">All Jobs</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>{j.title}</option>
          ))}
        </select>
        {(roundFilter || jobFilter) && (
          <button
            className="text-xs text-gray-400 hover:text-gray-700 underline"
            onClick={() => { setRoundFilter(""); setJobFilter(""); }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Queue grid */}
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-48 rounded-xl bg-gray-100 animate-pulse" />
          ))}
        </div>
      ) : visibleQueue.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
          <List className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-500">No interviews in the queue</p>
          <p className="text-xs text-gray-400 mt-1">Interviews waiting for panelists will appear here.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleQueue.map((item) => (
            <QueueCard
              key={item.id}
              item={item}
              jobs={jobs}
              onClaim={handleClaim}
              claiming={claiming}
            />
          ))}
        </div>
      )}
    </div>
  );
}

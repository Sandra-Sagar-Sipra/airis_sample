"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, CheckCircle2, Clock, MessageSquare, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InterviewStatusBadge } from "@/components/interviews/InterviewStatusBadge";
import { InterviewFeedbackForm } from "@/components/interviews/InterviewFeedbackForm";
import { getMyInterviews } from "@/lib/api/interviews";
import { getJobs } from "@/lib/api/jobs";
import type { Interview, Job } from "@/lib/api/types";
import Link from "next/link";

const ROUND_LABELS: Record<string, string> = {
  hr: "HR", technical: "Technical", managerial: "Managerial", final: "Final", ai_screening: "AI Screening",
};

// Defined outside the component so they are stable references and never
// need to appear in useMemo dependency arrays.
const ACTIVE_STATUSES = new Set([
  "scheduled", "confirmed", "panel_confirmed", "in_progress",
]);
const TERMINAL_STATUSES = new Set([
  "completed", "feedback_submitted", "feedback_pending",
  "cancelled", "no_show",
]);

function MyInterviewCard({
  interview,
  job,
  onFeedbackSubmit,
}: {
  interview: Interview;
  job?: Job;
  onFeedbackSubmit: (id: string) => void;
}) {
  const [showFeedback, setShowFeedback] = useState(false);
  const scheduledDate = new Date(interview.scheduled_at);
  const isPast = scheduledDate < new Date();
  const canSubmitFeedback = ["completed", "feedback_pending"].includes(interview.status);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 flex flex-col h-full hover:border-[#FF5A1F]/30 transition-colors">
      <div className="space-y-3 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <InterviewStatusBadge status={interview.status} />
              {interview.interview_type && (
                <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
                  {ROUND_LABELS[interview.interview_type] ?? interview.interview_type}
                </span>
              )}
              {interview.meeting_type && (
                <span className="text-[10px] text-gray-400 capitalize">
                  {interview.meeting_type.replace("_", " ")}
                </span>
              )}
            </div>
            {job && (
              <p className="text-xs font-medium text-gray-700">{job.title}</p>
            )}
          </div>
        </div>

        <div className="text-xs text-gray-600 space-y-1">
          <p className="flex items-center gap-1.5">
            <CalendarDays className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            <span className="font-medium">
              {scheduledDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
            </span>
            <span className="text-gray-400">
              {scheduledDate.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </span>
            {interview.duration_minutes && (
              <span className="text-gray-400">· {interview.duration_minutes}m</span>
            )}
          </p>
          {interview.meeting_link && (
            <p>
              <a href={interview.meeting_link} target="_blank" rel="noopener noreferrer"
                className="text-blue-600 hover:underline text-xs">
                Join meeting →
              </a>
            </p>
          )}
        </div>

        {interview.notes && (
          <p className="text-xs text-gray-500 italic border-t border-gray-50 pt-2 line-clamp-2">
            {interview.notes}
          </p>
        )}
      </div>

      <div className="mt-4 pt-3 border-t border-gray-100 flex items-center justify-between gap-2">
        <Link
          href={`/interviews/${interview.id}`}
          className="inline-flex items-center justify-center rounded border border-[#FF5A1F] bg-[#FF5A1F] text-white px-3 py-1.5 text-xs font-medium hover:bg-[#e04e18] transition-colors"
        >
          Open Workspace
        </Link>
        <div className="flex items-center gap-3">
          {canSubmitFeedback && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs border-purple-200 text-purple-700 hover:bg-purple-50"
              onClick={() => setShowFeedback((p) => !p)}
            >
              <MessageSquare className="w-3.5 h-3.5 mr-1" />
              {showFeedback ? "Close" : "Feedback"}
            </Button>
          )}
          {interview.candidate_id && (
            <Link href={`/candidates/${interview.candidate_id}`}
              className="text-xs text-blue-600 hover:underline shrink-0">
              Profile
            </Link>
          )}
        </div>
      </div>

      {showFeedback && (
        <div className="border-t border-gray-100 pt-3 mt-3">
          <InterviewFeedbackForm
            interviewId={interview.id}
            onSubmit={() => {
              setShowFeedback(false);
              onFeedbackSubmit(interview.id);
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function MyInterviewsPage() {
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState("upcoming");

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    else setRefreshing(true);
    try {
      // 1. Fetch interviews and immediately update state
      const ivData = await getMyInterviews({ limit: 100 });
      setInterviews(ivData);
      
      // 2. Stop loading spinner so the UI renders instantly
      setLoading(false);

      // 3. Fetch jobs in the background to populate job titles
      getJobs(50, 0)
        .then((jobsData) => setJobs(jobsData))
        .catch((err) => console.error("Background jobs fetch failed:", err));
        
    } catch (err) {
      console.error("Failed to load interviews:", err);
      setLoading(false);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const upcoming = useMemo(
    () => interviews.filter((i) => ACTIVE_STATUSES.has(i.status)),
    [interviews]
  );
  const past = useMemo(
    () => interviews.filter(
      (i) =>
        i.status !== "feedback_pending" && (
          TERMINAL_STATUSES.has(i.status) ||
          // Catch any unknown statuses that are also time-expired
          (!ACTIVE_STATUSES.has(i.status) && new Date(i.scheduled_at) < new Date())
        )
    ),
    [interviews]
  );
  const feedbackPending = useMemo(
    () => interviews.filter((i) => i.status === "feedback_pending"),
    [interviews]
  );

  const jobMap = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);

  function handleFeedbackSubmit(id: string) {
    setInterviews((prev) =>
      prev.map((i) => i.id === id ? { ...i, status: "feedback_pending" as const } : i)
    );
  }

  const Section = ({
    title,
    icon,
    items,
  }: {
    title: string;
    icon: React.ReactNode;
    items: Interview[];
  }) => {
    if (items.length === 0) return null;
    return (
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2 border-b border-gray-100 pb-2">
          {icon}
          {title}
          <span className="text-gray-400 font-normal">({items.length})</span>
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((i) => (
            <MyInterviewCard
              key={i.id}
              interview={i}
              job={i.job_id ? jobMap.get(i.job_id) : undefined}
              onFeedbackSubmit={handleFeedbackSubmit}
            />
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 flex items-center gap-2">
            <CalendarDays className="w-6 h-6 text-[#FF5A1F]" />
            My Interviews
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {interviews.length} total · {upcoming.length} upcoming · {feedbackPending.length} feedback pending
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

      {/* HORIZONTAL TABS */}
      <div className="border-b border-slate-200 mb-6 px-1">
        <div className="flex gap-6 text-sm overflow-x-auto whitespace-nowrap scrollbar-none -mb-px">
          {[
            { key: "upcoming", label: `Upcoming (${upcoming.length + feedbackPending.length})` },
            { key: "past", label: `Past Interviews (${past.length})` },
          ].map((tab) => (
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

      <div className="transition-all duration-300">
        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-40 rounded-xl bg-gray-100 animate-pulse" />
            ))}
          </div>
        ) : interviews.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
            <CalendarDays className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-500">No interviews assigned to you yet</p>
            <p className="text-xs text-gray-400 mt-1">
              Visit the{" "}
              <Link href="/interviews/queue" className="text-[#FF5A1F] hover:underline">
                interview queue
              </Link>{" "}
              to claim one.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {activeTab === "upcoming" && (
              <>
                {feedbackPending.length > 0 && (
                  <Section
                    title="Feedback Pending"
                    icon={<MessageSquare className="w-4 h-4 text-purple-500" />}
                    items={feedbackPending}
                  />
                )}
                {upcoming.length > 0 ? (
                  <Section
                    title="Upcoming Interviews"
                    icon={<Clock className="w-4 h-4 text-blue-500" />}
                    items={upcoming}
                  />
                ) : (
                  feedbackPending.length === 0 && (
                    <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
                      <Clock className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                      <p className="text-sm text-gray-500">No upcoming interviews</p>
                    </div>
                  )
                )}
              </>
            )}

            {activeTab === "past" && (
              <>
                {past.length > 0 ? (
                  <Section
                    title="Past Interviews"
                    icon={<CheckCircle2 className="w-4 h-4 text-gray-400" />}
                    items={past}
                  />
                ) : (
                  <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
                    <CheckCircle2 className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                    <p className="text-sm text-gray-500">No past interviews found</p>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


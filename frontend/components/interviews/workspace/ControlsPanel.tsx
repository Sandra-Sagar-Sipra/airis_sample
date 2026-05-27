"use client";

import { useEffect, useRef, useState } from "react";
import {
  Play, CheckCircle, XCircle, ClipboardList, Users,
  Bell, CalendarDays, Clock, Lock, Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { InterviewStatusBadge } from "@/components/interviews/InterviewStatusBadge";
import { completeInterview, markNoShow, startInterview } from "@/lib/api/interviews";
import { InterviewRemindersWidget } from "./InterviewRemindersWidget";
import type { Interview, InterviewFeedback, InterviewParticipant } from "@/lib/api/types";

const ROUND_LABELS: Record<string, string> = {
  hr: "HR", technical: "Technical", managerial: "Managerial", final: "Final", ai_screening: "AI Screening",
};

// ── Lifecycle helpers ────────────────────────────────────────────────────────

type LifecyclePhase = "pre" | "active" | "completed" | "evaluated" | "aborted";

function getPhase(status: string): LifecyclePhase {
  if (["cancelled", "no_show"].includes(status)) return "aborted";
  if (status === "feedback_submitted") return "evaluated";
  if (["completed", "feedback_pending"].includes(status)) return "completed";
  if (status === "in_progress") return "active";
  return "pre";
}

const PHASE_STEPS: { phase: LifecyclePhase; label: string }[] = [
  { phase: "pre",       label: "Scheduled" },
  { phase: "active",    label: "In Progress" },
  { phase: "completed", label: "Completed" },
  { phase: "evaluated", label: "Evaluated" },
];

const PHASE_HELPER: Record<LifecyclePhase, { text: string; color: string }> = {
  pre:       { text: "Interview has not started yet. Start it when the candidate joins.", color: "text-blue-600 bg-blue-50 border-blue-200" },
  active:    { text: "Interview is currently active. Complete it to unlock scorecard submission.", color: "text-amber-700 bg-amber-50 border-amber-200" },
  completed: { text: "Interview complete. Submit your evaluation and recommendation below.", color: "text-green-700 bg-green-50 border-green-200" },
  evaluated: { text: "Feedback locked and submitted. Thank you for your evaluation.", color: "text-purple-700 bg-purple-50 border-purple-200" },
  aborted:   { text: "This interview was cancelled or the candidate did not show.", color: "text-gray-600 bg-gray-50 border-gray-200" },
};

// ── Timer ───────────────────────────────────────────────────────────────────

function Timer({ startedAt }: { startedAt: Date }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.getTime()) / 1000)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  const m = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const s = (elapsed % 60).toString().padStart(2, "0");
  return (
    <div className="text-center py-3 bg-gray-50 rounded-xl border border-gray-200">
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Elapsed</p>
      <p className="text-3xl font-mono font-bold text-gray-900 tabular-nums">{m}:{s}</p>
    </div>
  );
}

// ── Workflow progress bar ────────────────────────────────────────────────────

function WorkflowProgress({ phase }: { phase: LifecyclePhase }) {
  if (phase === "aborted") return null;
  const currentIdx = PHASE_STEPS.findIndex((s) => s.phase === phase);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        {PHASE_STEPS.map((step, idx) => {
          const done = idx < currentIdx;
          const active = idx === currentIdx;
          return (
            <div key={step.phase} className="flex items-center flex-1 min-w-0">
              <div className="flex flex-col items-center flex-1 min-w-0">
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold transition-all shrink-0 ${
                    done
                      ? "bg-green-500 text-white"
                      : active
                      ? "bg-[#FF5A1F] text-white ring-2 ring-[#FF5A1F]/30"
                      : "bg-gray-100 text-gray-400 border border-gray-200"
                  }`}
                >
                  {done ? "✓" : idx + 1}
                </div>
                <span
                  className={`text-[9px] mt-0.5 font-medium text-center leading-tight ${
                    active ? "text-[#FF5A1F]" : done ? "text-green-600" : "text-gray-400"
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {idx < PHASE_STEPS.length - 1 && (
                <div className={`h-px flex-1 mx-0.5 mb-3 ${idx < currentIdx ? "bg-green-400" : "bg-gray-200"}`} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function ControlsPanel({
  interview: initialInterview,
  participants,
  onScorecardOpen,
  onInterviewUpdated,
  feedbackList,
  currentUserId,
}: {
  interview: Interview;
  participants: InterviewParticipant[];
  onScorecardOpen: () => void;
  onInterviewUpdated: (iv: Interview) => void;
  feedbackList: InterviewFeedback[];
  currentUserId: string | null;
}) {
  const [interview, setInterview] = useState(initialInterview);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerStartRef = useRef<Date | null>(null);
  const [timerActive, setTimerActive] = useState(false);

  // Sync when parent updates interview (e.g. after workspace reload)
  useEffect(() => { setInterview(initialInterview); }, [initialInterview]);

  const phase = getPhase(interview.status);
  const helper = PHASE_HELPER[phase];
  const scheduledDate = new Date(interview.scheduled_at);

  // Access classification
  const myParticipant = participants.find((p) => p.user_id === currentUserId);
  const isObserver = myParticipant?.participant_role === "observer";
  const isAssignedPanelist = !!myParticipant && !isObserver;
  const hasFeedback = feedbackList.length > 0;

  // Per-phase action visibility
  const canStart   = phase === "pre";
  const canComplete = interview.status === "in_progress";
  const canNoShow  = phase === "pre" || phase === "active";
  const canScorecard = phase === "completed" && isAssignedPanelist && !hasFeedback;
  const scorecardLocked = phase === "pre" || phase === "active";

  async function handleAction(action: "start" | "complete" | "no_show") {
    setLoading(action);
    setError(null);
    try {
      let updated: Interview;
      if (action === "start") {
        updated = await startInterview(interview.id);
        timerStartRef.current = new Date();
        setTimerActive(true);
      } else if (action === "complete") {
        updated = await completeInterview(interview.id);
      } else {
        updated = await markNoShow(interview.id);
      }
      setInterview(updated);
      onInterviewUpdated(updated);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="h-full overflow-y-auto space-y-4 pr-1">

      {/* Workflow progress */}
      <WorkflowProgress phase={phase} />

      {/* Contextual helper */}
      <div className={`text-[11px] leading-snug rounded-lg border px-3 py-2 ${helper.color}`}>
        {helper.text}
      </div>

      {/* Interview meta */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Interview</h3>
          <InterviewStatusBadge status={interview.status} />
        </div>
        <div className="space-y-1.5 text-xs text-gray-600">
          <p className="flex items-center gap-1.5">
            <CalendarDays className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            {scheduledDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
            {" · "}
            {scheduledDate.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </p>
          {interview.duration_minutes && (
            <p className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              {interview.duration_minutes} minutes
            </p>
          )}
          {interview.interview_type && (
            <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
              {ROUND_LABELS[interview.interview_type] ?? interview.interview_type}
            </span>
          )}
        </div>
        {interview.meeting_link && (
          <a
            href={interview.meeting_link}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full text-center text-xs font-medium text-blue-600 hover:text-blue-700 border border-blue-200 rounded-lg py-2 hover:bg-blue-50 transition-colors"
          >
            Join Meeting →
          </a>
        )}
      </div>

      {/* Timer — only visible while active */}
      {(interview.status === "in_progress" || timerActive) && timerStartRef.current && (
        <Timer startedAt={timerStartRef.current} />
      )}

      {/* Lifecycle controls */}
      {phase !== "aborted" && phase !== "evaluated" && (
        <div className="space-y-2">
          {canStart && (
            <Button
              className="w-full bg-[#FF5A1F] hover:bg-[#e04e18] text-white h-9 text-sm gap-2"
              onClick={() => void handleAction("start")}
              disabled={loading !== null}
            >
              <Play className="w-4 h-4" />
              {loading === "start" ? "Starting…" : "Start Interview"}
            </Button>
          )}
          {canComplete && (
            <Button
              className="w-full bg-green-600 hover:bg-green-700 text-white h-9 text-sm gap-2"
              onClick={() => void handleAction("complete")}
              disabled={loading !== null}
            >
              <CheckCircle className="w-4 h-4" />
              {loading === "complete" ? "Completing…" : "Complete Interview"}
            </Button>
          )}
          {canNoShow && (
            <Button
              variant="outline"
              className="w-full h-9 text-sm gap-2 text-red-600 border-red-200 hover:bg-red-50"
              onClick={() => void handleAction("no_show")}
              disabled={loading !== null}
            >
              <XCircle className="w-4 h-4" />
              {loading === "no_show" ? "Marking…" : "Mark No Show"}
            </Button>
          )}
        </div>
      )}

      {/* ── Evaluation zone ── */}
      <div className="rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Evaluation</p>
        </div>
        <div className="p-4 space-y-3">
          {/* Locked state — not yet completed */}
          {scorecardLocked && (
            <div className="flex items-start gap-2 text-xs text-gray-500">
              <Lock className="w-4 h-4 text-gray-300 shrink-0 mt-0.5" />
              <span>Complete the interview to unlock scorecard submission.</span>
            </div>
          )}

          {/* Observer — read-only note */}
          {!scorecardLocked && isObserver && (
            <div className="flex items-start gap-2 text-xs text-gray-500">
              <Eye className="w-4 h-4 text-gray-400 shrink-0 mt-0.5" />
              <span>Observers can view feedback but cannot submit evaluations.</span>
            </div>
          )}

          {/* Scorecard button — only for assigned panelists, only after completion */}
          {canScorecard && (
            <Button
              className="w-full h-9 text-sm gap-2 bg-purple-600 hover:bg-purple-700 text-white"
              onClick={onScorecardOpen}
            >
              <ClipboardList className="w-4 h-4" />
              Submit Scorecard
            </Button>
          )}

          {/* Already submitted */}
          {hasFeedback && (
            <div className="flex items-center gap-2 text-xs text-green-700 bg-green-50 rounded-lg px-3 py-2 border border-green-200">
              <CheckCircle className="w-4 h-4 shrink-0" />
              Scorecard submitted
            </div>
          )}

          {/* Terminal evaluated state */}
          {phase === "evaluated" && !hasFeedback && (
            <div className="flex items-center gap-2 text-xs text-purple-700 bg-purple-50 rounded-lg px-3 py-2 border border-purple-200">
              <CheckCircle className="w-4 h-4 shrink-0" />
              Feedback locked and submitted
            </div>
          )}

          {/* Completed but not a panelist on this interview */}
          {phase === "completed" && !isAssignedPanelist && !isObserver && (
            <div className="flex items-start gap-2 text-xs text-gray-500">
              <Lock className="w-4 h-4 text-gray-300 shrink-0 mt-0.5" />
              <span>Only assigned panelists can submit evaluations.</span>
            </div>
          )}
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 border border-red-200">{error}</p>
      )}

      {/* Reminders (SCHED-006) */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
          <Bell className="w-3.5 h-3.5" />
          Reminders
        </h3>
        <InterviewRemindersWidget interviewId={interview.id} />
      </div>

      {/* Panel roster */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5" />
          Panel ({participants.length})
        </h3>
        {participants.length === 0 ? (
          <p className="text-xs text-gray-400">No panelists added yet.</p>
        ) : (
          <div className="space-y-1.5">
            {participants.map((p) => {
              const isMe = p.user_id === currentUserId;
              return (
                <div key={p.id} className="flex items-center justify-between text-xs">
                  <span className={`font-mono text-[10px] truncate max-w-[100px] ${isMe ? "text-[#FF5A1F] font-semibold" : "text-gray-600"}`}>
                    {isMe ? "You" : `${p.user_id.slice(0, 8)}…`}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full capitalize ${
                    p.participant_role === "lead"
                      ? "bg-blue-100 text-blue-700"
                      : p.participant_role === "observer"
                      ? "bg-gray-100 text-gray-500"
                      : "bg-slate-100 text-slate-600"
                  }`}>
                    {p.participant_role}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, AlertCircle } from "lucide-react";
import Link from "next/link";
import { getWorkspace, startInterview } from "@/lib/api/interviews";
import { CandidateContextPanel } from "@/components/interviews/workspace/CandidateContextPanel";
import { MeetingContainer } from "@/components/interviews/workspace/MeetingContainer";
import { WorkspaceRightPanel } from "@/components/interviews/workspace/WorkspaceRightPanel";
import { ScorecardModal } from "@/components/interviews/workspace/ScorecardModal";
import { InterviewStatusBadge } from "@/components/interviews/InterviewStatusBadge";
import { useAuthStore } from "@/store/auth-store";
import { LiveKitProvider } from "@/contexts/LiveKitContext";
import type { Interview, InterviewFeedback, WorkspaceData } from "@/lib/api/types";

const PRE_INTERVIEW_STATUSES = new Set([
  "scheduled",
  "pending_panel",
  "panel_confirmed",
  "confirmed",
]);

export default function InterviewWorkspacePage() {
  const params = useParams();
  const interviewId = params.interviewId as string;
  const currentUserId = useAuthStore((state) => state.userId);

  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showScorecard, setShowScorecard] = useState(false);
  const [feedbackList, setFeedbackList] = useState<InterviewFeedback[]>([]);
  const [interview, setInterview] = useState<Interview | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getWorkspace(interviewId);
      setWorkspace(data);
      setInterview(data.interview);
      setFeedbackList([]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load workspace.");
    } finally {
      setLoading(false);
    }
  }, [interviewId]);

  useEffect(() => { void load(); }, [load]);

  const handleInterviewUpdated = useCallback((updated: Interview) => {
    setInterview(updated);
    setWorkspace((prev) => prev ? { ...prev, interview: updated } : prev);
  }, []);

  const handleFeedbackSubmitted = useCallback((feedback: InterviewFeedback) => {
    setFeedbackList((prev) => [...prev, feedback]);
    setShowScorecard(false);
  }, []);

  // Called by MeetingContainer when the user joins the meeting.
  // Auto-transitions the interview to in_progress if still in a pre-start status.
  const handleMeetingStarted = useCallback(async () => {
    if (!interview) return;
    if (!PRE_INTERVIEW_STATUSES.has(interview.status)) return;
    try {
      const updated = await startInterview(interviewId);
      handleInterviewUpdated(updated);
    } catch {
      // Non-fatal: status transition may already have happened or be unauthorized.
    }
  }, [interview, interviewId, handleInterviewUpdated]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="space-y-3 text-center">
          <div className="w-8 h-8 rounded-full border-2 border-[#FF5A1F] border-t-transparent animate-spin mx-auto" />
          <p className="text-sm text-gray-500">Loading workspace…</p>
        </div>
      </div>
    );
  }

  if (error || !workspace || !interview) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center space-y-3">
          <AlertCircle className="w-10 h-10 text-red-400 mx-auto" />
          <p className="text-sm font-medium text-gray-700">{error ?? "Interview not found."}</p>
          <Link href="/interviews/my" className="text-xs text-[#FF5A1F] hover:underline">
            ← Back to My Interviews
          </Link>
        </div>
      </div>
    );
  }

  const candidateName = workspace.candidate
    ? `${workspace.candidate.first_name} ${workspace.candidate.last_name}`
    : "Interview";

  return (
    // LiveKitProvider shares the Room instance between LiveKitRoom.tsx (center
    // panel) and TranscriptPanel.tsx (right panel) without props drilling.
    // The context holds a MutableRef — no re-renders triggered on room change.
    <LiveKitProvider>
      {/* Full-height 3-panel layout */}
      <div className="flex flex-col h-full -m-4 sm:-m-6 lg:-m-8">
        {/* Topbar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 bg-white shrink-0">
          <Link
            href="/interviews/my"
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            My Interviews
          </Link>
          <span className="text-gray-300">/</span>
          <span className="text-sm font-semibold text-gray-900">{candidateName}</span>
          {workspace.job_title && (
            <span className="text-xs text-gray-400">· {workspace.job_title}</span>
          )}
          <div className="ml-auto">
            <InterviewStatusBadge status={interview.status} />
          </div>
        </div>

        {/* 3-panel body */}
        <div className="flex flex-1 min-h-0">
          {/* Left — Candidate Context (260px) */}
          <aside className="w-64 shrink-0 border-r border-gray-200 bg-gray-50 overflow-y-auto">
            <div className="p-4">
              <CandidateContextPanel
                candidate={workspace.candidate}
                jobTitle={workspace.job_title}
                feedbackSummary={workspace.feedback_summary}
              />
            </div>
          </aside>

          {/* Center — Meeting area (flex-1) */}
          <main className="flex-1 min-w-0 overflow-hidden bg-gray-50">
            <MeetingContainer
              interviewId={interviewId}
              meetingUrl={interview.meeting_link}
              interviewStatus={interview.status}
              onMeetingStarted={handleMeetingStarted}
            />
          </main>

          {/* Right — Notes + Controls tabbed panel (320px) */}
          <aside className="w-80 shrink-0 border-l border-gray-200 bg-white overflow-hidden">
            <WorkspaceRightPanel
              interviewId={interviewId}
              interview={interview}
              participants={workspace.participants}
              feedbackList={feedbackList}
              initialNotes={workspace.notes}
              currentUserId={currentUserId}
              onScorecardOpen={() => setShowScorecard(true)}
              onInterviewUpdated={handleInterviewUpdated}
              jobTitle={workspace.job_title}
            />
          </aside>
        </div>
      </div>

      {showScorecard && (
        <ScorecardModal
          interviewId={interviewId}
          onClose={() => setShowScorecard(false)}
          onSubmitted={handleFeedbackSubmitted}
        />
      )}
    </LiveKitProvider>
  );
}

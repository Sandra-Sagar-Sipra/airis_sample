"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, AlertCircle, PanelRightClose, PanelRightOpen, MessageSquareText, ChevronsLeft, User } from "lucide-react";
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
  
  // Floating Layout State
  const [isPanelFloating, setIsPanelFloating] = useState(false);
  const [isFloatingPanelOpen, setIsFloatingPanelOpen] = useState(false);

  // Candidate Panel State
  const [isCandidatePanelOpen, setIsCandidatePanelOpen] = useState(false);

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
      <div className="flex flex-col h-[calc(100vh-64px)] -m-4 sm:-m-6 lg:-m-8">
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
          <div className="ml-auto flex items-center gap-3">
            <button
              onClick={() => {
                if (isPanelFloating) {
                  // Switch back to docked
                  setIsPanelFloating(false);
                  setIsFloatingPanelOpen(false);
                } else {
                  // Switch to floating
                  setIsPanelFloating(true);
                  setIsFloatingPanelOpen(true);
                }
              }}
              className="flex items-center justify-center p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
              title={isPanelFloating ? "Dock Panel" : "Float Panel"}
            >
              {isPanelFloating ? <PanelRightClose className="w-5 h-5" /> : <PanelRightOpen className="w-5 h-5" />}
            </button>
            <InterviewStatusBadge status={interview.status} />
          </div>
        </div>

        {/* 3-panel body */}
        <div className="flex flex-1 min-h-0 relative">
          {/* Left — Candidate Context */}
          <aside className={`shrink-0 border-r border-gray-200 bg-gray-50 overflow-y-auto transition-all duration-300 ${isCandidatePanelOpen ? "w-64" : "w-16"}`}>
            {isCandidatePanelOpen ? (
              <div className="p-4 flex flex-col h-full">
                <div className="flex items-center justify-between mb-4 shrink-0">
                  <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5" />
                    Candidate Details
                  </h2>
                  <button 
                    onClick={() => setIsCandidatePanelOpen(false)} 
                    className="p-1 text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded transition-colors"
                    title="Collapse Details"
                  >
                    <ChevronsLeft className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  <CandidateContextPanel
                    candidate={workspace.candidate}
                    jobTitle={workspace.job_title}
                    feedbackSummary={workspace.feedback_summary}
                  />
                </div>
              </div>
            ) : (
              <div className="p-3 flex flex-col items-center mt-2">
                <button 
                  onClick={() => setIsCandidatePanelOpen(true)}
                  className="p-2.5 rounded-xl bg-white border border-orange-200 text-[#FF5A1F] hover:bg-orange-50 shadow-sm transition-colors"
                  title="Expand Candidate Details"
                >
                  <User className="w-5 h-5" />
                </button>
              </div>
            )}
          </aside>

          {/* Center — Meeting area (flex-1) */}
          <main className="flex-1 min-w-0 overflow-hidden bg-gray-50 relative">
            <MeetingContainer
              interviewId={interviewId}
              meetingUrl={interview.meeting_link}
              interviewStatus={interview.status}
              onMeetingStarted={handleMeetingStarted}
            />

            {/* Floating Toggle Button (Visible only when floating and closed) */}
            {isPanelFloating && !isFloatingPanelOpen && (
              <button
                onClick={() => setIsFloatingPanelOpen(true)}
                className="absolute top-4 right-4 z-40 flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 shadow-lg rounded-full text-sm font-medium text-gray-700 hover:bg-gray-50 hover:shadow-xl transition-all"
              >
                <MessageSquareText className="w-4 h-4 text-[#FF5A1F]" />
                Open Tools
              </button>
            )}
          </main>

          {/* Right — Notes + Controls tabbed panel */}
          {!isPanelFloating ? (
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
          ) : (
            isFloatingPanelOpen && (
              <aside className="absolute top-4 right-4 bottom-4 w-80 z-50 bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden flex flex-col">
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
                  onCloseFloating={() => setIsFloatingPanelOpen(false)}
                />
              </aside>
            )
          )}
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

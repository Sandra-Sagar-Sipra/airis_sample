"use client";

import { useState } from "react";
import { ClipboardList, FileText, ListChecks, MessageSquareText, Settings2 } from "lucide-react";
import { NotesPanel } from "./NotesPanel";
import { ControlsPanel } from "./ControlsPanel";
import { InterviewQuestionsPanel } from "./InterviewQuestionsPanel";
import { AISummaryPanel } from "./AISummaryPanel";
import { TranscriptPanel } from "./TranscriptPanel";
import type { Interview, InterviewFeedback, InterviewNote, InterviewParticipant } from "@/lib/api/types";

type Tab = "transcript" | "notes" | "questions" | "summary" | "controls";

export function WorkspaceRightPanel({
  interviewId,
  interview,
  participants,
  feedbackList,
  initialNotes,
  currentUserId,
  onScorecardOpen,
  onInterviewUpdated,
  jobTitle,
}: {
  interviewId: string;
  interview: Interview;
  participants: InterviewParticipant[];
  feedbackList: InterviewFeedback[];
  initialNotes: InterviewNote[];
  currentUserId: string | null;
  onScorecardOpen: () => void;
  onInterviewUpdated: (updated: Interview) => void;
  /** Job title from the workspace — passed to the Questions panel. */
  jobTitle?: string | null;
}) {
  // Transcript is the primary live tool — open it first.
  const [activeTab, setActiveTab] = useState<Tab>("transcript");

  const tabClass = (tab: Tab) =>
    `flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${
      activeTab === tab
        ? "border-[#FF5A1F] text-[#FF5A1F]"
        : "border-transparent text-gray-500 hover:text-gray-800"
    }`;

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar — order: Transcript | Notes | Questions | Summary | Controls */}
      <div className="flex shrink-0 border-b border-gray-200 bg-white overflow-x-auto">
        <button onClick={() => setActiveTab("transcript")} className={tabClass("transcript")}>
          <MessageSquareText className="w-3.5 h-3.5" />
          Transcript
        </button>
        <button onClick={() => setActiveTab("notes")} className={tabClass("notes")}>
          <ClipboardList className="w-3.5 h-3.5" />
          Notes
        </button>
        <button onClick={() => setActiveTab("questions")} className={tabClass("questions")}>
          <ListChecks className="w-3.5 h-3.5" />
          Questions
        </button>
        <button onClick={() => setActiveTab("summary")} className={tabClass("summary")}>
          <FileText className="w-3.5 h-3.5" />
          Summary
        </button>
        <button onClick={() => setActiveTab("controls")} className={tabClass("controls")}>
          <Settings2 className="w-3.5 h-3.5" />
          Controls
        </button>
      </div>

      {/* Panel content — flex column so each active tab gets a proper
          flex-1 height and inner overflow-y-auto actually scrolls. */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className={activeTab === "transcript" ? "flex-1 min-h-0 overflow-hidden" : "hidden"}>
          <TranscriptPanel interviewId={interviewId} />
        </div>
        <div className={activeTab === "notes" ? "flex-1 min-h-0 p-4 overflow-y-auto" : "hidden"}>
          <NotesPanel interviewId={interviewId} initialNotes={initialNotes} />
        </div>
        <div className={activeTab === "questions" ? "flex-1 min-h-0 overflow-hidden" : "hidden"}>
          <InterviewQuestionsPanel
            jobId={interview.job_id ?? null}
            jobTitle={jobTitle ?? null}
          />
        </div>
        <div className={activeTab === "summary" ? "flex-1 min-h-0 overflow-hidden" : "hidden"}>
          <AISummaryPanel interviewId={interviewId} interviewStatus={interview.status} />
        </div>
        <div className={activeTab === "controls" ? "flex-1 min-h-0 p-4 overflow-y-auto" : "hidden"}>
          <ControlsPanel
            interview={interview}
            participants={participants}
            feedbackList={feedbackList}
            currentUserId={currentUserId}
            onScorecardOpen={onScorecardOpen}
            onInterviewUpdated={onInterviewUpdated}
          />
        </div>
      </div>
    </div>
  );
}

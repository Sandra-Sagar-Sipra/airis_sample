"use client";

import { useState } from "react";
import {
  Calendar, Clock, MapPin, Link2, User, MessageSquare,
  Trash2, ChevronDown, ChevronUp, Users, Play, Video, Phone, Building2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { InterviewStatusBadge } from "@/components/interviews/InterviewStatusBadge";
import { InterviewFeedbackForm } from "@/components/interviews/InterviewFeedbackForm";
import type { Interview, InterviewFeedback, InterviewParticipant, InterviewStatus, MeetingType } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const TYPE_LABELS: Record<string, string> = {
  hr: "HR", technical: "Technical", managerial: "Managerial", final: "Final", ai_screening: "AI Screening",
};

const MEETING_TYPE_CONFIG: Record<MeetingType, { icon: React.ReactNode; label: string }> = {
  virtual:   { icon: <Video className="w-3 h-3" />,     label: "Virtual" },
  in_person: { icon: <Building2 className="w-3 h-3" />, label: "In Person" },
  phone:     { icon: <Phone className="w-3 h-3" />,     label: "Phone" },
  hybrid:    { icon: <Video className="w-3 h-3" />,     label: "Hybrid" },
};

const ROLE_LABELS: Record<string, string> = {
  lead: "Lead", panel: "Panel", observer: "Observer", hiring_manager: "Hiring Mgr",
};

const TERMINAL_STATUSES = new Set(["completed", "cancelled", "no_show", "feedback_submitted"]);

interface Props {
  interview: Interview;
  feedback?: InterviewFeedback[];
  participants?: InterviewParticipant[];
  onStatusChange?: (id: string, status: InterviewStatus) => void;
  onDelete?: (id: string) => void;
  onFeedbackSubmit?: (interviewId: string) => void;
  onClaim?: (interviewId: string) => void;
  canUpdate?: boolean;
  canDelete?: boolean;
  canFeedback?: boolean;
  canClaim?: boolean;
  currentUserId?: string;
}

export function InterviewCard({
  interview,
  feedback = [],
  participants = [],
  onStatusChange,
  onDelete,
  onFeedbackSubmit,
  onClaim,
  canUpdate = false,
  canDelete = false,
  canFeedback = false,
  canClaim = false,
  currentUserId,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [claiming, setClaiming] = useState(false);

  const isTerminal = TERMINAL_STATUSES.has(interview.status);
  const scheduledDate = new Date(interview.scheduled_at);
  const isPast = scheduledDate < new Date();

  const alreadyClaimed = currentUserId
    ? participants.some((p) => p.user_id === currentUserId && p.status !== "declined")
    : false;

  const acceptedParticipants = participants.filter((p) => p.status === "accepted");

  const meetingTypeCfg = interview.meeting_type
    ? MEETING_TYPE_CONFIG[interview.meeting_type as MeetingType]
    : null;

  async function handleDelete() {
    if (!onDelete) return;
    setDeleting(true);
    try { onDelete(interview.id); } finally { setDeleting(false); }
  }

  async function handleClaim() {
    if (!onClaim) return;
    setClaiming(true);
    try { await onClaim(interview.id); } finally { setClaiming(false); }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden hover:border-[#FF5A1F]/30 transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between p-4">
        <div className="flex-1 min-w-0 pr-3">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <InterviewStatusBadge status={interview.status} />
            {interview.interview_type && (
              <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
                {TYPE_LABELS[interview.interview_type] ?? interview.interview_type}
              </span>
            )}
            {meetingTypeCfg && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-200">
                {meetingTypeCfg.icon}
                {meetingTypeCfg.label}
              </span>
            )}
          </div>

          <div className="space-y-1.5 text-xs text-gray-600">
            <p className="flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              <span className={cn("font-medium", isPast && !isTerminal ? "text-orange-600" : "text-gray-800")}>
                {scheduledDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
              </span>
              <span className="text-gray-500">
                {scheduledDate.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </span>
            </p>

            {interview.duration_minutes && (
              <p className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                {interview.duration_minutes} min
              </p>
            )}

            {interview.interviewer_name && (
              <p className="flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                {interview.interviewer_name}
              </p>
            )}

            {interview.location && (
              <p className="flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                {interview.location}
              </p>
            )}

            {interview.meeting_link && (
              <p className="flex items-center gap-1.5">
                <Link2 className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                <a href={interview.meeting_link} target="_blank" rel="noopener noreferrer"
                  className="text-blue-600 hover:underline truncate max-w-[200px]">
                  Join meeting
                </a>
              </p>
            )}

            {/* Participants summary */}
            {acceptedParticipants.length > 0 && (
              <p className="flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                <span className="text-gray-600">
                  {acceptedParticipants.length} panelist{acceptedParticipants.length !== 1 ? "s" : ""} confirmed
                </span>
              </p>
            )}

            {interview.notes && (
              <p className="flex items-start gap-1.5">
                <MessageSquare className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
                <span className="text-gray-600 line-clamp-2">{interview.notes}</span>
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {canDelete && !isTerminal && (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-gray-400 hover:text-red-500 hover:bg-red-50"
              onClick={handleDelete} disabled={deleting}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-gray-400 hover:text-gray-700"
            onClick={() => setExpanded((p) => !p)}>
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </Button>
        </div>
      </div>

      {/* Claim button for pending_panel interviews */}
      {canClaim && !alreadyClaimed && interview.status === "pending_panel" && (
        <div className="px-4 pb-3">
          <Button
            size="sm"
            className="h-7 text-xs bg-[#FF5A1F] hover:bg-orange-600 text-white w-full"
            onClick={handleClaim}
            disabled={claiming}
          >
            <Play className="w-3.5 h-3.5 mr-1" />
            {claiming ? "Claiming…" : "Take Interview"}
          </Button>
        </div>
      )}

      {/* Status action buttons */}
      {canUpdate && !isTerminal && (
        <div className="px-4 pb-3 flex gap-2 flex-wrap">
          {(interview.status === "pending_panel" || interview.status === "scheduled") && (
            <Button variant="outline" size="sm" className="h-7 text-xs border-indigo-200 text-indigo-700 hover:bg-indigo-50"
              onClick={() => onStatusChange?.(interview.id, "panel_confirmed")}>
              Mark Panel Ready
            </Button>
          )}
          {interview.status === "panel_confirmed" && (
            <Button variant="outline" size="sm" className="h-7 text-xs border-violet-200 text-violet-700 hover:bg-violet-50"
              onClick={() => onStatusChange?.(interview.id, "in_progress")}>
              Start Interview
            </Button>
          )}
          {(interview.status === "scheduled" || interview.status === "confirmed") && (
            <Button variant="outline" size="sm" className="h-7 text-xs border-indigo-200 text-indigo-700 hover:bg-indigo-50"
              onClick={() => onStatusChange?.(interview.id, "confirmed")}>
              Confirm
            </Button>
          )}
          {["scheduled", "confirmed", "panel_confirmed", "in_progress"].includes(interview.status) && (
            <>
              <Button variant="outline" size="sm" className="h-7 text-xs border-green-200 text-green-700 hover:bg-green-50"
                onClick={() => onStatusChange?.(interview.id, "completed")}>
                Mark Complete
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs border-red-200 text-red-700 hover:bg-red-50"
                onClick={() => onStatusChange?.(interview.id, "cancelled")}>
                Cancel
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs border-orange-200 text-orange-700 hover:bg-orange-50"
                onClick={() => onStatusChange?.(interview.id, "no_show")}>
                No Show
              </Button>
            </>
          )}
        </div>
      )}

      {/* Expanded section */}
      {expanded && (
        <div className="border-t border-gray-100 px-4 py-4 bg-gray-50/40 space-y-4">
          {/* Participants panel */}
          {participants.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Panel</p>
              <div className="space-y-1.5">
                {participants.map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded-lg bg-white border border-gray-200 px-3 py-2">
                    <div className="flex items-center gap-2 text-xs">
                      <User className="w-3 h-3 text-gray-400" />
                      <span className="text-gray-700 font-mono text-[10px]">{p.user_id.slice(0, 8)}…</span>
                      <span className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded font-medium",
                        p.participant_role === "lead" ? "bg-orange-100 text-orange-700" : "bg-gray-100 text-gray-600"
                      )}>
                        {ROLE_LABELS[p.participant_role] ?? p.participant_role}
                      </span>
                    </div>
                    <span className={cn(
                      "text-[10px] font-medium",
                      p.status === "accepted" ? "text-green-600" : p.status === "declined" ? "text-red-500" : "text-gray-400"
                    )}>
                      {p.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Feedback */}
          {feedback.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Feedback</p>
              <div className="space-y-3">
                {feedback.map((fb) => (
                  <div key={fb.id} className="rounded-lg bg-white border border-gray-200 p-3 text-xs space-y-1.5">
                    {fb.recommendation && (
                      <p className="font-semibold text-gray-700 capitalize">
                        {fb.recommendation.replace(/_/g, " ")}
                      </p>
                    )}
                    {(fb.technical_score || fb.communication_score || fb.problem_solving_score || fb.culture_fit_score) && (
                      <div className="grid grid-cols-2 gap-1 text-[10px] text-gray-500">
                        {fb.technical_score && <span>Technical: <b className="text-gray-700">{fb.technical_score}/5</b></span>}
                        {fb.communication_score && <span>Communication: <b className="text-gray-700">{fb.communication_score}/5</b></span>}
                        {fb.problem_solving_score && <span>Problem Solving: <b className="text-gray-700">{fb.problem_solving_score}/5</b></span>}
                        {fb.culture_fit_score && <span>Culture Fit: <b className="text-gray-700">{fb.culture_fit_score}/5</b></span>}
                      </div>
                    )}
                    {fb.rating !== null && (
                      <p className="text-gray-600">Overall: <span className="text-[#FF5A1F] font-medium">{fb.rating}/5</span></p>
                    )}
                    {fb.strengths && <p className="text-gray-600"><span className="font-medium">+</span> {fb.strengths}</p>}
                    {fb.weaknesses && <p className="text-gray-600"><span className="font-medium">−</span> {fb.weaknesses}</p>}
                    {fb.notes && <p className="text-gray-500 italic">{fb.notes}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {canFeedback && !isTerminal && (
            <InterviewFeedbackForm
              interviewId={interview.id}
              onSubmit={() => onFeedbackSubmit?.(interview.id)}
            />
          )}
        </div>
      )}
    </div>
  );
}

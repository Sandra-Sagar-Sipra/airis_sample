"use client";

/**
 * SendAIScreeningModal
 *
 * Recruiter modal to configure and send an AI Screening interview invite.
 * Creates a secure token-based interview session and emails the candidate
 * a link to /interview/<token> — no candidate login required.
 */

import { useState } from "react";
import {
  Brain,
  Send,
  Loader2,
  CheckCircle2,
  Copy,
  Calendar,
  Clock,
  MessageSquare,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  sendAIScreeningInvite,
  type SendAIScreeningInviteResponse,
} from "@/lib/api/ai_screening";
import { cn } from "@/lib/utils";

interface Props {
  candidateId: string;
  candidateName: string;
  candidateEmail: string;
  jobId?: string | null;
  jobTitle?: string | null;
  pipelineId?: string | null;
  onClose: () => void;
  onSent?: (response: SendAIScreeningInviteResponse) => void;
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  // Format as datetime-local value: YYYY-MM-DDTHH:mm
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function SendAIScreeningModal({
  candidateId,
  candidateName,
  candidateEmail,
  jobId,
  jobTitle,
  pipelineId,
  onClose,
  onSent,
}: Props) {
  const [expiryDate, setExpiryDate] = useState(addDays(7));
  const [maxQuestions, setMaxQuestions] = useState(12);
  const [durationMinutes, setDurationMinutes] = useState(20);
  const [customInstructions, setCustomInstructions] = useState("");

  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendAIScreeningInviteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleSend = async () => {
    setSending(true);
    setError(null);
    try {
      const res = await sendAIScreeningInvite({
        candidate_id: candidateId,
        job_id: jobId ?? null,
        pipeline_id: pipelineId ?? null,
        expires_at: expiryDate ? new Date(expiryDate).toISOString() : null,
        max_questions: maxQuestions,
        interview_duration_minutes: durationMinutes,
        custom_instructions: customInstructions || null,
      });
      setResult(res);
      onSent?.(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to send invite");
    } finally {
      setSending(false);
    }
  };

  const copyLink = () => {
    if (!result?.interview_url) return;
    navigator.clipboard.writeText(result.interview_url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const firstName = candidateName.split(" ")[0] || candidateName;

  // ── Success state ────────────────────────────────────────────────────────────
  if (result) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <Card className="w-full max-w-md bg-white">
          <CardContent className="p-6 space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                <span className="font-semibold text-slate-900">Invite Sent</span>
              </div>
              <button
                onClick={onClose}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-sm text-slate-600">
              {result.invitation_sent
                ? `An email has been sent to ${result.candidate_email} with the interview link.`
                : `Session created. Email delivery may be delayed — share the link below directly.`}
            </p>

            <div className="bg-slate-50 rounded-lg p-3 space-y-2">
              <p className="text-xs text-slate-500 font-medium">Interview Link</p>
              <div className="flex items-center gap-2">
                <p className="text-xs text-slate-700 font-mono truncate flex-1">
                  {result.interview_url}
                </p>
                <button
                  onClick={copyLink}
                  className="shrink-0 text-orange-500 hover:text-orange-600"
                  title="Copy link"
                >
                  {copied ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            {result.expires_at && (
              <p className="text-xs text-slate-500">
                Expires:{" "}
                {new Date(result.expires_at).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </p>
            )}

            <Button className="w-full" onClick={onClose}>
              Done
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Config state ─────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-lg bg-white">
        <CardContent className="p-6 space-y-5">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-orange-100 flex items-center justify-center">
                <Brain className="h-4 w-4 text-orange-600" />
              </div>
              <div>
                <h2 className="font-semibold text-slate-900 text-base">
                  Send AI Screening
                </h2>
                <p className="text-xs text-slate-500">Candidate self-service interview</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Candidate info */}
          <div className="bg-slate-50 rounded-lg p-3 flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-orange-500 flex items-center justify-center text-white font-semibold text-sm shrink-0">
              {firstName[0]?.toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-900 truncate">
                {candidateName}
              </p>
              <p className="text-xs text-slate-500 truncate">{candidateEmail}</p>
            </div>
            {jobTitle && (
              <Badge className="ml-auto shrink-0 bg-slate-100 text-slate-600 border-0 text-xs">
                {jobTitle}
              </Badge>
            )}
          </div>

          {/* Config fields */}
          <div className="space-y-4">
            {/* Expiry date */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-700 flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5 text-slate-400" />
                Expiry date &amp; time
              </label>
              <Input
                type="datetime-local"
                value={expiryDate}
                min={addDays(0)}
                onChange={(e) => setExpiryDate(e.target.value)}
                className="text-sm"
              />
              <p className="text-xs text-slate-400">
                Candidate cannot start after this time.
              </p>
            </div>

            {/* Duration + Questions side by side */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700 flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-slate-400" />
                  Duration (minutes)
                </label>
                <Input
                  type="number"
                  min={10}
                  max={60}
                  value={durationMinutes}
                  onChange={(e) =>
                    setDurationMinutes(Math.max(10, Math.min(60, Number(e.target.value))))
                  }
                  className="text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700 flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5 text-slate-400" />
                  Max questions
                </label>
                <Input
                  type="number"
                  min={5}
                  max={20}
                  value={maxQuestions}
                  onChange={(e) =>
                    setMaxQuestions(Math.max(5, Math.min(20, Number(e.target.value))))
                  }
                  className="text-sm"
                />
              </div>
            </div>

            {/* Custom instructions */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-700">
                Custom instructions{" "}
                <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <textarea
                className="w-full min-h-[80px] rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-orange-500 placeholder:text-slate-400"
                placeholder="e.g. Focus on leadership experience. Ask about remote work preferences."
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                maxLength={500}
              />
              <p className="text-xs text-slate-400">
                These will guide the AI&apos;s question selection.
              </p>
            </div>
          </div>

          {/* Info banner */}
          <div className="bg-blue-50 rounded-lg p-3 text-xs text-blue-700 space-y-1">
            <p className="font-medium">What happens next:</p>
            <ul className="space-y-0.5 list-disc list-inside text-blue-600">
              <li>{firstName} receives an email with a secure interview link</li>
              <li>They complete the video interview at their own pace</li>
              <li>AI generates scores, transcript and summary automatically</li>
              <li>You review results in the AI Screenings dashboard</li>
            </ul>
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg p-3">{error}</p>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <Button
              variant="outline"
              className="flex-1"
              onClick={onClose}
              disabled={sending}
            >
              Cancel
            </Button>
            <Button
              className={cn(
                "flex-1 gap-2",
                sending
                  ? "bg-orange-400 cursor-not-allowed"
                  : "bg-orange-500 hover:bg-orange-600"
              )}
              onClick={handleSend}
              disabled={sending}
            >
              {sending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Sending…
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  Send Invite
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

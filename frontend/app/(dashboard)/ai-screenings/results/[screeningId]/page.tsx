"use client";

/**
 * Recruiter — AI Screening Results
 *
 * RECRUITER-ONLY. Guarded by permission checks.
 * Candidates must NEVER reach this page.
 *
 * Displays the full AI evaluation for a completed live screening:
 *   • AI recommendation + all dimension scores
 *   • Strengths and concerns with evidence
 *   • Full conversation transcript
 *   • Per-question answer segments with inline video players
 *   • Recruiter notes and decision actions
 *
 * Pipeline rules enforced here (not automatically):
 *   Advance  → moves candidate to Interview stage
 *   Reject   → moves candidate to Rejected
 *   Hold     → candidate stays in AI Interview, decision recorded
 */

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, Brain, Briefcase, CheckCircle2, ChevronDown,
  ChevronUp, Clock, Loader2, MessageSquare, ThumbsDown,
  ThumbsUp, User, XCircle, AlertCircle, Play, FileText,
  Pause,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getLiveInterview,
  getScreeningSegments,
  getScreeningRecordings,
  submitReviewDecision,
  type LiveInterview,
  type ScreeningSegment,
  type ScreeningRecordings,
} from "@/lib/api/ai_screening";
import { cn } from "@/lib/utils";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const REC_CONFIG: Record<string, { label: string; badge: string }> = {
  strong_hire:  { label: "Strong Hire",  badge: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  hire:         { label: "Hire",         badge: "bg-blue-100    text-blue-800    border-blue-300" },
  consider:     { label: "Consider",     badge: "bg-amber-100   text-amber-800   border-amber-300" },
  reject:       { label: "Reject",       badge: "bg-red-100     text-red-800     border-red-300" },
};

function ScoreBar({ label, value }: { label: string; value: number | null | undefined }) {
  if (value == null) return null;
  const color = value >= 75 ? "bg-emerald-500" : value >= 55 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-slate-600">{label}</span>
        <span className="font-semibold text-slate-800">{Math.round(value)}</span>
      </div>
      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

// ── Inline video+audio player pair ───────────────────────────────────────────

function MediaPlayers({ url, label }: { url: string; label: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [videoPlaying, setVideoPlaying] = useState(false);

  const toggleVideo = () => {
    const v = videoRef.current;
    if (!v) return;
    if (videoPlaying) { v.pause(); setVideoPlaying(false); }
    else { v.play().then(() => setVideoPlaying(true)).catch(() => {}); }
  };

  return (
    <div className="space-y-3">
      {/* Video */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
          <Play className="h-3 w-3" />▶ Play Video Answer
        </p>
        <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
          <video
            ref={videoRef}
            src={url}
            className="w-full h-full object-contain"
            playsInline
            preload="metadata"
            onEnded={() => setVideoPlaying(false)}
          />
          <button
            onClick={toggleVideo}
            className="absolute inset-0 flex items-center justify-center group"
            aria-label={videoPlaying ? `Pause ${label}` : `Play ${label} video`}
          >
            <div className="w-12 h-12 rounded-full bg-black/50 flex items-center justify-center group-hover:bg-black/70 transition-colors">
              {videoPlaying
                ? <Pause className="h-5 w-5 text-white" />
                : <Play className="h-5 w-5 text-white ml-0.5" />}
            </div>
          </button>
        </div>
      </div>

      {/* Audio */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
          <MessageSquare className="h-3 w-3" />▶ Play Audio Answer
        </p>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio
          ref={audioRef}
          src={url}
          controls
          preload="metadata"
          className="w-full h-9"
          aria-label={`${label} audio`}
        />
      </div>
    </div>
  );
}

// ── Per-question segment card ─────────────────────────────────────────────────

function SegmentCard({ seg, index }: { seg: ScreeningSegment; index: number }) {
  const [open, setOpen] = useState(index === 0);

  return (
    <Card className="border-slate-200">
      {/* ── Header (always visible) ── */}
      <button
        className="w-full px-5 py-4 flex items-center gap-3 text-left hover:bg-slate-50 transition-colors"
        onClick={() => setOpen((p) => !p)}
      >
        <span className="w-7 h-7 rounded-full bg-orange-100 text-orange-700 text-xs font-bold flex items-center justify-center shrink-0">
          {seg.question_number}
        </span>
        <p className="flex-1 text-sm font-medium text-slate-800 line-clamp-2">{seg.question_text}</p>
        <div className="flex items-center gap-3 shrink-0">
          {seg.duration_seconds != null && (
            <span className="text-xs text-slate-400 flex items-center gap-1">
              <Clock className="h-3 w-3" />{fmtDuration(seg.duration_seconds)}
            </span>
          )}
          {seg.transcript && (
            <span className="text-xs text-emerald-600 flex items-center gap-1">
              <MessageSquare className="h-3 w-3" />Answered
            </span>
          )}
          {seg.video_clip_url && (
            <span className="text-xs text-blue-600 flex items-center gap-1">
              <Play className="h-3 w-3" />Recording
            </span>
          )}
          {open ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
        </div>
      </button>

      {/* ── Body ── */}
      {open && (
        <div className="border-t border-slate-100 p-5 space-y-5">
          {/* Transcript */}
          <div className="space-y-1">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Transcript</p>
            {seg.transcript
              ? <p className="text-sm text-slate-700 leading-relaxed">{seg.transcript}</p>
              : <p className="text-sm text-slate-400 italic">No transcript recorded for this answer.</p>
            }
          </div>

          {/* Timing */}
          <div className="flex flex-wrap gap-4 text-xs text-slate-400">
            {seg.question_start_seconds != null && (
              <span>Question at {fmtDuration(seg.question_start_seconds)}</span>
            )}
            {seg.answer_start_seconds != null && (
              <span>Answer started at {fmtDuration(seg.answer_start_seconds)}</span>
            )}
            {seg.duration_seconds != null && (
              <span className="font-medium text-slate-600">
                Duration: {fmtDuration(seg.duration_seconds)}
              </span>
            )}
          </div>

          {/* Video + audio players */}
          {seg.video_clip_url ? (
            <MediaPlayers url={seg.video_clip_url} label={`Question ${seg.question_number}`} />
          ) : (
            <p className="text-xs text-slate-400 bg-slate-50 rounded px-3 py-2 flex items-center gap-2">
              <Play className="h-3.5 w-3.5" />No recording clip for this answer.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Full recording section ────────────────────────────────────────────────────

function FullRecordingSection({ recordings }: { recordings: ScreeningRecordings | null }) {
  const [open, setOpen] = useState(false);

  if (!recordings?.has_recording) return null;

  return (
    <Card className="border-slate-200">
      <button
        className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-slate-50 transition-colors"
        onClick={() => setOpen((p) => !p)}
      >
        <div className="flex items-center gap-2">
          <Play className="h-4 w-4 text-slate-500" />
          <span className="text-sm font-semibold text-slate-700">Full Interview Recording</span>
          <span className="text-xs text-slate-400 ml-1">— complete unedited interview</span>
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
      </button>

      {open && (
        <div className="border-t border-slate-100 p-5">
          <MediaPlayers url={recordings.full_video_url!} label="Full interview" />
        </div>
      )}
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Decision = "advance" | "reject" | "hold";

export default function AIScreeningResultsPage({
  params,
}: { params: Promise<{ screeningId: string }> }) {
  const { screeningId } = use(params);

  const [screening, setScreening] = useState<LiveInterview | null>(null);
  const [segments, setSegments] = useState<ScreeningSegment[]>([]);
  const [recordings, setRecordings] = useState<ScreeningRecordings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState<Decision | null>(null);
  const [decided, setDecided] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [scr, segs, recs] = await Promise.all([
        getLiveInterview(screeningId),
        getScreeningSegments(screeningId).catch((e) => {
          console.warn("getScreeningSegments failed", e);
          return [] as ScreeningSegment[];
        }),
        getScreeningRecordings(screeningId).catch((e) => {
          console.warn("getScreeningRecordings failed", e);
          return null;
        }),
      ]);
      setScreening(scr);
      setSegments(segs);
      setRecordings(recs);

      // Diagnostics — remove once confirmed working
      console.log("recordings", recs);
      console.log("has_recording", recs?.has_recording);
      console.log("video_url", recs?.full_video_url);
      if (scr.recruiter_decision) {
        setDecided(true);
        setNotes(scr.recruiter_notes ?? "");
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load results");
    } finally {
      setLoading(false);
    }
  }, [screeningId]);

  useEffect(() => { load(); }, [load]);

  const handleDecision = async (decision: Decision) => {
    setSubmitting(decision);
    try {
      const updated = await submitReviewDecision(screeningId, decision, notes || undefined);
      setScreening(updated);
      setDecided(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to submit decision");
    } finally {
      setSubmitting(null);
    }
  };

  // ── Loading / error ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (error || !screening) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="h-5 w-5 text-red-500 shrink-0" />
          <p className="text-red-700 text-sm">{error ?? "Interview not found or access denied."}</p>
        </div>
      </div>
    );
  }

  const rec = screening.recommendation;
  const recCfg = rec ? REC_CONFIG[rec] : null;
  const isAwaitingReview = screening.status === "review_pending";
  const questionsAnswered = segments.filter((s) => s.transcript).length;

  // Distinguish two different incomplete_reason scenarios:
  //   "reduced confidence" — scores were generated but duration was short (soft warning)
  //   "truly incomplete"   — hard gate failed; no scores exist
  const hasScores = screening.overall_score != null;
  const incompleteReason: string | null = screening.incomplete_reason ?? null;
  const isReducedConfidence = hasScores && !!incompleteReason;
  const isTrulyIncomplete   = !hasScores && (screening.status === "incomplete");

  // Full transcript from messages
  const interviewerMsgs = screening.messages.filter((m) => m.role === "interviewer");
  const candidateMsgs = screening.messages.filter((m) => m.role === "candidate");

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link href="/ai-screenings">
            <Button variant="ghost" size="sm" className="gap-1 text-slate-500 hover:text-slate-700">
              <ArrowLeft className="h-4 w-4" />Back
            </Button>
          </Link>
          <div className="h-4 w-px bg-slate-200" />
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-orange-100 flex items-center justify-center">
              <Brain className="h-4 w-4 text-orange-600" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900">AI Screening Results</h1>
              <p className="text-xs text-slate-500">Recruiter review — confidential</p>
            </div>
          </div>
        </div>

        {isAwaitingReview && (
          <Badge className="bg-amber-100 text-amber-800 border border-amber-300 px-3 py-1">
            Awaiting Review
          </Badge>
        )}
        {decided && (
          <Badge className={cn(
            "border px-3 py-1 capitalize",
            screening.recruiter_decision === "advance"
              ? "bg-emerald-100 text-emerald-800 border-emerald-300"
              : screening.recruiter_decision === "reject"
                ? "bg-red-100 text-red-800 border-red-300"
                : "bg-slate-100 text-slate-700 border-slate-300",
          )}>
            {screening.recruiter_decision === "advance"
              ? "Advanced to Interview"
              : screening.recruiter_decision === "reject"
                ? "Rejected"
                : "On Hold"}
          </Badge>
        )}
      </div>

      {/* ── Reduced-confidence warning (short duration, scores still valid) ── */}
      {isReducedConfidence && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />
          <div>
            <span className="font-semibold">Interview Completed — Confidence Reduced. </span>
            {incompleteReason}
          </div>
        </div>
      )}

      {/* ── Truly incomplete notice (hard gate failed, no scores) ── */}
      {isTrulyIncomplete && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
          <XCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-500" />
          <div>
            <span className="font-semibold">Interview Incomplete — No Scores Generated. </span>
            {incompleteReason}
          </div>
        </div>
      )}

      {/* ── Candidate + AI evaluation ── */}
      <div className="grid gap-5 lg:grid-cols-3">
        {/* Left: candidate info + scores */}
        <div className="lg:col-span-1 space-y-5">
          {/* Candidate card */}
          <Card className="border-slate-200">
            <CardContent className="p-5 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-full bg-orange-100 flex items-center justify-center shrink-0">
                  <User className="h-5 w-5 text-orange-600" />
                </div>
                <div>
                  <p className="font-semibold text-slate-900">{screening.candidate_name_snapshot ?? "Candidate"}</p>
                  {screening.job_title_snapshot && (
                    <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                      <Briefcase className="h-3 w-3" />{screening.job_title_snapshot}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-3 text-center pt-2 border-t border-slate-100">
                <div>
                  <p className="text-xl font-bold text-slate-800">{questionsAnswered}</p>
                  <p className="text-xs text-slate-500">Questions</p>
                </div>
                {screening.duration_seconds != null && (
                  <div>
                    <p className="text-xl font-bold text-slate-800">{fmtDuration(screening.duration_seconds)}</p>
                    <p className="text-xs text-slate-500">Duration</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* AI recommendation */}
          {recCfg && (
            <Card className="border-slate-200">
              <CardContent className="p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">AI Recommendation</p>
                  <Badge className={cn("border text-sm px-3 py-1 font-semibold", recCfg.badge)}>
                    {recCfg.label}
                  </Badge>
                </div>

                {screening.overall_score != null && (
                  <div className="text-center py-2">
                    <p className="text-4xl font-bold text-slate-900">{Math.round(screening.overall_score)}</p>
                    <p className="text-xs text-slate-500 mt-1">Overall Score / 100</p>
                  </div>
                )}

                <div className="space-y-3">
                  <ScoreBar label="Communication"  value={screening.communication_score} />
                  <ScoreBar label="Experience"     value={screening.experience_score} />
                  <ScoreBar label="Leadership"     value={screening.leadership_score} />
                  <ScoreBar label="Confidence"     value={screening.confidence_score} />
                  <ScoreBar label="Culture Fit"    value={screening.culture_fit_score} />
                </div>
              </CardContent>
            </Card>
          )}

          {/* AI Summary */}
          {screening.ai_summary && (
            <Card className="border-slate-200">
              <CardContent className="p-5 space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">AI Summary</p>
                <p className="text-sm text-slate-700 leading-relaxed">{screening.ai_summary}</p>
              </CardContent>
            </Card>
          )}

          {/* Recruiter Logistics — mandatory questions always asked at end */}
          {(screening.notice_period || screening.salary_expectation || screening.candidate_questions) && (
            <Card className="border-blue-200 bg-blue-50">
              <CardContent className="p-5 space-y-4">
                <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide flex items-center gap-1.5">
                  <Briefcase className="h-3.5 w-3.5" />
                  Recruiter Logistics
                </p>
                <p className="text-xs text-blue-600">
                  These questions are always asked at the end of every interview,
                  regardless of the assessment question count.
                </p>

                {screening.notice_period && (
                  <div className="space-y-1 bg-white rounded-lg p-3 border border-blue-100">
                    <p className="text-xs font-semibold text-slate-500">
                      Notice Period / Availability
                    </p>
                    <p className="text-sm text-slate-700 leading-relaxed">
                      {screening.notice_period}
                    </p>
                  </div>
                )}

                {screening.salary_expectation && (
                  <div className="space-y-1 bg-white rounded-lg p-3 border border-blue-100">
                    <p className="text-xs font-semibold text-slate-500">
                      Compensation Expectations
                    </p>
                    <p className="text-sm text-slate-700 leading-relaxed">
                      {screening.salary_expectation}
                    </p>
                  </div>
                )}

                {screening.candidate_questions && (
                  <div className="space-y-1 bg-white rounded-lg p-3 border border-blue-100">
                    <p className="text-xs font-semibold text-slate-500">
                      Candidate Questions for Us
                    </p>
                    <p className="text-sm text-slate-700 leading-relaxed">
                      {screening.candidate_questions}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right: strengths, concerns, transcript, segments */}
        <div className="lg:col-span-2 space-y-5">
          {/* Strengths + Concerns */}
          {((screening.strengths?.length ?? 0) > 0 || (screening.concerns?.length ?? 0) > 0) && (
            <div className="grid sm:grid-cols-2 gap-4">
              {(screening.strengths?.length ?? 0) > 0 && (
                <Card className="border-emerald-200 bg-emerald-50">
                  <CardContent className="p-5 space-y-3">
                    <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide flex items-center gap-1.5">
                      <ThumbsUp className="h-3.5 w-3.5" />Strengths
                    </p>
                    <ul className="space-y-2">
                      {(screening.strengths ?? []).map((s, i) => (
                        <li key={i} className="text-sm text-emerald-800 leading-relaxed flex gap-2">
                          <span className="text-emerald-500 mt-0.5 shrink-0">✓</span>
                          {s}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}
              {(screening.concerns?.length ?? 0) > 0 && (
                <Card className="border-red-200 bg-red-50">
                  <CardContent className="p-5 space-y-3">
                    <p className="text-xs font-semibold text-red-700 uppercase tracking-wide flex items-center gap-1.5">
                      <ThumbsDown className="h-3.5 w-3.5" />Concerns
                    </p>
                    <ul className="space-y-2">
                      {(screening.concerns ?? []).map((c, i) => (
                        <li key={i} className="text-sm text-red-800 leading-relaxed flex gap-2">
                          <span className="text-red-400 mt-0.5 shrink-0">!</span>
                          {c}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* ── Interview Recordings ── */}
          {/* Section header — shown whenever there is any recording-related content */}
          {(recordings !== null || segments.length > 0) && (
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <Play className="h-4 w-4 text-orange-500" />
              Interview Recordings
            </h2>
          )}

          {/* Per-question answer segments (only when segments exist) */}
          {segments.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500 font-medium px-1">
                Question segments — {segments.length} answer{segments.length !== 1 ? "s" : ""}
              </p>
              {segments.map((seg, i) => (
                <SegmentCard key={seg.id} seg={seg} index={i} />
              ))}
            </div>
          )}

          {/* Full recording — rendered unconditionally so it is never hidden by
              an outer guard; the component itself returns null when no recording
              is available. Previously it was nested inside a conditional that
              evaluated to false whenever recordings was null, making it invisible. */}
          <FullRecordingSection recordings={recordings} />

          {/* Full transcript */}
          {screening.messages.length > 0 && (
            <Card className="border-slate-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <FileText className="h-4 w-4 text-slate-500" />
                  Full Interview Transcript ({interviewerMsgs.length} questions · {candidateMsgs.length} answers)
                </CardTitle>
              </CardHeader>
              <CardContent className="px-5 pb-5 space-y-3 max-h-[500px] overflow-y-auto">
                {screening.messages.map((msg, i) => (
                  <div key={i} className={cn(
                    "flex gap-3",
                    msg.role === "candidate" ? "flex-row-reverse" : "flex-row",
                  )}>
                    <div className={cn(
                      "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5",
                      msg.role === "interviewer"
                        ? "bg-orange-100 text-orange-700"
                        : "bg-blue-100 text-blue-700",
                    )}>
                      {msg.role === "interviewer" ? "AI" : "C"}
                    </div>
                    <div className={cn(
                      "max-w-[75%] rounded-xl px-4 py-2.5 text-sm",
                      msg.role === "interviewer"
                        ? "bg-slate-100 text-slate-700"
                        : "bg-blue-50 text-blue-900",
                    )}>
                      {msg.is_followup && (
                        <p className="text-xs text-orange-500 mb-1">follow-up</p>
                      )}
                      {msg.content}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Recruiter decision panel */}
          {!decided && (
            <Card className="border-orange-200 bg-orange-50">
              <CardContent className="p-5 space-y-4">
                <p className="text-sm font-semibold text-orange-800">Recruiter Decision</p>
                <p className="text-xs text-orange-700">
                  This candidate is waiting in AI Screening stage. Your decision determines next steps.
                </p>
                <textarea
                  className="w-full min-h-[80px] rounded-lg border border-orange-200 bg-white px-3 py-2
                             text-sm resize-none focus:outline-none focus:ring-1 focus:ring-orange-400
                             placeholder:text-slate-400"
                  placeholder="Add notes for the hiring team (optional)…"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
                <div className="flex flex-wrap gap-3">
                  <Button
                    className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                    disabled={!!submitting}
                    onClick={() => handleDecision("advance")}
                  >
                    {submitting === "advance"
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <CheckCircle2 className="h-4 w-4" />}
                    Advance to Interview
                  </Button>
                  <Button
                    variant="outline"
                    className="border-slate-400 text-slate-600 hover:bg-slate-100 gap-1.5"
                    disabled={!!submitting}
                    onClick={() => handleDecision("hold")}
                  >
                    {submitting === "hold"
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <Clock className="h-4 w-4" />}
                    Put on Hold
                  </Button>
                  <Button
                    variant="outline"
                    className="border-red-300 text-red-600 hover:bg-red-50 gap-1.5"
                    disabled={!!submitting}
                    onClick={() => handleDecision("reject")}
                  >
                    {submitting === "reject"
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <XCircle className="h-4 w-4" />}
                    Reject
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Decision confirmed */}
          {decided && screening.recruiter_decision && (
            <Card className="border-slate-200">
              <CardContent className="p-5 space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Decision Recorded</p>
                <p className="text-sm text-slate-700 capitalize font-medium">
                  {screening.recruiter_decision === "advance" ? "Advanced to Interview"
                    : screening.recruiter_decision === "reject" ? "Candidate Rejected"
                    : "Placed on Hold"}
                </p>
                {screening.recruiter_notes && (
                  <p className="text-sm text-slate-500 italic">{screening.recruiter_notes}</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Error */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2 text-sm text-red-700">
              <AlertCircle className="h-4 w-4 shrink-0" />{error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

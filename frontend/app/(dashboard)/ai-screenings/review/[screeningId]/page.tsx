"use client";

/**
 * Recruiter — Live Interview Review
 *
 * Shows the completed live AI screening interview broken down by question.
 * Each question card displays:
 *   - Question text
 *   - Candidate transcript
 *   - Per-answer video clip (played inline, no full recording required)
 *   - AI evaluation from the screening assessment
 *
 * Data sources:
 *   GET /api/v1/ai-screenings/live/{id}          — screening summary + overall scores
 *   GET /api/v1/ai-screenings/live/{id}/segments  — per-question segment data + signed URLs
 */

import { useCallback, useEffect, useState } from "react";
import { use } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Loader2,
  MessageSquare,
  Play,
  User,
  Briefcase,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getLiveInterview } from "@/lib/api/ai_screening";
import { apiRequest } from "@/lib/api/client";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Segment {
  id: string;
  question_number: number;
  question_text: string;
  transcript: string | null;
  question_start_seconds: number | null;
  answer_start_seconds: number | null;
  answer_end_seconds: number | null;
  duration_seconds: number | null;
  video_clip_url: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(secs: number | null): string {
  if (secs == null) return "—";
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function ScorePill({ label, value }: { label: string; value: number | null }) {
  if (value == null) return null;
  const color = value >= 75 ? "text-emerald-600 bg-emerald-50 border-emerald-200"
    : value >= 55 ? "text-amber-600 bg-amber-50 border-amber-200"
    : "text-red-600 bg-red-50 border-red-200";
  return (
    <div className={cn("inline-flex flex-col items-center px-3 py-2 rounded-lg border text-center min-w-[72px]", color)}>
      <span className="text-lg font-bold">{Math.round(value)}</span>
      <span className="text-xs opacity-70 mt-0.5">{label}</span>
    </div>
  );
}

function RecommendationBadge({ rec }: { rec: string | null }) {
  if (!rec) return null;
  const cfg: Record<string, string> = {
    strong_hire: "bg-emerald-100 text-emerald-800 border-emerald-200",
    hire: "bg-blue-100 text-blue-800 border-blue-200",
    consider: "bg-amber-100 text-amber-800 border-amber-200",
    reject: "bg-red-100 text-red-800 border-red-200",
  };
  return (
    <Badge className={cn("border capitalize text-sm px-3 py-1", cfg[rec] ?? "bg-slate-100 text-slate-700")}>
      {rec.replace(/_/g, " ")}
    </Badge>
  );
}

// ── Segment card ──────────────────────────────────────────────────────────────

function SegmentCard({ seg, index }: { seg: Segment; index: number }) {
  const [expanded, setExpanded] = useState(index === 0);

  return (
    <Card className="border-slate-200 overflow-hidden">
      <button
        className="w-full text-left px-5 py-4 flex items-center gap-3 hover:bg-slate-50 transition-colors"
        onClick={() => setExpanded((p) => !p)}
      >
        <div className="w-7 h-7 rounded-full bg-orange-100 flex items-center justify-center flex-shrink-0">
          <span className="text-xs font-bold text-orange-600">{seg.question_number}</span>
        </div>
        <p className="flex-1 text-sm font-medium text-slate-800 line-clamp-2 text-left">
          {seg.question_text}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          {seg.duration_seconds != null && (
            <span className="text-xs text-slate-400 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {fmtDuration(seg.duration_seconds)}
            </span>
          )}
          {seg.transcript && (
            <span className="text-xs text-emerald-600 flex items-center gap-1">
              <MessageSquare className="h-3 w-3" />
              Answered
            </span>
          )}
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-slate-400" />
          ) : (
            <ChevronDown className="h-4 w-4 text-slate-400" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-100">
          <div className={cn(
            "grid gap-0",
            seg.video_clip_url ? "lg:grid-cols-2" : "grid-cols-1",
          )}>
            {/* ── Video clip ── */}
            {seg.video_clip_url && (
              <div className="bg-black aspect-video lg:aspect-auto lg:min-h-[220px]">
                <video
                  src={seg.video_clip_url}
                  controls
                  playsInline
                  className="w-full h-full object-contain"
                  preload="metadata"
                />
              </div>
            )}

            {/* ── Transcript + timing ── */}
            <div className="p-5 space-y-4">
              {seg.transcript ? (
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                    Candidate Response
                  </p>
                  <p className="text-sm text-slate-700 leading-relaxed">
                    {seg.transcript}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-slate-400 italic">No transcript recorded.</p>
              )}

              {/* Timestamps */}
              {(seg.question_start_seconds != null || seg.duration_seconds != null) && (
                <div className="flex flex-wrap gap-3 text-xs text-slate-500">
                  {seg.question_start_seconds != null && (
                    <span>Question at {fmtDuration(seg.question_start_seconds)}</span>
                  )}
                  {seg.answer_start_seconds != null && (
                    <span>Answer started at {fmtDuration(seg.answer_start_seconds)}</span>
                  )}
                  {seg.duration_seconds != null && (
                    <span>Duration: {fmtDuration(seg.duration_seconds)}</span>
                  )}
                </div>
              )}

              {/* No video placeholder */}
              {!seg.video_clip_url && (
                <div className="flex items-center gap-2 text-xs text-slate-400 bg-slate-50 rounded-lg px-3 py-2">
                  <Play className="h-3.5 w-3.5" />
                  Video clip not available for this answer
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InterviewReviewPage({
  params,
}: {
  params: Promise<{ screeningId: string }>;
}) {
  const { screeningId } = use(params);

  const [screening, setScreening] = useState<Awaited<ReturnType<typeof getLiveInterview>> | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [scr, segs] = await Promise.all([
        getLiveInterview(screeningId),
        apiRequest<Segment[]>(`/ai-screenings/live/${screeningId}/segments`),
      ]);
      setScreening(scr);
      setSegments(segs);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load interview");
    } finally {
      setLoading(false);
    }
  }, [screeningId]);

  useEffect(() => { load(); }, [load]);

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
          <p className="text-red-700 text-sm">{error ?? "Interview not found."}</p>
        </div>
      </div>
    );
  }

  const questionsAnswered = segments.filter((s) => s.transcript).length;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center gap-3">
        <Link href="/ai-screenings">
          <Button variant="ghost" size="sm" className="gap-1 text-slate-500">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </Link>
        <div className="h-4 w-px bg-slate-200" />
        <h1 className="text-xl font-bold text-slate-900">Interview Review</h1>
      </div>

      {/* ── Summary card ── */}
      <Card className="border-slate-200">
        <CardContent className="p-6">
          <div className="flex flex-wrap items-start gap-6">
            {/* Candidate info */}
            <div className="flex items-center gap-3 flex-1 min-w-[200px]">
              <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center shrink-0">
                <User className="h-5 w-5 text-orange-600" />
              </div>
              <div>
                <p className="font-semibold text-slate-900">
                  {screening.candidate_name_snapshot ?? "Candidate"}
                </p>
                {screening.job_title_snapshot && (
                  <p className="text-sm text-slate-500 flex items-center gap-1 mt-0.5">
                    <Briefcase className="h-3.5 w-3.5" />
                    {screening.job_title_snapshot}
                  </p>
                )}
              </div>
            </div>

            {/* Stats */}
            <div className="flex flex-wrap gap-4 items-center">
              <div className="text-center">
                <p className="text-2xl font-bold text-slate-800">{questionsAnswered}</p>
                <p className="text-xs text-slate-500">Questions answered</p>
              </div>
              {screening.duration_seconds != null && (
                <div className="text-center">
                  <p className="text-2xl font-bold text-slate-800">
                    {Math.round(screening.duration_seconds / 60)}m
                  </p>
                  <p className="text-xs text-slate-500">Duration</p>
                </div>
              )}
              <div className="flex items-center gap-1">
                {screening.status === "completed" ? (
                  <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 border">
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    Completed
                  </Badge>
                ) : (
                  <Badge className="bg-slate-100 text-slate-600 border border-slate-200 capitalize">
                    {screening.status}
                  </Badge>
                )}
              </div>
            </div>
          </div>

          {/* AI evaluation scores */}
          {(screening.overall_score != null ||
            screening.communication_score != null ||
            screening.experience_score != null) && (
            <div className="mt-5 pt-5 border-t border-slate-100">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
                AI Evaluation
              </p>
              <div className="flex flex-wrap gap-2 items-center">
                <RecommendationBadge rec={screening.recommendation} />
                <ScorePill label="Overall" value={screening.overall_score} />
                <ScorePill label="Communication" value={screening.communication_score} />
                <ScorePill label="Experience" value={screening.experience_score} />
                <ScorePill label="Confidence" value={screening.confidence_score} />
                <ScorePill label="Culture Fit" value={screening.culture_fit_score} />
                <ScorePill label="Leadership" value={screening.leadership_score} />
              </div>
              {screening.ai_summary && (
                <p className="mt-3 text-sm text-slate-600 leading-relaxed italic">
                  {screening.ai_summary}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Per-question segments ── */}
      <div className="space-y-3">
        <CardHeader className="px-0 pt-0 pb-2">
          <CardTitle className="text-base text-slate-800">
            Answer Segments
            {segments.length > 0 && (
              <span className="ml-2 text-sm font-normal text-slate-500">
                {segments.length} question{segments.length !== 1 ? "s" : ""}
              </span>
            )}
          </CardTitle>
        </CardHeader>

        {segments.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="p-8 text-center text-slate-400 text-sm">
              No answer segments recorded for this interview.
              {screening.video_url && (
                <p className="mt-2">
                  <a
                    href={screening.video_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-orange-500 underline"
                  >
                    Download full recording
                  </a>
                </p>
              )}
            </CardContent>
          </Card>
        ) : (
          segments.map((seg, i) => (
            <SegmentCard key={seg.id} seg={seg} index={i} />
          ))
        )}
      </div>
    </div>
  );
}

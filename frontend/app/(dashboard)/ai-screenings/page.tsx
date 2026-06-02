"use client";

/**
 * AI Screening — Pipeline Queue
 *
 * Shows every pipeline entry currently in the "Screening" stage.
 * Each row has a "Start Interview" button that navigates to the
 * dedicated interview room at /ai-screenings/interview/{candidateId}.
 *
 * Data source: GET /api/v1/ai-screenings/pipeline-queue
 * Records are NOT created manually — they auto-generate when a candidate
 * enters the Screening pipeline stage.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Brain,
  RefreshCw,
  Search,
  CheckCircle2,
  Clock,
  AlertCircle,
  XCircle,
  Loader2,
  User,
  Briefcase,
  Building2,
  Play,
  Star,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  getPipelineScreeningQueue,
  type PipelineQueueEntry,
} from "@/lib/api/ai_screening";
import { cn } from "@/lib/utils";

// ── Helpers ───────────────────────────────────────────────────────────────────

type InterviewStatus = PipelineQueueEntry["interview_status"];

const STATUS_CONFIG: Record<
  string,
  { label: string; color: string; icon: React.ElementType }
> = {
  not_started: { label: "Not Started",  color: "bg-slate-100 text-slate-600",    icon: Clock },
  pending:     { label: "Ready",        color: "bg-blue-100 text-blue-700",      icon: Clock },
  in_progress: { label: "In Progress",  color: "bg-amber-100 text-amber-700",    icon: Loader2 },
  completed:   { label: "Completed",    color: "bg-emerald-100 text-emerald-700",icon: CheckCircle2 },
  incomplete:  { label: "Incomplete",   color: "bg-amber-100 text-amber-700",    icon: AlertCircle },
  failed:      { label: "Failed",       color: "bg-red-100 text-red-600",        icon: XCircle },
  cancelled:   { label: "Cancelled",    color: "bg-slate-100 text-slate-500",    icon: XCircle },
};

const REC_CONFIG: Record<string, { label: string; color: string }> = {
  strong_hire: { label: "Strong Hire", color: "bg-emerald-100 text-emerald-800" },
  hire:        { label: "Hire",        color: "bg-blue-100 text-blue-800" },
  consider:    { label: "Consider",    color: "bg-amber-100 text-amber-800" },
  reject:      { label: "Reject",      color: "bg-red-100 text-red-800" },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.not_started;
  const Icon = cfg.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium", cfg.color)}>
      <Icon className={cn("h-3 w-3", status === "in_progress" && "animate-spin")} />
      {cfg.label}
    </span>
  );
}

function ScorePill({ score }: { score: number | null }) {
  if (score == null) return <span className="text-slate-400 text-xs">—</span>;
  const color = score >= 75 ? "text-emerald-600" : score >= 55 ? "text-amber-600" : "text-red-600";
  return (
    <span className={cn("font-bold text-sm flex items-center gap-0.5", color)}>
      <Star className="h-3 w-3" />
      {score.toFixed(0)}
    </span>
  );
}

function ActionButton({
  entry,
  onStart,
}: {
  entry: PipelineQueueEntry;
  onStart: (candidateId: string) => void;
}) {
  const s = entry.interview_status;

  if (s === "completed") {
    return (
      <Button
        size="sm"
        variant="outline"
        className="border-slate-300 text-slate-600 text-xs"
        onClick={() => onStart(entry.candidate_id)}
      >
        View Report
      </Button>
    );
  }

  if (s === "in_progress") {
    return (
      <Button
        size="sm"
        className="bg-amber-500 hover:bg-amber-600 text-white text-xs gap-1"
        onClick={() => onStart(entry.candidate_id)}
      >
        <Video className="h-3.5 w-3.5" />
        Rejoin
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      className="bg-orange-500 hover:bg-orange-600 text-white text-xs gap-1"
      onClick={() => onStart(entry.candidate_id)}
    >
      <Play className="h-3.5 w-3.5" />
      Start Interview
    </Button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AIScreeningsPage() {
  const router = useRouter();
  const [queue, setQueue] = useState<PipelineQueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getPipelineScreeningQueue({ limit: 200 });
      setQueue(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load screening queue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = queue.filter((e) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      e.candidate_name.toLowerCase().includes(q) ||
      (e.candidate_email ?? "").toLowerCase().includes(q) ||
      (e.job_title ?? "").toLowerCase().includes(q) ||
      (e.client_name ?? "").toLowerCase().includes(q)
    );
  });

  const handleStart = (candidateId: string) => {
    router.push(`/ai-screenings/interview/${candidateId}`);
  };

  // Stats
  const total     = queue.length;
  const completed = queue.filter((e) => e.interview_status === "completed").length;
  const inProg    = queue.filter((e) => e.interview_status === "in_progress").length;
  const notStarted= queue.filter((e) => e.interview_status === "not_started" || e.interview_status === "pending").length;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-orange-100 flex items-center justify-center">
            <Brain className="h-5 w-5 text-orange-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">AI Screenings</h1>
            <p className="text-sm text-slate-500">
              Candidates currently in the Screening pipeline stage
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4 mr-1", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "In Screening",  value: total,      color: "text-slate-700" },
          { label: "Not Started",   value: notStarted, color: "text-blue-600" },
          { label: "In Progress",   value: inProg,     color: "text-amber-600" },
          { label: "Completed",     value: completed,  color: "text-emerald-600" },
        ].map(({ label, value, color }) => (
          <Card key={label}>
            <CardContent className="p-4">
              <p className={cn("text-2xl font-bold", color)}>{value}</p>
              <p className="text-xs text-slate-500 mt-0.5">{label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
        <Input
          placeholder="Search candidate, job, client…"
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Hint */}
      {!loading && queue.length === 0 && !error && (
        <Card className="border-blue-100 bg-blue-50">
          <CardContent className="p-4 text-sm text-blue-700">
            <AlertCircle className="inline h-4 w-4 mr-1.5" />
            No candidates are currently in the Screening stage. Move candidates from the
            Pipeline to Screening to see them here.
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {error && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-4 text-sm text-red-700">{error}</CardContent>
        </Card>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
        </div>
      ) : filtered.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  Candidate
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  Job
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  Client
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  Stage
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  Interview
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  Score
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  Recommendation
                </th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  Action
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((entry) => (
                <tr key={entry.pipeline_id} className="hover:bg-slate-50 transition-colors">
                  {/* Candidate */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                        <User className="h-3.5 w-3.5 text-slate-500" />
                      </div>
                      <div>
                        <button
                          className="font-medium text-slate-900 hover:text-orange-600 hover:underline text-left"
                          onClick={() =>
                            router.push(`/candidates/${entry.candidate_id}`)
                          }
                        >
                          {entry.candidate_name}
                        </button>
                        <p className="text-xs text-slate-400">{entry.candidate_email}</p>
                      </div>
                    </div>
                  </td>

                  {/* Job */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 text-slate-700">
                      <Briefcase className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
                      <span className="truncate max-w-[160px]">
                        {entry.job_title ?? "—"}
                      </span>
                    </div>
                  </td>

                  {/* Client */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 text-slate-600">
                      <Building2 className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
                      <span className="truncate max-w-[120px]">
                        {entry.client_name ?? "—"}
                      </span>
                    </div>
                  </td>

                  {/* Pipeline Stage */}
                  <td className="px-4 py-3">
                    <Badge className="bg-slate-100 text-slate-700 border-0 capitalize text-xs">
                      {entry.pipeline_stage}
                    </Badge>
                  </td>

                  {/* Interview Status */}
                  <td className="px-4 py-3">
                    <StatusBadge status={entry.interview_status} />
                  </td>

                  {/* Score */}
                  <td className="px-4 py-3">
                    <ScorePill score={entry.overall_score} />
                  </td>

                  {/* Recommendation */}
                  <td className="px-4 py-3">
                    {entry.recommendation ? (
                      <span
                        className={cn(
                          "inline-block px-2 py-0.5 rounded-full text-xs font-medium",
                          REC_CONFIG[entry.recommendation]?.color ?? "bg-slate-100 text-slate-600"
                        )}
                      >
                        {REC_CONFIG[entry.recommendation]?.label ?? entry.recommendation}
                      </span>
                    ) : (
                      <span className="text-slate-400 text-xs">—</span>
                    )}
                  </td>

                  {/* Action */}
                  <td className="px-4 py-3 text-right">
                    <ActionButton entry={entry} onStart={handleStart} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : search ? (
        <div className="text-center py-12 text-slate-500 text-sm">
          No results for &ldquo;{search}&rdquo;
        </div>
      ) : null}
    </div>
  );
}

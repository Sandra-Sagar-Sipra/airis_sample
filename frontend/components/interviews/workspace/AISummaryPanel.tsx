"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Edit3,
  Loader2,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import {
  generateAISummary,
  getAISummary,
  updateAISummary,
} from "@/lib/api/interviews";
import type {
  AISummaryPayload,
  AISummaryRecommendation,
  AISummaryResponse,
} from "@/lib/api/types";

// ── Recommendation badge ───────────────────────────────────────────────────

const REC_LABELS: Record<AISummaryRecommendation, string> = {
  strongly_recommend: "Strongly Recommend",
  recommend: "Recommend",
  neutral: "Neutral",
  do_not_recommend: "Do Not Recommend",
};

const REC_CLASSES: Record<AISummaryRecommendation, string> = {
  strongly_recommend: "bg-green-100 text-green-800 border-green-200",
  recommend: "bg-blue-100 text-blue-800 border-blue-200",
  neutral: "bg-yellow-100 text-yellow-800 border-yellow-200",
  do_not_recommend: "bg-red-100 text-red-800 border-red-200",
};

function RecommendationBadge({ value }: { value: AISummaryRecommendation }) {
  return (
    <span
      className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold border ${REC_CLASSES[value] ?? "bg-gray-100 text-gray-700 border-gray-200"}`}
    >
      {REC_LABELS[value] ?? value}
    </span>
  );
}

// ── Bullet list editor ─────────────────────────────────────────────────────

function BulletListEditor({
  items,
  onChange,
  placeholder,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
}) {
  const handleChange = (idx: number, val: string) => {
    const next = [...items];
    next[idx] = val;
    onChange(next);
  };

  const handleRemove = (idx: number) => {
    onChange(items.filter((_, i) => i !== idx));
  };

  const handleAdd = () => {
    if (items.length < 5) onChange([...items, ""]);
  };

  return (
    <div className="space-y-1.5">
      {items.map((item, idx) => (
        <div key={idx} className="flex items-start gap-1.5">
          <span className="mt-2 text-gray-400 text-xs">•</span>
          <input
            className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[#FF5A1F]"
            value={item}
            placeholder={placeholder}
            onChange={(e) => handleChange(idx, e.target.value)}
          />
          <button
            type="button"
            onClick={() => handleRemove(idx)}
            className="mt-1 text-gray-400 hover:text-red-500"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
      {items.length < 5 && (
        <button
          type="button"
          onClick={handleAdd}
          className="text-xs text-[#FF5A1F] hover:underline ml-3"
        >
          + Add item
        </button>
      )}
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────

type ViewMode = "view" | "edit";

interface AISummaryPanelProps {
  interviewId: string;
  interviewStatus: string;
}

export function AISummaryPanel({ interviewId, interviewStatus }: AISummaryPanelProps) {
  const [summaryData, setSummaryData] = useState<AISummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("view");

  // Edit form state
  const [editKeyStrengths, setEditKeyStrengths] = useState<string[]>([]);
  const [editConcerns, setEditConcerns] = useState<string[]>([]);
  const [editOverallAssessment, setEditOverallAssessment] = useState("");
  const [editRecommendation, setEditRecommendation] = useState<AISummaryRecommendation>("neutral");
  const [editReasoning, setEditReasoning] = useState("");

  // Poll ref
  const pollRef = useRef<{ cancelled: boolean } | null>(null);

  const isCompletedStatus = [
    "completed",
    "feedback_pending",
    "feedback_submitted",
  ].includes(interviewStatus);

  const load = useCallback(async () => {
    if (!isCompletedStatus) {
      setLoading(false);
      return;
    }
    try {
      const data = await getAISummary(interviewId);
      setSummaryData(data);
    } catch {
      // Not an error if there's simply no summary yet
    } finally {
      setLoading(false);
    }
  }, [interviewId, isCompletedStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  // Start polling when we know a generation is in progress
  const startPolling = useCallback(() => {
    if (pollRef.current) pollRef.current.cancelled = true;
    const poll = { cancelled: false };
    pollRef.current = poll;

    (async () => {
      for (let i = 0; i < 20 && !poll.cancelled; i++) {
        await new Promise<void>((r) => setTimeout(r, 3000));
        if (poll.cancelled) return;
        try {
          const data = await getAISummary(interviewId);
          if (poll.cancelled) return;
          if (data.ai_summary !== null) {
            setSummaryData(data);
            setGenerating(false);
            pollRef.current = null;
            return;
          }
        } catch {
          // keep polling
        }
      }
      // Timed out
      if (!poll.cancelled) {
        setGenerating(false);
        setError("Summary generation timed out. Try again.");
        pollRef.current = null;
      }
    })();
  }, [interviewId]);

  useEffect(() => {
    return () => {
      if (pollRef.current) pollRef.current.cancelled = true;
    };
  }, []);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      await generateAISummary(interviewId);
      startPolling();
    } catch (e) {
      setGenerating(false);
      setError(e instanceof Error ? e.message : "Failed to trigger generation.");
    }
  };

  const enterEdit = () => {
    const s = summaryData?.ai_summary as AISummaryPayload | null;
    setEditKeyStrengths(s?.key_strengths ?? []);
    setEditConcerns(s?.concerns ?? []);
    setEditOverallAssessment(s?.overall_assessment ?? "");
    setEditRecommendation((s?.recommendation as AISummaryRecommendation) ?? "neutral");
    setEditReasoning(s?.reasoning ?? "");
    setMode("edit");
  };

  const cancelEdit = () => setMode("view");

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const data = await updateAISummary(interviewId, {
        key_strengths: editKeyStrengths,
        concerns: editConcerns,
        overall_assessment: editOverallAssessment,
        recommendation: editRecommendation,
        reasoning: editReasoning,
      });
      setSummaryData(data);
      setMode("view");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  // ── Pre-completion state ──────────────────────────────────────────────
  if (!isCompletedStatus) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 py-10 text-center">
        <Bot className="w-10 h-10 text-gray-300 mb-3" />
        <p className="text-sm font-medium text-gray-600">Summary not available yet</p>
        <p className="text-xs text-gray-400 mt-1">
          An AI summary will be generated automatically when this interview is marked complete.
        </p>
      </div>
    );
  }

  // ── Loading ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />
      </div>
    );
  }

  const summary = summaryData?.ai_summary as AISummaryPayload | { error: string } | null;
  const hasError = summary !== null && typeof summary === "object" && "error" in summary;
  const hasValidSummary =
    summary !== null &&
    typeof summary === "object" &&
    !hasError &&
    !(summary as AISummaryPayload)._fallback;

  const validSummary = hasValidSummary ? (summary as AISummaryPayload) : null;

  // ── No summary yet ─────────────────────────────────────────────────────
  if (!summaryData || summaryData.ai_summary === null) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 py-10 text-center gap-3">
        <Bot className="w-10 h-10 text-gray-300" />
        <p className="text-sm font-medium text-gray-600">No summary yet</p>
        <p className="text-xs text-gray-400">
          Generate an AI summary from the interview transcript or notes.
        </p>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#FF5A1F] text-white rounded hover:bg-orange-600 disabled:opacity-50 transition-colors"
        >
          {generating ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Bot className="w-3.5 h-3.5" />
          )}
          {generating ? "Generating…" : "Generate Summary"}
        </button>
      </div>
    );
  }

  // ── Error state (from AI) ──────────────────────────────────────────────
  if (hasError) {
    const errCode = (summary as { error: string }).error;
    const errMessages: Record<string, string> = {
      EMPTY_INTERVIEW_NOTES: "No transcript or notes were recorded. During the interview, open the Copilot tab and enable auto-transcription (mic button), or type notes in the Notes tab.",
      TIMEOUT: "The AI summary timed out. You can try again.",
      AI_UNAVAILABLE: "The AI provider is unavailable. Try again later.",
    };
    return (
      <div className="p-4 space-y-3">
        <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded">
          <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-amber-800">Summary unavailable</p>
            <p className="text-xs text-amber-700 mt-0.5">
              {errMessages[errCode] ?? `Error: ${errCode}`}
            </p>
          </div>
        </div>
        {errCode !== "EMPTY_INTERVIEW_NOTES" && (
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#FF5A1F] text-white rounded hover:bg-orange-600 disabled:opacity-50 transition-colors"
          >
            {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Retry
          </button>
        )}
      </div>
    );
  }

  // ── Generating state (no valid summary yet) ────────────────────────────
  if (generating && !hasValidSummary) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-4">
        <Loader2 className="w-8 h-8 text-[#FF5A1F] animate-spin" />
        <p className="text-sm font-medium text-gray-700">Generating summary…</p>
        <p className="text-xs text-gray-400">This typically takes 5–15 seconds.</p>
      </div>
    );
  }

  // ── Edit mode ──────────────────────────────────────────────────────────
  if (mode === "edit") {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 bg-gray-50 shrink-0">
          <span className="text-xs font-semibold text-gray-700">Edit Summary</span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={cancelEdit}
              className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-gray-800 rounded"
            >
              <X className="w-3 h-3" /> Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1 px-2.5 py-1 text-xs bg-[#FF5A1F] text-white rounded hover:bg-orange-600 disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Save
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && <p className="text-xs text-red-500">{error}</p>}

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Key Strengths (3–5)</label>
            <BulletListEditor
              items={editKeyStrengths}
              onChange={setEditKeyStrengths}
              placeholder="Strength…"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Concerns (0–5)</label>
            <BulletListEditor
              items={editConcerns}
              onChange={setEditConcerns}
              placeholder="Concern…"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Overall Assessment</label>
            <textarea
              className="w-full text-xs border border-gray-200 rounded px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#FF5A1F] resize-none"
              rows={4}
              value={editOverallAssessment}
              onChange={(e) => setEditOverallAssessment(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Recommendation</label>
            <select
              className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#FF5A1F]"
              value={editRecommendation}
              onChange={(e) => setEditRecommendation(e.target.value as AISummaryRecommendation)}
            >
              <option value="strongly_recommend">Strongly Recommend</option>
              <option value="recommend">Recommend</option>
              <option value="neutral">Neutral</option>
              <option value="do_not_recommend">Do Not Recommend</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Reasoning</label>
            <textarea
              className="w-full text-xs border border-gray-200 rounded px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#FF5A1F] resize-none"
              rows={3}
              value={editReasoning}
              onChange={(e) => setEditReasoning(e.target.value)}
            />
          </div>
        </div>
      </div>
    );
  }

  // ── View mode ──────────────────────────────────────────────────────────
  const displaySummary = (validSummary ?? (summary as AISummaryPayload));

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 bg-gray-50 shrink-0">
        <div className="flex items-center gap-1.5">
          <Bot className="w-3.5 h-3.5 text-[#FF5A1F]" />
          <span className="text-xs font-semibold text-gray-700">AI Summary</span>
          {summaryData?.ai_summary_edited && (
            <span className="text-[10px] text-gray-400 italic">(edited)</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleGenerate}
            disabled={generating}
            title="Regenerate"
            className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-40"
          >
            {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={enterEdit}
            title="Edit"
            className="p-1 text-gray-400 hover:text-gray-700"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Fallback notice */}
        {(summary as AISummaryPayload)?._fallback && (
          <div className="flex items-start gap-2 p-2.5 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            AI summary unavailable — placeholder shown. Click Edit to fill in manually.
          </div>
        )}

        {/* Recommendation */}
        {displaySummary?.recommendation && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-gray-500">Recommendation:</span>
            <RecommendationBadge value={displaySummary.recommendation as AISummaryRecommendation} />
          </div>
        )}

        {/* Overall assessment */}
        {displaySummary?.overall_assessment && (
          <div>
            <p className="text-xs font-semibold text-gray-600 mb-1">Overall Assessment</p>
            <p className="text-xs text-gray-700 leading-relaxed">{displaySummary.overall_assessment}</p>
          </div>
        )}

        {/* Key strengths */}
        {displaySummary?.key_strengths?.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-green-700 mb-1.5 flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> Key Strengths
            </p>
            <ul className="space-y-1">
              {displaySummary.key_strengths.map((s, i) => (
                <li key={i} className="text-xs text-gray-700 flex items-start gap-1.5">
                  <span className="text-green-400 mt-0.5">•</span>
                  {s}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Concerns */}
        {displaySummary?.concerns?.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-amber-700 mb-1.5 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> Concerns
            </p>
            <ul className="space-y-1">
              {displaySummary.concerns.map((c, i) => (
                <li key={i} className="text-xs text-gray-700 flex items-start gap-1.5">
                  <span className="text-amber-400 mt-0.5">•</span>
                  {c}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Reasoning */}
        {displaySummary?.reasoning && (
          <div>
            <p className="text-xs font-semibold text-gray-600 mb-1">Reasoning</p>
            <p className="text-xs text-gray-700 leading-relaxed italic">{displaySummary.reasoning}</p>
          </div>
        )}

        {/* Meta */}
        {summaryData?.ai_summary_generated_at && (
          <p className="text-[10px] text-gray-400 pt-1 border-t border-gray-100">
            Generated {new Date(summaryData.ai_summary_generated_at).toLocaleString()}
            {summaryData.ai_summary_provider && summaryData.ai_summary_provider !== "none" && (
              <> · {summaryData.ai_summary_provider}</>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

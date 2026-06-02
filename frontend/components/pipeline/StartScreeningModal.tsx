"use client";

import { useState } from "react";
import { Brain, X, Loader2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startScreening } from "@/lib/api/ai_screening";
import type { ScreeningType } from "@/lib/api/types";

const SCREENING_TYPES: { value: ScreeningType; label: string; description: string }[] = [
  {
    value: "technical",
    label: "Technical",
    description: "Deep dive into technical skills, architecture, and problem solving",
  },
  {
    value: "behavioral",
    label: "Behavioral",
    description: "Situational questions to assess work style and soft skills",
  },
  {
    value: "hr",
    label: "HR / General",
    description: "Culture fit, motivation, background, and expectations",
  },
  {
    value: "communication",
    label: "Communication",
    description: "Assess clarity of thought and structured communication ability",
  },
  {
    value: "leadership",
    label: "Leadership",
    description: "Team dynamics, decision-making, and leadership scenarios",
  },
  {
    value: "role_fit",
    label: "Role Fit",
    description: "Tailored to the specific job requirements and responsibilities",
  },
];

interface StartScreeningModalProps {
  candidateId: string;
  candidateName: string;
  jobId?: string;
  jobTitle?: string;
  pipelineId?: string;
  onClose: () => void;
  onStarted: (screeningId: string) => void;
}

export function StartScreeningModal({
  candidateId,
  candidateName,
  jobId,
  jobTitle,
  pipelineId,
  onClose,
  onStarted,
}: StartScreeningModalProps) {
  const [screeningType, setScreeningType] = useState<ScreeningType>("technical");
  const [movePipeline, setMovePipeline] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStart() {
    setLoading(true);
    setError(null);
    try {
      const screening = await startScreening({
        candidate_id: candidateId,
        job_id: jobId ?? null,
        screening_type: screeningType,
        move_pipeline_stage: movePipeline && Boolean(pipelineId),
        pipeline_id: pipelineId ?? null,
      });
      onStarted(screening.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to start AI interview.";
      setError(msg);
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-slate-100">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-orange-50 border border-orange-100">
              <Brain className="h-4.5 w-4.5 text-orange-500" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">Start AI Interview</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {candidateName}
                {jobTitle ? ` · ${jobTitle}` : ""}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          {/* Screening type */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-2.5">
              Screening Type
            </label>
            <div className="grid grid-cols-2 gap-2">
              {SCREENING_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setScreeningType(t.value)}
                  className={`relative flex flex-col items-start rounded-xl border p-3 text-left transition-all ${
                    screeningType === t.value
                      ? "border-orange-300 bg-orange-50 ring-1 ring-orange-200"
                      : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                  }`}
                >
                  <span
                    className={`text-xs font-bold ${
                      screeningType === t.value ? "text-orange-700" : "text-slate-700"
                    }`}
                  >
                    {t.label}
                  </span>
                  <span className="mt-0.5 text-[11px] leading-snug text-slate-400">
                    {t.description}
                  </span>
                  {screeningType === t.value && (
                    <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-orange-400" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Pipeline stage toggle — only show when we have a pipeline entry */}
          {pipelineId && (
            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-slate-700">
                  Move to AI Interview stage
                </p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Automatically updates the pipeline board column
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={movePipeline}
                onClick={() => setMovePipeline((v) => !v)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                  movePipeline ? "bg-orange-500" : "bg-slate-200"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                    movePipeline ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          )}

          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-slate-100 px-6 py-4">
          <Button
            variant="outline"
            className="h-9 px-4 text-sm"
            onClick={onClose}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            className="h-9 gap-2 bg-orange-500 px-5 text-sm text-white hover:bg-orange-600"
            onClick={handleStart}
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Zap className="h-3.5 w-3.5" />
                Start AI Interview
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

"use client";

/**
 * PIPE-008: Pipeline Detail Page
 *
 * Displays the full pipeline record with offer lifecycle management,
 * stage history, and offer event timeline.
 *
 * Accessible at /pipelines/{id}
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Briefcase,
  Calendar,
  CheckCircle,
  Clock,
  Loader2,
  User,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { getPipelines } from "@/lib/api/pipeline";
import { useAuthStore } from "@/store/auth-store";
import { hasPermission, PIPELINE_UPDATE_PERMISSION } from "@/lib/rbac";
import type { Pipeline, PipelineStage, PipelineStatus } from "@/lib/api/types";
import { PipelineStageHistoryPanel } from "@/components/pipeline/PipelineStageHistoryPanel";
import { OfferPanel } from "@/components/pipeline/OfferPanel";
import { OfferHistoryTimeline } from "@/components/pipeline/OfferHistoryTimeline";

// ── Constants ─────────────────────────────────────────────────────────────────

const STAGE_LABELS: Record<PipelineStage, string> = {
  applied:      "Applied",
  ai_interview: "AI Interview Screening",
  interview:    "Interview",
  offer:        "Offer",
  placed:       "Placed",
  rejected:     "Rejected",
};

const STAGE_BADGE: Record<PipelineStage, string> = {
  applied:      "bg-violet-50 text-violet-700 border-violet-100",
  ai_interview: "bg-orange-50 text-orange-700 border-orange-100",
  interview:    "bg-emerald-50 text-emerald-700 border-emerald-100",
  offer:        "bg-amber-50 text-amber-700 border-amber-100",
  placed:       "bg-cyan-50 text-cyan-700 border-cyan-100",
  rejected:     "bg-red-50 text-red-600 border-red-100",
};

const STATUS_BADGE: Record<PipelineStatus, string> = {
  active:    "bg-emerald-50 text-emerald-700 border-emerald-100",
  on_hold:   "bg-amber-50 text-amber-700 border-amber-100",
  withdrawn: "bg-slate-100 text-slate-500 border-slate-200",
  closed:    "bg-red-50 text-red-600 border-red-100",
};

const STATUS_LABELS: Record<PipelineStatus, string> = {
  active:    "Active",
  on_hold:   "On Hold",
  withdrawn: "Withdrawn",
  closed:    "Closed",
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function StageBadge({ stage }: { stage: PipelineStage }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STAGE_BADGE[stage]}`}>
      {STAGE_LABELS[stage]}
    </span>
  );
}

function StatusBadge({ status }: { status: PipelineStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_BADGE[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PipelineDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const pipelineId = params.id;

  const permissions = useAuthStore((s) => s.permissions);
  const canUpdate = hasPermission(permissions, PIPELINE_UPDATE_PERMISSION);

  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pipelineId) return;
    setLoading(true);
    setError(null);

    // Fetch via the list endpoint filtered by id (the individual GET uses the same auth scope).
    // We load a single pipeline by fetching with the pipeline's ID via candidateId or directly.
    // Actually use the individual GET endpoint pattern:
    import("@/lib/api/client").then(({ apiRequest }) => {
      return apiRequest<Pipeline>(`/pipelines/${pipelineId}`, {}, 0);
    })
      .then((p) => setPipeline(p))
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load pipeline.");
      })
      .finally(() => setLoading(false));
  }, [pipelineId]);

  if (loading) {
    return (
      <section className="py-16 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-orange-400" />
      </section>
    );
  }

  if (error || !pipeline) {
    return (
      <section className="py-16 text-center">
        <p className="text-sm text-red-500">{error ?? "Pipeline not found."}</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push("/pipelines")}>
          <ArrowLeft className="h-4 w-4 mr-1.5" />
          Back to Pipelines
        </Button>
      </section>
    );
  }

  const isOffer = pipeline.stage === "offer";

  return (
    <section className="min-w-0 space-y-6 pb-16">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            href="/pipelines"
            className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-orange-600 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Pipelines
          </Link>
          <span className="text-slate-300">/</span>
          <h1 className="text-lg font-bold tracking-tight text-slate-900">Pipeline Detail</h1>
        </div>
        <div className="flex items-center gap-2">
          <StageBadge stage={pipeline.stage} />
          <StatusBadge status={pipeline.status} />
        </div>
      </div>

      {/* ── Pipeline info card ───────────────────────────────────────────────── */}
      <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
        <h2 className="text-[13px] font-bold uppercase tracking-wider text-slate-400 mb-4">
          Pipeline Info
        </h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <InfoRow label="Stage">
            <StageBadge stage={pipeline.stage} />
          </InfoRow>
          <InfoRow label="Status">
            <StatusBadge status={pipeline.status} />
          </InfoRow>
          <InfoRow label="Created">
            <span className="text-sm text-slate-700">
              {new Date(pipeline.created_at).toLocaleDateString()}
            </span>
          </InfoRow>
          <InfoRow label="Last Updated">
            <span className="text-sm text-slate-700">
              {new Date(pipeline.updated_at).toLocaleDateString()}
            </span>
          </InfoRow>
          {pipeline.stage_updated_at && (
            <InfoRow label="Stage Changed">
              <span className="text-sm text-slate-700">
                {new Date(pipeline.stage_updated_at).toLocaleString()}
              </span>
            </InfoRow>
          )}
          {pipeline.notes && (
            <div className="col-span-2 sm:col-span-4">
              <InfoRow label="Notes">
                <p className="text-sm text-slate-600 italic">{pipeline.notes}</p>
              </InfoRow>
            </div>
          )}
        </div>
      </div>

      {/* ── Offer Panel (PIPE-008) — visible when in offer stage ─────────────── */}
      {isOffer && (
        <OfferPanel
          pipelineId={pipelineId}
          pipelineStage={pipeline.stage}
        />
      )}

      {/* ── Stage History ────────────────────────────────────────────────────── */}
      <PipelineStageHistoryPanel pipelineId={pipelineId} defaultExpanded={!isOffer} />

      {/* ── Offer History Timeline (PIPE-008) ───────────────────────────────── */}
      {(isOffer || pipeline.stage === "placed" || pipeline.stage === "rejected") && (
        <OfferHistoryTimeline pipelineId={pipelineId} defaultExpanded={false} />
      )}
    </section>
  );
}

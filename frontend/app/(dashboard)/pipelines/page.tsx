"use client";

/**
 * Unified Pipeline Workspace (PIPE-004 + PIPE-006)
 *
 * Single route at /pipelines with a toggle between:
 *  - Table View  (?view=table, default)
 *  - Kanban View (?view=kanban)
 *
 * Shared state: candidates, jobs, filterJobId, filterCandidateId, filterStage, filterStatus.
 * Each view manages its own pipeline data + loading state (different API shapes).
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  type DragEndEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Filter,
  GripVertical,
  LayoutList,
  Kanban,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { getCandidates } from "@/lib/api/candidates";
import { listAllClients } from "@/lib/api/clients";
import { getJobs } from "@/lib/api/jobs";
import { getJobMatchesAts, rescoreJobAts } from "@/lib/api/ats";
import {
  getPipelines,
  getPipelinesWithMeta,
  transitionPipelineStage,
} from "@/lib/api/pipeline";
import { listScreenings } from "@/lib/api/ai_screening";
import { hasPermission, PIPELINE_UPDATE_PERMISSION } from "@/lib/rbac";
import { useAuthStore } from "@/store/auth-store";
import { ATSRecommendationBadge } from "@/components/ats/ats-recommendation-badge";
import { ATSScoreBadge } from "@/components/ats/ats-score-badge";
import { normalizeCandidateId } from "@/lib/ats/candidate-id";
import { StartScreeningModal } from "@/components/pipeline/StartScreeningModal";
import { RejectCandidateModal } from "@/components/pipeline/RejectCandidateModal";
import type {
  AIScreeningListItem,
  Candidate,
  Job,
  Pipeline,
  PipelineListMeta,
  PipelineStage,
  PipelineStatus,
} from "@/lib/api/types";

// ── Types ─────────────────────────────────────────────────────────────────────

type ViewMode = "table" | "kanban";

// Kanban uses a slightly different stage vocabulary for display.
type BoardStage =
  | "applied"
  | "ai_interview"
  | "interview"
  | "offered"
  | "hired"
  | "rejected";

// ── Shared constants ──────────────────────────────────────────────────────────

const STAGE_LABELS_TABLE: Record<PipelineStage, string> = {
  applied: "Applied",
  ai_interview: "AI Interview Screening",
  interview: "Interview",
  offer: "Offer",
  placed: "Placed",
  rejected: "Rejected",
};

const STAGE_BADGE: Record<PipelineStage, string> = {
  applied: "bg-violet-50 text-violet-700 border-violet-100",
  ai_interview: "bg-orange-50 text-orange-700 border-orange-100",
  interview: "bg-emerald-50 text-emerald-700 border-emerald-100",
  offer: "bg-amber-50 text-amber-700 border-amber-100",
  placed: "bg-cyan-50 text-cyan-700 border-cyan-100",
  rejected: "bg-red-50 text-red-600 border-red-100",
};

const STATUS_BADGE: Record<PipelineStatus, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-100",
  on_hold: "bg-amber-50 text-amber-700 border-amber-100",
  withdrawn: "bg-slate-100 text-slate-500 border-slate-200",
  closed: "bg-red-50 text-red-600 border-red-100",
};

const STATUS_LABELS: Record<PipelineStatus, string> = {
  active: "Active",
  on_hold: "On Hold",
  withdrawn: "Withdrawn",
  closed: "Closed",
};

const ALL_STAGES: PipelineStage[] = [
  "applied",
  "ai_interview",
  "interview",
  "offer",
  "placed",
  "rejected",
];

const ALL_STATUSES: PipelineStatus[] = [
  "active",
  "on_hold",
  "withdrawn",
  "closed",
];

const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

// ── Kanban constants ──────────────────────────────────────────────────────────

const BOARD_STAGES: BoardStage[] = [
  "applied",
  "ai_interview",
  "interview",
  "offered",
  "hired",
  "rejected",
];

const BOARD_STAGE_LABELS: Record<BoardStage, string> = {
  applied: "Applied",
  ai_interview: "AI Interview Screening",
  interview: "Interview",
  offered: "Offered",
  hired: "Hired",
  rejected: "Rejected",
};

const BOARD_STAGE_ACCENT: Record<BoardStage, string> = {
  applied: "bg-violet-400",
  ai_interview: "bg-orange-400",
  interview: "bg-emerald-400",
  offered: "bg-amber-400",
  hired: "bg-cyan-400",
  rejected: "bg-red-400",
};

// Mirrors backend VALID_TRANSITIONS — prevents guaranteed 422s.
const VALID_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  applied: new Set(["ai_interview", "rejected"]),
  ai_interview: new Set(["interview", "rejected"]),
  interview: new Set(["offer", "rejected"]),
  offer: new Set(["placed", "rejected"]),
  placed: new Set(),
  rejected: new Set(),
};


// ── Kanban stage helpers ──────────────────────────────────────────────────────

function toBoardStage(stage: Pipeline["stage"]): BoardStage {
  if (stage === "offer") return "offered";
  if (stage === "placed") return "hired";
  return stage as BoardStage;
}

function toPipelineStage(stage: BoardStage): Pipeline["stage"] {
  if (stage === "offered") return "offer";
  if (stage === "hired") return "placed";
  return stage as Pipeline["stage"];
}

function canTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.has(to) ?? false;
}

// ── Shared sub-components (badges) ────────────────────────────────────────────

function StageBadge({ stage }: { stage: PipelineStage }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${STAGE_BADGE[stage]}`}
    >
      {STAGE_LABELS_TABLE[stage]}
    </span>
  );
}

function StatusBadge({ status }: { status: PipelineStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${STATUS_BADGE[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function StagePill({ stage, count }: { stage: PipelineStage; count: number }) {
  return (
    <div
      className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 ${STAGE_BADGE[stage]}`}
    >
      <span className="text-[11px] font-bold uppercase tracking-wider">
        {STAGE_LABELS_TABLE[stage]}
      </span>
      <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-white/60 px-1 text-[10px] font-bold">
        {count}
      </span>
    </div>
  );
}

function SortIcon({
  col,
  sortBy,
  sortDir,
}: {
  col: "created_at" | "stage_updated_at";
  sortBy: "created_at" | "stage_updated_at";
  sortDir: "asc" | "desc";
}) {
  if (sortBy !== col)
    return <ArrowUpDown className="ml-1 h-3.5 w-3.5 text-slate-300" />;
  return sortDir === "asc" ? (
    <ArrowUp className="ml-1 h-3.5 w-3.5 text-[#FF5A1F]" />
  ) : (
    <ArrowDown className="ml-1 h-3.5 w-3.5 text-[#FF5A1F]" />
  );
}

// ── View toggle ───────────────────────────────────────────────────────────────

function ViewToggle({
  view,
  onChange,
}: {
  view: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div className="flex items-center rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
      <button
        type="button"
        onClick={() => onChange("table")}
        className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-bold transition-all ${
          view === "table"
            ? "bg-[#FF5A1F] text-white shadow-sm"
            : "text-slate-500 hover:text-slate-800"
        }`}
      >
        <LayoutList className="h-3.5 w-3.5" />
        Table
      </button>
      <button
        type="button"
        onClick={() => onChange("kanban")}
        className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-bold transition-all ${
          view === "kanban"
            ? "bg-[#FF5A1F] text-white shadow-sm"
            : "text-slate-500 hover:text-slate-800"
        }`}
      >
        <Kanban className="h-3.5 w-3.5" />
        Kanban
      </button>
    </div>
  );
}

// ── Kanban sub-components ─────────────────────────────────────────────────────

function CandidateCard({
  pipeline,
  candidate,
  atsScore,
  recommendation,
  semanticInsight,
  aiEnrichmentStatus,
  awaitingAtsMatch,
  boardLoading,
  isMoving,
  isTopMatch,
  isDragging,
  canReject,
  onReject,
}: {
  pipeline: Pipeline;
  candidate?: Candidate;
  atsScore?: number;
  recommendation?: string;
  semanticInsight?: string | null;
  aiEnrichmentStatus?: string | null;
  awaitingAtsMatch?: boolean;
  boardLoading?: boolean;
  isMoving?: boolean;
  isTopMatch?: boolean;
  isDragging?: boolean;
  canReject?: boolean;
  onReject?: (pipeline: Pipeline) => void;
}) {
  return (
    <div
      className={`relative group transition-all duration-300 w-full cursor-grab active:cursor-grabbing
        ${isMoving ? "opacity-70" : ""}
        ${isDragging ? "z-50" : "hover:-translate-y-1"}`}
    >
      <div
        className={`relative rounded-[20px] bg-white p-5 border transition-all duration-300 h-full
        ${
          isDragging
            ? "shadow-[0_20px_50px_rgba(0,0,0,0.15)] border-orange-200 scale-[1.02]"
            : "border-slate-100/80 shadow-[0_2px_12px_rgba(0,0,0,0.02)] hover:shadow-[0_8px_24px_rgba(0,0,0,0.06)] hover:border-slate-200"
        }`}
      >
        <div className="absolute right-4 top-5 opacity-0 group-hover:opacity-30 transition-opacity">
          <GripVertical className="h-4 w-4 text-slate-400" />
        </div>
        <Link href={`/candidates/${pipeline.candidate_id}`} className="block">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-50 border border-slate-100/80 text-[11px] font-bold text-slate-600 transition-colors duration-300 group-hover:bg-orange-50 group-hover:text-[#FF5A1F] group-hover:border-orange-100">
              {candidate
                ? `${candidate.first_name.charAt(0)}${candidate.last_name.charAt(0)}`
                : "?"}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[14px] font-bold leading-tight text-slate-900 group-hover:text-[#FF5A1F] transition-colors duration-300">
                {candidate
                  ? `${candidate.first_name} ${candidate.last_name}`
                  : "Unknown candidate"}
              </p>
              <p className="truncate text-[12px] text-slate-500 font-medium mt-0.5">
                {candidate?.role ?? "Role not specified"}
              </p>
              <p className="text-[10px] text-slate-400 font-medium mt-0.5">
                Applied{" "}
                {new Date(pipeline.created_at).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                Exp
              </span>
              <span className="text-[12px] text-slate-700 font-bold">
                {candidate?.years_experience !== null &&
                candidate?.years_experience !== undefined
                  ? `${candidate.years_experience}y`
                  : "-"}
              </span>
            </div>
            {isTopMatch && (
              <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-[9px] font-bold text-emerald-600 border border-emerald-100 uppercase tracking-wider">
                Top Match
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                Overall Fit
              </span>
              <ATSScoreBadge
                score={atsScore}
                scorePending={Boolean(awaitingAtsMatch && !boardLoading)}
                compact
              />
            </div>
            <ATSRecommendationBadge
              recommendation={recommendation}
              awaitingMatch={awaitingAtsMatch && !boardLoading}
              compact
            />
          </div>
          {semanticInsight ? (
            <div className="mt-4 p-3 rounded-xl bg-violet-50/40 border border-violet-100/30">
              <p
                className="line-clamp-2 text-[11px] leading-relaxed text-violet-600/90 italic"
                title={semanticInsight}
              >
                &ldquo;{semanticInsight}&rdquo;
              </p>
            </div>
          ) : aiEnrichmentStatus === "failed" ? (
            <p className="mt-4 text-[11px] leading-snug text-slate-400">
              AI insights currently unavailable.
            </p>
          ) : null}
        </Link>
        {isMoving ? (
          <div className="mt-4 pt-4 border-t border-slate-50 flex items-center gap-2">
            <RefreshCw className="h-3 w-3 text-[#FF5A1F] animate-spin" />
            <p className="text-[10px] font-bold text-[#FF5A1F] uppercase tracking-wider">
              Syncing stage...
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DraggableCandidateCard({
  pipeline,
  candidate,
  atsScore,
  recommendation,
  semanticInsight,
  aiEnrichmentStatus,
  awaitingAtsMatch,
  boardLoading,
  canDrag,
  isMoving,
  isTopMatch,
  canReject,
  onReject,
}: {
  pipeline: Pipeline;
  candidate?: Candidate;
  atsScore?: number;
  recommendation?: string;
  semanticInsight?: string | null;
  aiEnrichmentStatus?: string | null;
  awaitingAtsMatch?: boolean;
  boardLoading?: boolean;
  canDrag: boolean;
  isMoving: boolean;
  isTopMatch?: boolean;
  aiScreening?: AIScreeningListItem | null;
  onStartScreening?: () => void;
  canReject?: boolean;
  onReject?: (pipeline: Pipeline) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: pipeline.id, disabled: !canDrag });
  const style = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    zIndex: isDragging ? 100 : undefined,
    touchAction: "none" as const,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={isDragging ? "opacity-40" : ""}
      {...attributes}
      {...listeners}
    >
      <CandidateCard
        pipeline={pipeline}
        candidate={candidate}
        atsScore={atsScore}
        recommendation={recommendation}
        semanticInsight={semanticInsight}
        aiEnrichmentStatus={aiEnrichmentStatus}
        awaitingAtsMatch={awaitingAtsMatch}
        boardLoading={boardLoading}
        isMoving={isMoving}
        isTopMatch={isTopMatch}
        isDragging={isDragging}
        canReject={canReject}
        onReject={onReject}
      />
    </div>
  );
}

function StageColumn({
  stage,
  count,
  isDropEnabled,
  activePipelineId,
  isValidDropTarget,
  children,
}: {
  stage: BoardStage;
  count: number;
  isDropEnabled: boolean;
  activePipelineId: string | null;
  isValidDropTarget: boolean;
  children: ReactNode;
}) {
  const isRejected = stage === "rejected";
  const { setNodeRef, isOver } = useDroppable({
    id: stage,
    data: { stage },
    disabled: !isDropEnabled,
  });
  const isDropTarget =
    isOver && Boolean(activePipelineId) && isDropEnabled && isValidDropTarget;
  const isDraggingAny = Boolean(activePipelineId);
  const isUnreachable = isDraggingAny && !isValidDropTarget;

  return (
    <div
      className={`relative group transition-all duration-300 cursor-default h-full ${isUnreachable ? "opacity-40 pointer-events-none" : ""}`}
    >
      <div
        ref={setNodeRef}
        className={`relative flex flex-col h-[calc(100vh-380px)] min-h-[460px] min-w-[340px] rounded-[24px] border transition-all duration-300 ${
          isRejected
            ? isDropTarget
              ? "bg-red-50/60 border-red-300 shadow-[0_8px_30px_rgba(239,68,68,0.08)] scale-[1.005]"
              : "bg-red-50/10 border-red-100/60 shadow-[0_2px_12px_rgba(0,0,0,0.01)]"
            : isDropTarget
              ? "bg-orange-50/40 border-orange-200 shadow-[0_8px_30px_rgba(255,90,31,0.06)] scale-[1.005]"
              : "bg-slate-50/30 border-slate-100/60 shadow-[0_2px_12px_rgba(0,0,0,0.01)]"
        }`}
      >
        <div
          className={`sticky top-0 z-10 flex items-center justify-between gap-2 backdrop-blur-md p-5 rounded-t-[24px] border-b mb-3 ${isRejected ? "bg-red-50/60 border-red-100/60" : "bg-slate-50/80 border-slate-100/80"}`}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${BOARD_STAGE_ACCENT[stage]} shadow-[0_0_8px_rgba(0,0,0,0.1)]`}
            />
            <p
              className={`truncate text-[13px] font-bold tracking-wider uppercase ${isRejected ? "text-red-500" : "text-slate-600"}`}
            >
              {BOARD_STAGE_LABELS[stage]}
            </p>
          </div>
          <span className="flex items-center justify-center h-6 min-w-6 rounded-lg bg-white px-2 text-[11px] font-bold text-slate-500 shadow-sm border border-slate-100/80">
            {count}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-4 scrollbar-hide hover:scrollbar-default transition-all">
          {isDropTarget ? (
            <div
              className={`rounded-2xl border-2 border-dashed py-4 text-center text-[12px] font-bold animate-pulse ${isRejected ? "border-red-300/50 bg-red-50/40 text-red-500" : "border-[#FF5A1F]/30 bg-orange-50/30 text-[#FF5A1F]"}`}
            >
              {isRejected ? "Drop to reject" : "Drop here"}
            </div>
          ) : null}
          {!count && !isDraggingAny ? (
            <div className="h-32 rounded-[20px] border border-dashed border-slate-200/50 bg-white/30 flex items-center justify-center">
              <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">
                No Candidates
              </span>
            </div>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  );
}

// ── Shared filter panel ───────────────────────────────────────────────────────

function FilterPanel({
  view,
  jobs,
  candidates,
  canReadCandidates,
  filterJobId,
  filterCandidateId,
  filterStage,
  filterStatus,
  // Kanban-only
  clientFilterOptions,
  selectedClientId,
  hasClients,
  onClientChange,
  onJobChange,
  onCandidateChange,
  onStageChange,
  onStatusChange,
  onReset,
  hasActiveFilters,
}: {
  view: ViewMode;
  jobs: Job[];
  candidates: Candidate[];
  canReadCandidates: boolean;
  filterJobId: string;
  filterCandidateId: string;
  filterStage: PipelineStage | "";
  filterStatus: PipelineStatus | "";
  clientFilterOptions: { id: string; label: string }[];
  selectedClientId: string;
  hasClients: boolean;
  onClientChange: (v: string) => void;
  onJobChange: (v: string) => void;
  onCandidateChange: (v: string) => void;
  onStageChange: (v: PipelineStage | "") => void;
  onStatusChange: (v: PipelineStatus | "") => void;
  onReset: () => void;
  hasActiveFilters: boolean;
}) {
  const selectCls =
    "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm outline-none transition focus:border-[#FF5A1F] focus:ring-1 focus:ring-[#FF5A1F]/30";
  const labelCls =
    "mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-400";

  // In kanban view the job label reads "Select Job" and is required context
  const jobPlaceholder =
    view === "kanban" ? "Select a job…" : "All Jobs";

  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <Filter className="h-4 w-4 text-slate-400" />
        <span className="text-[13px] font-bold text-slate-600 uppercase tracking-wide">
          Filters
        </span>
        {view === "kanban" && (
          <span className="ml-1 text-[11px] text-slate-400">
            — select a job to load the board
          </span>
        )}
        {hasActiveFilters && (
          <button
            type="button"
            onClick={onReset}
            className="ml-auto flex items-center gap-1 text-[11px] font-semibold text-red-400 hover:text-red-600 transition-colors"
          >
            <XCircle className="h-3.5 w-3.5" />
            Clear all
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        {/* Client filter — kanban only, only when org has jobs with client_id */}
        {view === "kanban" && hasClients && (
          <div>
            <label className={labelCls}>Client</label>
            <select
              className={selectCls}
              value={selectedClientId}
              onChange={(e) => onClientChange(e.target.value)}
            >
              <option value="">All Clients</option>
              {clientFilterOptions.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Job filter */}
        <div>
          <label className={labelCls}>Job</label>
          <select
            className={selectCls}
            value={filterJobId}
            onChange={(e) => onJobChange(e.target.value)}
          >
            <option value="">{jobPlaceholder}</option>
            {jobs
              .filter(
                (j) =>
                  view !== "kanban" ||
                  !selectedClientId ||
                  j.client_id === selectedClientId
              )
              .map((job) => (
                <option key={job.id} value={job.id}>
                  {job.title}
                </option>
              ))}
          </select>
        </div>

        {/* Candidate filter — shown only when readable + table view */}
        {canReadCandidates && view === "table" && (
          <div>
            <label className={labelCls}>Candidate</label>
            <select
              className={selectCls}
              value={filterCandidateId}
              onChange={(e) => onCandidateChange(e.target.value)}
            >
              <option value="">All Candidates</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.first_name} {c.last_name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Stage filter */}
        <div>
          <label className={labelCls}>
            Stage
            {view === "kanban" && filterStage && (
              <span className="ml-1 font-normal text-slate-300">
                (hides other columns)
              </span>
            )}
          </label>
          <select
            className={selectCls}
            value={filterStage}
            onChange={(e) =>
              onStageChange(e.target.value as PipelineStage | "")
            }
          >
            <option value="">All Stages</option>
            {ALL_STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS_TABLE[s]}
              </option>
            ))}
          </select>
        </div>

        {/* Status filter */}
        <div>
          <label className={labelCls}>
            Status
            {view === "kanban" && filterStatus && (
              <span className="ml-1 font-normal text-slate-300">
                (hides non-matching cards)
              </span>
            )}
          </label>
          <select
            className={selectCls}
            value={filterStatus}
            onChange={(e) =>
              onStatusChange(e.target.value as PipelineStatus | "")
            }
          >
            <option value="">All Statuses</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PipelineWorkspacePage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── View toggle ──────────────────────────────────────────────────────────────
  const viewParam = searchParams.get("view");
  const view: ViewMode =
    viewParam === "kanban" ? "kanban" : "table";

  function setView(v: ViewMode) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", v);
    router.replace(`/pipelines?${params.toString()}`);
  }

  // ── Permissions ──────────────────────────────────────────────────────────────
  const permissions = useAuthStore((s) => s.permissions);
  const canUpdatePipeline = hasPermission(permissions, PIPELINE_UPDATE_PERMISSION);
  const canReadCandidates =
    permissions.includes("candidates:read") ||
    permissions.includes("candidates:read_own");

  // ── Shared reference data ─────────────────────────────────────────────────────
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [refLoading, setRefLoading] = useState(false);

  // ── Shared filter state ───────────────────────────────────────────────────────
  const [filterJobId, setFilterJobId] = useState("");
  const [filterCandidateId, setFilterCandidateId] = useState("");
  const [filterStage, setFilterStage] = useState<PipelineStage | "">("");
  const [filterStatus, setFilterStatus] = useState<PipelineStatus | "">("");

  // ── Kanban-only state ─────────────────────────────────────────────────────────
  const [selectedClientId, setSelectedClientId] = useState("");
  const [clientNameById, setClientNameById] = useState<Record<string, string>>(
    {}
  );
  const [kanbanPipelines, setKanbanPipelines] = useState<Pipeline[]>([]);
  const [kanbanLoading, setKanbanLoading] = useState(false);
  const [kanbanError, setKanbanError] = useState<string | null>(null);
  const [movingPipelineId, setMovingPipelineId] = useState<string | null>(null);
  const [activePipelineId, setActivePipelineId] = useState<string | null>(null);
  const [atsByCandidateId, setAtsByCandidateId] = useState<
    Record<
      string,
      {
        score: number;
        recommendation: string;
        recruiter_summary?: string | null;
        ai_enrichment_status?: string | null;
      }
    >
  >({});
  const [screeningsByCandidateId, setScreeningsByCandidateId] = useState<
    Record<string, AIScreeningListItem>
  >({});
  const [startScreeningTarget, setStartScreeningTarget] = useState<{
    pipeline: Pipeline;
    candidate: Candidate;
  } | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Pipeline | null>(null);
  const [sortMode, setSortMode] = useState<"ats_desc" | "newest" | "updated">(
    "ats_desc"
  );

  const pipelineLoadSeqRef = useRef(0);
  const rescoreRequestedJobIdsRef = useRef<Set<string>>(new Set());

  // ── Table-only state ──────────────────────────────────────────────────────────
  const [tablePipelines, setTablePipelines] = useState<Pipeline[]>([]);
  const [tableMeta, setTableMeta] = useState<PipelineListMeta | null>(null);
  const [tableLoading, setTableLoading] = useState(false);
  const [tableError, setTableError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"created_at" | "stage_updated_at">(
    "created_at"
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [limit, setLimit] = useState<20 | 50 | 100>(50);
  const [offset, setOffset] = useState(0);

  // ── Load reference data once ──────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      setRefLoading(true);
      try {
        async function fetchActiveCandidates() {
          const pageSize = 200;
          let off = 0;
          const all: Candidate[] = [];
          while (true) {
            const batch = await getCandidates(pageSize, off, {
              status: "active",
            });
            all.push(...batch);
            if (batch.length < pageSize) break;
            off += pageSize;
          }
          return all;
        }
        const [candidateData, jobData, clientData] = await Promise.all([
          canReadCandidates ? fetchActiveCandidates() : Promise.resolve([]),
          getJobs(200, 0),
          listAllClients().catch(() => []),
        ]);
        setCandidates(candidateData);
        setJobs(jobData.filter((j) => j.status === "open"));
        const names: Record<string, string> = {};
        for (const client of clientData) {
          names[String(client.id)] = client.name;
        }
        setClientNameById(names);
      } catch {
        // Non-critical — filters degrade gracefully.
      } finally {
        setRefLoading(false);
      }
    }
    void load();
  }, [canReadCandidates]);

  // ── Kanban: load pipelines for selected job ───────────────────────────────────
  async function loadKanbanPipelines(jobId: string) {
    const seq = ++pipelineLoadSeqRef.current;
    setKanbanLoading(true);
    setKanbanError(null);
    try {
      const [pipelineData, atsMatches] = await Promise.all([
        getPipelines(200, 0, jobId),
        getJobMatchesAts(jobId, { limit: 200, offset: 0, sort_by: "score_desc" }),
      ]);
      if (seq !== pipelineLoadSeqRef.current) return;
      setKanbanPipelines(pipelineData);

      const nextAts: typeof atsByCandidateId = {};
      for (const item of atsMatches.matches) {
        const rawId =
          typeof item.candidate_id === "string"
            ? item.candidate_id
            : String(item.candidate_id);
        const cid = normalizeCandidateId(rawId);
        if (!cid) continue;
        const summary = item.recruiter_summary?.trim();
        nextAts[cid] = {
          score: item.fit_score,
          recommendation: item.recommendation?.trim() ?? "",
          recruiter_summary: summary
            ? summary.length > 160
              ? `${summary.slice(0, 157)}…`
              : summary
            : null,
          ai_enrichment_status: item.ai_enrichment_status,
        };
      }
      setAtsByCandidateId(nextAts);

      void listScreenings({ job_id: jobId, limit: 200 })
        .then((screenings) => {
          const byCandidate: Record<string, AIScreeningListItem> = {};
          for (const s of screenings) {
            const cid =
              typeof s.candidate_id === "string"
                ? s.candidate_id
                : String(s.candidate_id);
            if (!byCandidate[cid]) byCandidate[cid] = s;
          }
          setScreeningsByCandidateId(byCandidate);
        })
        .catch(() => {});

      const hasUnscored = pipelineData.some(
        (p) => !nextAts[normalizeCandidateId(p.candidate_id)]
      );
      if (
        pipelineData.length > 0 &&
        hasUnscored &&
        !rescoreRequestedJobIdsRef.current.has(jobId)
      ) {
        rescoreRequestedJobIdsRef.current.add(jobId);
        void rescoreJobAts(jobId).catch(() => {});
      }
    } catch (err) {
      if (seq !== pipelineLoadSeqRef.current) return;
      setKanbanError(
        err instanceof ApiError ? err.message : "Unable to load pipeline board."
      );
    } finally {
      if (seq === pipelineLoadSeqRef.current) setKanbanLoading(false);
    }
  }

  // Kanban 25-second auto-refresh.
  useEffect(() => {
    if (view !== "kanban" || !filterJobId) return;
    const interval = window.setInterval(() => {
      void loadKanbanPipelines(filterJobId);
    }, 25000);
    return () => window.clearInterval(interval);
  }, [view, filterJobId]);

  // Load kanban data when job changes or view switches to kanban.
  useEffect(() => {
    if (view === "kanban" && filterJobId) {
      void loadKanbanPipelines(filterJobId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, filterJobId]);

  // ── Table: load pipelines ─────────────────────────────────────────────────────
  const loadTablePipelines = useCallback(async () => {
    setTableLoading(true);
    setTableError(null);
    try {
      const response = await getPipelinesWithMeta({
        limit,
        offset,
        jobId: filterJobId || undefined,
        candidateId: filterCandidateId || undefined,
        // Pass client_id to backend for server-side filtering (table view).
        // This ensures admin and recruiter both get correct client-scoped results
        // without client-side guessing.
        clientId: selectedClientId || undefined,
        stage: (filterStage as PipelineStage) || undefined,
        status: (filterStatus as PipelineStatus) || undefined,
        sortBy,
        sortDir,
      });
      setTablePipelines(response.data);
      setTableMeta(response.meta);
    } catch (err) {
      setTableError(
        err instanceof ApiError ? err.message : "Failed to load pipelines."
      );
    } finally {
      setTableLoading(false);
    }
  }, [limit, offset, filterJobId, filterCandidateId, selectedClientId, filterStage, filterStatus, sortBy, sortDir]);

  useEffect(() => {
    if (view === "table") {
      void loadTablePipelines();
    }
  }, [view, loadTablePipelines]);

  // ── Derived: client filter options ───────────────────────────────────────────
  // Built from three sources (in priority order):
  //  1. pipeline.client_name/client_id — embedded by the backend list endpoint
  //  2. job.client_name — embedded in the jobs response
  //  3. clientNameById — separately fetched via listAllClients()
  // Using all three sources ensures client options appear even when the jobs list
  // is scoped (e.g. a recruiter who doesn't directly see Default Client jobs but
  // whose pipelines still reference them).
  const clientFilterOptions = useMemo(() => {
    const seen = new Map<string, string>();

    // Source 1: pipeline entries from both table and kanban views.
    for (const p of [...tablePipelines, ...kanbanPipelines]) {
      const cid = p.client_id;
      if (!cid) continue;
      const label =
        p.client_name?.trim() ||
        clientNameById[cid]?.trim() ||
        `Client ${cid.slice(0, 8)}`;
      seen.set(cid, label);
    }

    // Source 2: jobs list (recruiter-scoped but includes Default Client jobs via backend fix).
    for (const j of jobs) {
      if (!j.client_id) continue;
      if (seen.has(j.client_id)) continue; // already set from pipeline — higher fidelity
      const label =
        j.client_name?.trim() ||
        clientNameById[j.client_id]?.trim() ||
        `Client ${j.client_id.slice(0, 8)}`;
      seen.set(j.client_id, label);
    }

    return Array.from(seen.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  }, [jobs, clientNameById, tablePipelines, kanbanPipelines]);

  const hasClients =
    jobs.some((j) => j.client_id) ||
    tablePipelines.some((p) => p.client_id) ||
    kanbanPipelines.some((p) => p.client_id);

  // ── Derived: kanban grouped board ────────────────────────────────────────────
  const candidateMap = useMemo(
    () => new Map(candidates.map((c) => [normalizeCandidateId(c.id), c])),
    [candidates]
  );
  const candidateMapById = useMemo(
    () => new Map(candidates.map((c) => [c.id, c])),
    [candidates]
  );
  const jobMapById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);

  const grouped = useMemo(() => {
    return BOARD_STAGES.reduce<
      Record<
        BoardStage,
        Array<{ pipeline: Pipeline; candidate: Candidate | undefined }>
      >
    >((acc, stage) => {
      acc[stage] = kanbanPipelines
        .filter((p) => {
          if (toBoardStage(p.stage) !== stage) return false;
          // Status client-side filter for kanban
          if (filterStatus && p.status !== filterStatus) return false;
          return true;
        })
        .map((p) => ({
          pipeline: p,
          candidate: candidateMap.get(normalizeCandidateId(p.candidate_id)),
        }))
        .filter((item) => Boolean(item.candidate))
        .sort((a, b) => {
          if (sortMode === "newest")
            return (
              new Date(b.pipeline.created_at).getTime() -
              new Date(a.pipeline.created_at).getTime()
            );
          if (sortMode === "updated")
            return (
              new Date(b.pipeline.updated_at).getTime() -
              new Date(a.pipeline.updated_at).getTime()
            );
          return (
            (atsByCandidateId[normalizeCandidateId(b.pipeline.candidate_id)]
              ?.score ?? -1) -
            (atsByCandidateId[normalizeCandidateId(a.pipeline.candidate_id)]
              ?.score ?? -1)
          );
        });
      return acc;
    }, {} as Record<BoardStage, Array<{ pipeline: Pipeline; candidate: Candidate | undefined }>>);
  }, [candidates, kanbanPipelines, atsByCandidateId, sortMode, filterStatus, candidateMap]);

  const pipelineById = useMemo(
    () => new Map(kanbanPipelines.map((p) => [p.id, p])),
    [kanbanPipelines]
  );
  const activePipeline = activePipelineId
    ? pipelineById.get(activePipelineId)
    : undefined;

  // ── Kanban DnD ────────────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 10 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
    useSensor(KeyboardSensor)
  );

  function resolveStageFromDropId(dropId: string): BoardStage | null {
    if (BOARD_STAGES.includes(dropId as BoardStage)) return dropId as BoardStage;
    const dp = pipelineById.get(dropId);
    return dp ? toBoardStage(dp.stage) : null;
  }

  async function moveCandidateToStage(
    pipelineId: string,
    sourceStage: BoardStage,
    targetStage: BoardStage
  ) {
    if (movingPipelineId || !filterJobId || sourceStage === targetStage) return;
    setKanbanError(null);
    setMovingPipelineId(pipelineId);
    setKanbanPipelines((prev) =>
      prev.map((p) =>
        p.id === pipelineId
          ? { ...p, stage: toPipelineStage(targetStage) }
          : p
      )
    );
    try {
      await transitionPipelineStage(pipelineId, {
        stage: toPipelineStage(targetStage),
      });
    } catch (err) {
      setKanbanPipelines((prev) =>
        prev.map((p) =>
          p.id === pipelineId
            ? { ...p, stage: toPipelineStage(sourceStage) }
            : p
        )
      );
      setKanbanError(
        err instanceof ApiError ? err.message : "Unable to move candidate."
      );
    } finally {
      setMovingPipelineId(null);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActivePipelineId(null);
    if (!canUpdatePipeline || movingPipelineId) return;
    const sourceId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId) return;
    const sourcePipeline = pipelineById.get(sourceId);
    if (!sourcePipeline) return;
    const sourceStage = toBoardStage(sourcePipeline.stage);
    const targetStage = resolveStageFromDropId(overId);
    if (!targetStage || sourceStage === targetStage) return;
    if (targetStage === "rejected") {
      setRejectTarget(sourcePipeline);
      return;
    }
    const fromPipeline = sourcePipeline.stage;
    const toPipeline = toPipelineStage(targetStage);
    if (!canTransition(fromPipeline, toPipeline)) {
      const allowed = Array.from(VALID_TRANSITIONS[fromPipeline] ?? [])
        .filter((s) => s !== "rejected")
        .map((s) => toBoardStage(s as Pipeline["stage"]))
        .map((s) => BOARD_STAGE_LABELS[s])
        .join(", ");
      setKanbanError(
        allowed
          ? `Cannot move from ${BOARD_STAGE_LABELS[sourceStage]} directly to ${BOARD_STAGE_LABELS[targetStage]}. Next allowed: ${allowed}.`
          : `${BOARD_STAGE_LABELS[sourceStage]} is a terminal stage and cannot be moved.`
      );
      return;
    }
    await moveCandidateToStage(sourceId, sourceStage, targetStage);
  }

  // ── Shared filter handlers ─────────────────────────────────────────────────────
  function handleJobChange(jobId: string) {
    setFilterJobId(jobId);
    setOffset(0);
    // In kanban, clear board if no job selected.
    if (!jobId && view === "kanban") {
      setKanbanPipelines([]);
      setAtsByCandidateId({});
    }
  }

  function handleClientChange(clientId: string) {
    setSelectedClientId(clientId);
    // If the current job doesn't belong to the new client, clear job.
    if (clientId && filterJobId) {
      const job = jobs.find((j) => j.id === filterJobId);
      if (job && job.client_id !== clientId) {
        setFilterJobId("");
        setKanbanPipelines([]);
      }
    }
  }

  function resetFilters() {
    setFilterJobId("");
    setFilterCandidateId("");
    setFilterStage("");
    setFilterStatus("");
    setSelectedClientId("");
    setSortBy("created_at");
    setSortDir("desc");
    setOffset(0);
    if (view === "kanban") {
      setKanbanPipelines([]);
      setAtsByCandidateId({});
    }
  }

  const hasActiveFilters = Boolean(
    filterJobId || filterCandidateId || filterStage || filterStatus || selectedClientId
  );

  // ── Table sort / pagination ───────────────────────────────────────────────────
  function toggleSort(col: "created_at" | "stage_updated_at") {
    if (sortBy === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(col);
      setSortDir("desc");
    }
    setOffset(0);
  }

  const currentPage = tableMeta ? Math.floor(offset / limit) + 1 : 1;
  const totalPages = tableMeta ? Math.ceil(tableMeta.total / limit) : 1;

  function fmtDate(iso: string | null | undefined) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  // ── Kanban: visible stages (respect filterStage) ──────────────────────────────
  const visibleBoardStages = useMemo(() => {
    if (!filterStage) return BOARD_STAGES;
    const boardEquiv = toBoardStage(filterStage as Pipeline["stage"]);
    // If the filter stage maps to a known board stage, show only that one
    return BOARD_STAGES.filter((s) => s === boardEquiv);
  }, [filterStage]);

  // ── Render ─────────────────────────────────────────────────────────────────────
  return (
    <section className="min-w-0 space-y-6 pb-12">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Pipeline
          </h1>
          {view === "table" && tableMeta && (
            <p className="mt-0.5 text-sm text-slate-500">
              {tableMeta.total.toLocaleString()} pipeline
              {tableMeta.total !== 1 ? "s" : ""} total
            </p>
          )}
          {view === "kanban" && filterJobId && (
            <p className="mt-0.5 text-sm text-slate-500">
              {jobMapById.get(filterJobId)?.title ?? ""}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* View toggle */}
          <ViewToggle view={view} onChange={setView} />

          {/* Refresh */}
          <Button
            variant="outline"
            size="sm"
            disabled={
              view === "table" ? tableLoading : kanbanLoading || !filterJobId
            }
            onClick={() => {
              if (view === "table") void loadTablePipelines();
              else if (filterJobId) void loadKanbanPipelines(filterJobId);
            }}
            className="gap-1.5"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${
                view === "table" ? tableLoading : kanbanLoading
                  ? "animate-spin"
                  : ""
              }`}
            />
            Refresh
          </Button>

          {/* Kanban sort mode */}
          {view === "kanban" && (
            <select
              className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 shadow-sm"
              value={sortMode}
              onChange={(e) =>
                setSortMode(
                  e.target.value as "ats_desc" | "newest" | "updated"
                )
              }
            >
              <option value="ats_desc">ATS Score ↓</option>
              <option value="newest">Newest</option>
              <option value="updated">Recently Updated</option>
            </select>
          )}
        </div>
      </div>

      {/* ── Stage count pills (table view only) ──────────────────────────── */}
      {view === "table" && tableMeta && Object.keys(tableMeta.stage_counts).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {ALL_STAGES.filter((s) => (tableMeta.stage_counts[s] ?? 0) > 0).map(
            (s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setFilterStage(filterStage === s ? "" : s);
                  setOffset(0);
                }}
                className={`transition-all ${
                  filterStage === s
                    ? "ring-2 ring-offset-1 ring-slate-400"
                    : "opacity-80 hover:opacity-100"
                }`}
              >
                <StagePill stage={s} count={tableMeta.stage_counts[s] ?? 0} />
              </button>
            )
          )}
        </div>
      )}

      {/* ── Shared filter panel ───────────────────────────────────────────── */}
      <FilterPanel
        view={view}
        jobs={jobs}
        candidates={candidates}
        canReadCandidates={canReadCandidates}
        filterJobId={filterJobId}
        filterCandidateId={filterCandidateId}
        filterStage={filterStage}
        filterStatus={filterStatus}
        clientFilterOptions={clientFilterOptions}
        selectedClientId={selectedClientId}
        hasClients={hasClients}
        onClientChange={handleClientChange}
        onJobChange={handleJobChange}
        onCandidateChange={(v) => { setFilterCandidateId(v); setOffset(0); }}
        onStageChange={(v) => { setFilterStage(v); setOffset(0); }}
        onStatusChange={(v) => { setFilterStatus(v); setOffset(0); }}
        onReset={resetFilters}
        hasActiveFilters={hasActiveFilters}
      />

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* TABLE VIEW                                                       */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      {view === "table" && (
        <>
          {tableError && (
            <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
              {tableError}
            </div>
          )}

          <div className="rounded-2xl border border-slate-100 bg-white shadow-sm overflow-hidden">
            {/* Table toolbar */}
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-slate-500 font-medium">
                  Rows per page:
                </span>
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => {
                      setLimit(size as 20 | 50 | 100);
                      setOffset(0);
                    }}
                    className={`rounded-md px-2.5 py-1 text-[12px] font-bold transition-colors ${
                      limit === size
                        ? "bg-[#FF5A1F] text-white"
                        : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                    }`}
                  >
                    {size}
                  </button>
                ))}
              </div>
              {tableMeta && (
                <span className="text-[12px] text-slate-400 font-medium">
                  {offset + 1}–{Math.min(offset + limit, tableMeta.total)} of{" "}
                  {tableMeta.total.toLocaleString()}
                </span>
              )}
            </div>

            {/* Loading */}
            {tableLoading && (
              <div className="flex items-center justify-center py-16">
                <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
                <span className="ml-2 text-sm text-slate-500">
                  Loading pipelines…
                </span>
              </div>
            )}

            {/* Empty */}
            {!tableLoading && tablePipelines.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                <svg
                  className="mb-4 h-10 w-10 text-slate-200"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1"
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                  />
                </svg>
                <p className="text-sm font-medium">
                  {hasActiveFilters
                    ? "No pipelines match your filters."
                    : "No pipelines found."}
                </p>
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="mt-2 text-sm font-semibold text-[#FF5A1F] hover:underline"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            )}

            {/* Table */}
            {!tableLoading && tablePipelines.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px]">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/60">
                      <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                        Candidate
                      </th>
                      <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                        Job
                      </th>
                      <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                        Stage
                      </th>
                      <th className="px-5 py-3 text-left">
                        <button
                          type="button"
                          onClick={() => toggleSort("stage_updated_at")}
                          className="flex items-center text-[11px] font-bold uppercase tracking-wider text-slate-500 hover:text-slate-800 transition-colors"
                        >
                          Stage Updated
                          <SortIcon
                            col="stage_updated_at"
                            sortBy={sortBy}
                            sortDir={sortDir}
                          />
                        </button>
                      </th>
                      <th className="px-5 py-3 text-left">
                        <button
                          type="button"
                          onClick={() => toggleSort("created_at")}
                          className="flex items-center text-[11px] font-bold uppercase tracking-wider text-slate-500 hover:text-slate-800 transition-colors"
                        >
                          Applied
                          <SortIcon
                            col="created_at"
                            sortBy={sortBy}
                            sortDir={sortDir}
                          />
                        </button>
                      </th>
                      <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                        Status
                      </th>
                      <th className="px-5 py-3 text-right text-[11px] font-bold uppercase tracking-wider text-slate-500">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {tablePipelines.map((pipeline) => {
                      const candidate = candidateMapById.get(
                        pipeline.candidate_id
                      );
                      const job = jobMapById.get(pipeline.job_id);
                      return (
                        <tr
                          key={pipeline.id}
                          className="group transition-colors hover:bg-slate-50/50"
                        >
                          <td className="px-5 py-3.5">
                            <Link
                              href={`/candidates/${pipeline.candidate_id}`}
                              className="flex items-center gap-2.5"
                            >
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-bold text-slate-600 group-hover:bg-orange-50 group-hover:text-[#FF5A1F] transition-colors">
                                {candidate
                                  ? `${candidate.first_name.charAt(0)}${candidate.last_name.charAt(0)}`
                                  : "?"}
                              </div>
                              <div className="min-w-0">
                                <p className="truncate text-[13px] font-semibold text-slate-800 group-hover:text-[#FF5A1F] transition-colors">
                                  {candidate ? (
                                    `${candidate.first_name} ${candidate.last_name}`
                                  ) : (
                                    <span className="font-mono text-[11px] text-slate-400">
                                      {pipeline.candidate_id.slice(0, 8)}…
                                    </span>
                                  )}
                                </p>
                                {candidate?.role && (
                                  <p className="truncate text-[11px] text-slate-400">
                                    {candidate.role}
                                  </p>
                                )}
                              </div>
                            </Link>
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="min-w-0">
                              {(pipeline.client_name || (job && (job.client_name || clientNameById[job.client_id ?? ""]))) && (
                                <p className="truncate text-[10px] font-semibold text-orange-500 uppercase tracking-wide mb-0.5">
                                  {pipeline.client_name ||
                                    job?.client_name ||
                                    (job?.client_id ? clientNameById[job.client_id] : null)}
                                </p>
                              )}
                              {job ? (
                                <Link
                                  href={`/jobs/${pipeline.job_id}`}
                                  className="text-[13px] font-medium text-slate-700 hover:text-[#FF5A1F] transition-colors truncate block max-w-[200px]"
                                >
                                  {job.title}
                                </Link>
                              ) : pipeline.job_title ? (
                                <Link
                                  href={`/jobs/${pipeline.job_id}`}
                                  className="text-[13px] font-medium text-slate-700 hover:text-[#FF5A1F] transition-colors truncate block max-w-[200px]"
                                >
                                  {pipeline.job_title}
                                </Link>
                              ) : (
                                <span className="font-mono text-[11px] text-slate-400">
                                  {pipeline.job_id.slice(0, 8)}…
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            <StageBadge stage={pipeline.stage} />
                          </td>
                          <td className="px-5 py-3.5 text-[12px] text-slate-500 whitespace-nowrap">
                            {fmtDate(pipeline.stage_updated_at)}
                          </td>
                          <td className="px-5 py-3.5 text-[12px] text-slate-500 whitespace-nowrap">
                            {fmtDate(pipeline.created_at)}
                          </td>
                          <td className="px-5 py-3.5">
                            <StatusBadge status={pipeline.status} />
                          </td>
                          <td className="px-5 py-3.5 text-right">
                            <Link
                              href={`/candidates/${pipeline.candidate_id}`}
                              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-600 hover:border-[#FF5A1F] hover:text-[#FF5A1F] transition-colors shadow-sm"
                            >
                              View
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination */}
            {!tableLoading && tableMeta && tableMeta.total > limit && (
              <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() =>
                    setOffset(Math.max(0, (currentPage - 2) * limit))
                  }
                  className="gap-1"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
                <div className="flex items-center gap-2">
                  {Array.from(
                    { length: Math.min(totalPages, 7) },
                    (_, i) => {
                      let page: number | null = null;
                      if (totalPages <= 7) {
                        page = i + 1;
                      } else {
                        const pages = new Set(
                          [
                            1,
                            totalPages,
                            currentPage,
                            currentPage - 1,
                            currentPage + 1,
                          ].filter((p) => p >= 1 && p <= totalPages)
                        );
                        const sorted = Array.from(pages).sort(
                          (a, b) => a - b
                        );
                        page = sorted[i] ?? null;
                      }
                      if (!page) return null;
                      return (
                        <button
                          key={page}
                          type="button"
                          onClick={() =>
                            setOffset(Math.max(0, (page! - 1) * limit))
                          }
                          className={`flex h-7 w-7 items-center justify-center rounded-md text-[12px] font-bold transition-colors ${
                            page === currentPage
                              ? "bg-[#FF5A1F] text-white"
                              : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                          }`}
                        >
                          {page}
                        </button>
                      );
                    }
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage >= totalPages}
                  onClick={() => setOffset(currentPage * limit)}
                  className="gap-1"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* KANBAN VIEW                                                       */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      {view === "kanban" && (
        <>
          {kanbanError && (
            <p className="text-sm font-medium text-red-600">{kanbanError}</p>
          )}

          {/* No job selected */}
          {!filterJobId && (
            <div className="rounded-[20px] shadow-[0_2px_12px_rgba(0,0,0,0.02)] bg-white border border-slate-100/50">
              <div className="py-20 flex flex-col items-center justify-center text-slate-400">
                <svg
                  className="w-12 h-12 mb-4 text-slate-200"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1"
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                  />
                </svg>
                <p className="text-sm font-medium">
                  Select a job above to load its candidate pipeline.
                </p>
              </div>
            </div>
          )}

          {/* Loading */}
          {filterJobId && kanbanLoading && (
            <p className="text-sm font-medium text-slate-500">
              Loading pipeline…
            </p>
          )}

          {/* Empty board */}
          {filterJobId && !kanbanLoading && kanbanPipelines.length === 0 && (
            <div className="rounded-[20px] shadow-[0_2px_12px_rgba(0,0,0,0.02)] bg-white border border-slate-100/50">
              <div className="py-20 flex flex-col items-center justify-center text-slate-400">
                <svg
                  className="w-12 h-12 mb-4 text-slate-200"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1"
                    d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                  />
                </svg>
                <p className="text-sm font-medium">
                  No candidates submitted to this job yet.
                </p>
              </div>
            </div>
          )}

          {/* Board */}
          {filterJobId && !kanbanLoading && kanbanPipelines.length > 0 && (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCorners}
              onDragStart={(e) => setActivePipelineId(String(e.active.id))}
              onDragEnd={(e) => void handleDragEnd(e)}
              onDragCancel={() => setActivePipelineId(null)}
            >
              <div className="max-w-full overflow-x-auto overscroll-x-contain pb-4 touch-pan-x [scrollbar-gutter:stable_both-edges] [scrollbar-color:rgb(148_163_184)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-400/80 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:h-2">
                <div
                  className="flex items-start gap-6 pr-6"
                  style={{
                    minWidth: `${visibleBoardStages.length * 364}px`,
                  }}
                >
                  {visibleBoardStages.map((stage) => {
                    let isValidDropTarget = true;
                    if (activePipelineId) {
                      const draggedPipeline = pipelineById.get(activePipelineId);
                      if (draggedPipeline) {
                        const tgt = toPipelineStage(stage);
                        const isSameStage =
                          toBoardStage(draggedPipeline.stage) === stage;
                        isValidDropTarget =
                          isSameStage || canTransition(draggedPipeline.stage, tgt);
                      }
                    }
                    return (
                      <StageColumn
                        key={stage}
                        stage={stage}
                        count={grouped[stage]?.length ?? 0}
                        isDropEnabled={canUpdatePipeline}
                        activePipelineId={activePipelineId}
                        isValidDropTarget={isValidDropTarget}
                      >
                        {grouped[stage]?.map(({ pipeline, candidate }) => {
                          const ats =
                            atsByCandidateId[
                              normalizeCandidateId(pipeline.candidate_id)
                            ];
                          const cidStr = normalizeCandidateId(
                            pipeline.candidate_id
                          );
                          const aiScreening =
                            screeningsByCandidateId[cidStr] ?? null;
                          return (
                            <DraggableCandidateCard
                              key={pipeline.id}
                              pipeline={pipeline}
                              candidate={candidate}
                              atsScore={ats?.score}
                              recommendation={ats?.recommendation}
                              semanticInsight={
                                ats?.ai_enrichment_status === "complete"
                                  ? ats?.recruiter_summary
                                  : null
                              }
                              aiEnrichmentStatus={ats?.ai_enrichment_status}
                              awaitingAtsMatch={!ats}
                              boardLoading={kanbanLoading}
                              isTopMatch={(ats?.score ?? -1) >= 85}
                              canDrag={
                                canUpdatePipeline &&
                                movingPipelineId === null &&
                                pipeline.stage !== "placed" &&
                                (pipeline.stage as string) !== "rejected"
                              }
                              isMoving={movingPipelineId === pipeline.id}
                              aiScreening={aiScreening}
                              onStartScreening={
                                candidate
                                  ? () =>
                                      setStartScreeningTarget({
                                        pipeline,
                                        candidate,
                                      })
                                  : undefined
                              }
                              canReject={
                                canUpdatePipeline &&
                                pipeline.stage !== "placed" &&
                                pipeline.stage !== "rejected"
                              }
                              onReject={setRejectTarget}
                            />
                          );
                        })}
                      </StageColumn>
                    );
                  })}
                </div>
              </div>

              <DragOverlay dropAnimation={null}>
                {activePipeline ? (
                  <div className="w-[320px] -rotate-1 scale-105 opacity-100 shadow-[0_20px_50px_rgba(0,0,0,0.2)]">
                    {(() => {
                      const ats =
                        atsByCandidateId[
                          normalizeCandidateId(activePipeline.candidate_id)
                        ];
                      return (
                        <CandidateCard
                          pipeline={activePipeline}
                          candidate={candidateMap.get(
                            normalizeCandidateId(activePipeline.candidate_id)
                          )}
                          atsScore={ats?.score}
                          recommendation={ats?.recommendation}
                          semanticInsight={
                            ats?.ai_enrichment_status === "complete"
                              ? ats?.recruiter_summary
                              : null
                          }
                          aiEnrichmentStatus={ats?.ai_enrichment_status}
                          awaitingAtsMatch={!ats}
                          boardLoading={kanbanLoading}
                          isTopMatch={(ats?.score ?? -1) >= 85}
                          isMoving={false}
                        />
                      );
                    })()}
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          )}

          {/* AI Screening modal */}
          {startScreeningTarget && (
            <StartScreeningModal
              candidateId={startScreeningTarget.candidate.id}
              candidateName={`${startScreeningTarget.candidate.first_name} ${startScreeningTarget.candidate.last_name}`}
              jobId={filterJobId || undefined}
              jobTitle={jobMapById.get(filterJobId)?.title}
              pipelineId={startScreeningTarget.pipeline.id}
              onClose={() => setStartScreeningTarget(null)}
              onStarted={(screeningId) => {
                setStartScreeningTarget(null);
                void loadKanbanPipelines(filterJobId);
                window.open(`/ai-screenings/${screeningId}`, "_blank");
              }}
            />
          )}

          {/* Reject modal */}
          {rejectTarget && (
            <RejectCandidateModal
              pipeline={rejectTarget}
              candidateName={(() => {
                const c = candidates.find(
                  (c) =>
                    normalizeCandidateId(c.id) ===
                    normalizeCandidateId(rejectTarget.candidate_id)
                );
                return c ? `${c.first_name} ${c.last_name}` : undefined;
              })()}
              onSuccess={(updated) => {
                setKanbanPipelines((prev) =>
                  prev.map((p) => (p.id === updated.id ? updated : p))
                );
                setRejectTarget(null);
              }}
              onCancel={() => setRejectTarget(null)}
            />
          )}
        </>
      )}
    </section>
  );
}

"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { ApiError } from "@/lib/api/client";
import { getJobById, getJobCandidates, getJobSubmissions, updateJob, deleteJob, changeJobStatus } from "@/lib/api/jobs";
import { listAllClients } from "@/lib/api/clients";
import { getPipelines } from "@/lib/api/pipeline";
import {
  atsAwaitingSemanticEnrichment,
  getJobMatchesAts,
  pollAtsPairStatusesUntilSettled,
  pollJobMatchesUntilEnriched,
  rescoreJobAts,
} from "@/lib/api/ats";
import type { Client, Job, JobCandidateListItem, JobMatchEntry, JobSubmission, JobStatus, Pipeline } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ATSRecommendationBadge } from "@/components/ats/ats-recommendation-badge";
import { ATSScoreBadge } from "@/components/ats/ats-score-badge";
import { ATSMatchBreakdownPanel } from "@/components/ats/ats-match-breakdown-panel";
import { DocumentCard } from "@/components/documents/DocumentCard";
import { normalizeCandidateId } from "@/lib/ats/candidate-id";
import { isAdminRole } from "@/lib/dashboard-nav";
import { useAuthStore } from "@/store/auth-store";
import { 
  Clipboard, 
  Search,
  CheckCircle2,
  ChevronRight,
  Zap,
  ArrowLeft,
  Users,
  Target,
  Calendar,
  Sparkles,
  ArrowRight,
  X,
  FileText,
  Layers,
  Briefcase,
  Edit3,
  Trash2,
  MoreVertical,
  MapPin,
  Clock,
} from "lucide-react";

// ─── components ─────────────────────────────────────────────────────────────

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${className || ""}`}>
      {children}
    </span>
  );
}

// ─── formatting helpers ─────────────────────────────────────────────────────


const formatDate = (d: string | null | undefined) => {
  if (!d) return "Not available";
  const date = new Date(d);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

// ─── components ─────────────────────────────────────────────────────────────

function ActionMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div className="relative" ref={menuRef}>
      <button 
        onClick={() => setOpen(!open)}
        className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-[#FF5A1F]/50"
        aria-label="Job actions"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <MoreVertical className="w-5 h-5" />
      </button>
      {open && (
        <div 
          className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-100 py-1 z-50 animate-in fade-in zoom-in-95 duration-100"
          role="menu"
        >
          <button 
            onClick={() => { setOpen(false); onEdit(); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-orange-50 hover:text-[#FF5A1F] transition-colors flex items-center gap-2"
            role="menuitem"
          >
            <Edit3 className="w-4 h-4" /> Edit Job
          </button>
          <button 
            onClick={() => { setOpen(false); onDelete(); }}
            className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 hover:text-red-700 transition-colors flex items-center gap-2"
            role="menuitem"
          >
            <Trash2 className="w-4 h-4" /> Delete Job
          </button>
        </div>
      )}
    </div>
  );
}

// ─── main page ────────────────────────────────────────────────────────────────

export default function JobDetailPage() {
  const params = useParams<{ jobId: string }>();
  const router = useRouter();
  const rawJobId = params?.jobId;
  const jobIdParam = rawJobId?.trim() || null;
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** True only while the core job record is loading (first paint / navigation). */
  const [profileLoading, setProfileLoading] = useState(true);

  const [submissions, setSubmissions] = useState<JobSubmission[]>([]);
  const [submissionsTotal, setSubmissionsTotal] = useState(0);
  const [submissionsError, setSubmissionsError] = useState<string | null>(null);
  const [submissionsLoading, setSubmissionsLoading] = useState(false);
  const [bannerVisible, setBannerVisible] = useState(true);

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [jobCandidates, setJobCandidates] = useState<JobCandidateListItem[]>([]);
  const [atsMatches, setAtsMatches] = useState<JobMatchEntry[]>([]);
  const [atsLoading, setAtsLoading] = useState(false);
  const [atsRescoreBusy, setAtsRescoreBusy] = useState(false);
  const [atsFetchError, setAtsFetchError] = useState<string | null>(null);
  const atsRequestSeqRef = useRef(0);
  const [atsOffset, setAtsOffset] = useState(0);
  const [atsLimit] = useState(10);
  const [atsTotal, setAtsTotal] = useState(0);
  /** All scored candidate IDs for this job (first page fetch up to API max); used for pending banner — not paginated slice. */
  const [atsScoredCandidateIdSet, setAtsScoredCandidateIdSet] = useState<Set<string>>(() => new Set());
  const [atsSortBy, setAtsSortBy] = useState<"score_desc" | "missing_critical_asc">("score_desc");
  const atsSemanticInFlight = useMemo(() => atsAwaitingSemanticEnrichment(atsMatches), [atsMatches]);

  /** Ignore stale responses when `jobIdParam` changes before in-flight requests finish. */
  const latestJobIdRequested = useRef<string | null>(null);
  useEffect(() => {
    latestJobIdRequested.current = jobIdParam;
  }, [jobIdParam]);

  // Edit Job State
  const [showEdit, setShowEdit] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showPauseReasonModal, setShowPauseReasonModal] = useState(false);
  const [pauseReason, setPauseReason] = useState("");
  const [pendingStatus, setPendingStatus] = useState<JobStatus | null>(null);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [showParsedJdModal, setShowParsedJdModal] = useState(false);
  const role = useAuthStore((s) => s.role);

  async function handleDeleteConfirm() {
    if (!jobIdParam) return;
    setDeleting(true);
    try {
      await deleteJob(jobIdParam);
      router.push("/jobs");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to delete job.");
      setShowDeleteConfirm(false);
    } finally {
      setDeleting(false);
    }
  }
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [editStatus, setEditStatus] = useState<JobStatus>("open");
  const [editRequiredSkills, setEditRequiredSkills] = useState("");
  const [editPreferredSkills, setEditPreferredSkills] = useState("");
  const [editExpMin, setEditExpMin] = useState("");
  const [editExpMax, setEditExpMax] = useState("");
  const [editEmploymentType, setEditEmploymentType] = useState("");
  const [editKeyResponsibilities, setEditKeyResponsibilities] = useState("");
  const [editClientId, setEditClientId] = useState<string>("");
  const [clients, setClients] = useState<Client[]>([]);

  // Fetch clients once for the edit selector
  useEffect(() => {
    void listAllClients()
      .then((all) => setClients(all.filter((c) => !c.is_deleted)))
      .catch(() => {});
  }, []);

  function openEditPanel() {
    if (!job) return;
    setEditTitle(job.title || "");
    setEditDescription(job.description || "");
    setEditLocation(job.location || "");
    setEditStatus(job.status || "open");
    setEditRequiredSkills(job.required_skills?.join(", ") || "");
    setEditPreferredSkills(job.preferred_skills?.join(", ") || "");
    setEditExpMin(job.experience_min_years?.toString() || "");
    setEditExpMax(job.experience_max_years?.toString() || "");
    setEditEmploymentType(job.employment_type || "");
    setEditKeyResponsibilities(job.key_responsibilities?.join("\n") || "");
    setEditClientId(job.client_id || "");
    setShowEdit(true);
  }

  async function handleUpdateJob() {
    setError(null);
    if (!editTitle.trim()) { setError("Job title is required."); return; }
    if (!jobIdParam) return;

    try {
      setUpdating(true);
      const req = editRequiredSkills.split(/[\n,]+/g).map((s) => s.trim()).filter(Boolean);
      const pref = editPreferredSkills.split(/[\n,]+/g).map((s) => s.trim()).filter(Boolean);
      const keyResp = editKeyResponsibilities.split(/[\n]+/g).map((s) => s.trim()).filter(Boolean);

      await updateJob(jobIdParam, {
        ...(editClientId.trim() ? { client_id: editClientId.trim() } : {}),
        title: editTitle.trim(),
        description: editDescription.trim() || null,
        location: editLocation.trim() || null,
        experience_min_years: editExpMin ? Number(editExpMin) : null,
        experience_max_years: editExpMax ? Number(editExpMax) : null,
        employment_type: editEmploymentType || null,
        required_skills: req.length ? req : null,
        preferred_skills: pref.length ? pref : null,
        key_responsibilities: keyResp.length ? keyResp : null,
      });

      setShowEdit(false);
      void loadData({ silent: true }); // reload job without full-page skeleton
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to update job.");
    } finally {
      setUpdating(false);
    }
  }

  async function loadAtsMatches() {
    if (!jobIdParam || !job || String(job.id) !== jobIdParam) return;
    const seq = ++atsRequestSeqRef.current;
    setAtsLoading(true);
    setAtsFetchError(null);
    try {
      const atsPage = await getJobMatchesAts(jobIdParam, {
        limit: atsLimit,
        offset: atsOffset,
        sort_by: atsSortBy,
      });
      if (seq !== atsRequestSeqRef.current) return;
      setAtsMatches(atsPage.matches ?? []);
      setAtsTotal(atsPage.total_count ?? 0);
      // Refresh scored-ID set when listing from the first page (or sort changes), so banner ≠ paginated slice only.
      if (atsOffset === 0) {
        void refreshAtsScoredCandidateIds(jobIdParam, seq);
      }
    } catch (err) {
      if (seq !== atsRequestSeqRef.current) return;
      if (err instanceof ApiError && err.status === 404) {
        setAtsMatches([]);
        setAtsTotal(0);
        setAtsScoredCandidateIdSet(new Set());
        setAtsFetchError(null);
        return;
      }
      setAtsFetchError(err instanceof ApiError ? err.message : "Unable to load ATS matches.");
    } finally {
      if (seq === atsRequestSeqRef.current) {
        setAtsLoading(false);
      }
    }
  }

  async function refreshAtsScoredCandidateIds(jobId: string, seq: number) {
    try {
      const atsIdPages = await getJobMatchesAts(jobId, {
        limit: 200,
        offset: 0,
        sort_by: atsSortBy,
      });
      if (seq !== atsRequestSeqRef.current) return;
      const ids = new Set<string>();
      for (const m of atsIdPages.matches ?? []) {
        const nid = normalizeCandidateId(m.candidate_id);
        if (nid) ids.add(nid);
      }
      setAtsScoredCandidateIdSet(ids);
    } catch {
      // Banner hint is optional; paginated ATS table already loaded.
    }
  }

  async function loadSupplementary(loadTarget: string) {
    setPipelineError(null);
    try {
      const [candidatesOutcome, pipelinesOutcome] = await Promise.allSettled([
        getJobCandidates(loadTarget),
        getPipelines(50, 0, loadTarget),
      ]);
      if (latestJobIdRequested.current !== loadTarget) return;

      if (candidatesOutcome.status === "fulfilled") {
        setJobCandidates(candidatesOutcome.value);
      } else {
        setJobCandidates([]);
      }

      if (pipelinesOutcome.status === "fulfilled") {
        setPipelines(pipelinesOutcome.value);
      } else {
        setPipelines([]);
        const pipelineErr = pipelinesOutcome.reason;
        setPipelineError(
          pipelineErr instanceof Error ? pipelineErr.message : "Unable to load pipeline summary."
        );
      }
    } catch {
      if (latestJobIdRequested.current === loadTarget) {
        setJobCandidates([]);
        setPipelines([]);
      }
    }
  }

  async function loadData(options?: { silent?: boolean }) {
    if (!jobIdParam) return;
    const loadTarget = jobIdParam;
    if (!options?.silent) {
      setProfileLoading(true);
    }
    setError(null);
    try {
      const data = await getJobById(loadTarget);
      if (latestJobIdRequested.current !== loadTarget) return;
      setJob(data);
    } catch (err) {
      if (latestJobIdRequested.current !== loadTarget) return;
      setJob(null);
      if (err instanceof ApiError) {
        if (err.status === 404) {
          setError(
            "This job was not found. It may have been deleted, or you may not have access to it in your organization.",
          );
        } else {
          setError(err.message);
        }
      } else {
        setError("Unable to load job details");
      }
    } finally {
      if (latestJobIdRequested.current === loadTarget) {
        setProfileLoading(false);
      }
    }
    void loadSupplementary(loadTarget);
  }

  const ALLOWED_STATUS_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
    draft: ["open"],
    open: ["closed", "filled", "paused"],
    paused: ["open"],
    closed: [],
    filled: [],
  };

  async function applyStatusChange(nextStatus: JobStatus, reason?: string) {
    if (!job) return;
    try {
      setStatusUpdating(true);
      const updated = await changeJobStatus(job.id, nextStatus, reason);
      setJob(updated as Job);
      setPauseReason("");
      setPendingStatus(null);
      setShowPauseReasonModal(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to change job status.");
    } finally {
      setStatusUpdating(false);
    }
  }

  function onStatusOptionClick(nextStatus: JobStatus) {
    if (nextStatus === "paused") {
      setPendingStatus(nextStatus);
      setShowPauseReasonModal(true);
      return;
    }
    void applyStatusChange(nextStatus);
  }

  useEffect(() => {
    if (!jobIdParam) {
      setProfileLoading(false);
      setError("Invalid job link.");
      setJob(null);
      return;
    }
    setJob(null);
    setJobCandidates([]);
    setPipelines([]);
    setAtsMatches([]);
    setAtsScoredCandidateIdSet(new Set());
    void loadData();
  }, [jobIdParam]);

  useEffect(() => {
    if (!jobIdParam || !job || String(job.id) !== jobIdParam) return;
    void loadAtsMatches();
    // loadAtsMatches closes over the latest job/offset/sort each run; avoid duplicate fetches before job exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional gate on loaded job id
  }, [jobIdParam, job?.id, atsOffset, atsSortBy]);

  useEffect(() => {
    if (job) {
      loadSubmissions();
    }
  }, [job]);

  async function loadSubmissions() {
    if (!jobIdParam) return;
    setSubmissionsLoading(true);
    setSubmissionsError(null);
    try {
      const response = await getJobSubmissions(jobIdParam, { limit: 200, offset: 0 });
      setSubmissions(response.data);
      setSubmissionsTotal(response.total);
    } catch (err) {
      setSubmissionsError(err instanceof ApiError ? err.message : "Unable to load submissions.");
    } finally {
      setSubmissionsLoading(false);
    }
  }

  async function handleRescoreAts() {
    if (!jobIdParam) return;
    if (atsSemanticInFlight || atsRescoreBusy) return;
    setAtsRescoreBusy(true);
    setAtsFetchError(null);
    try {
      const meta = await rescoreJobAts(jobIdParam);
      await loadAtsMatches();
      if (meta.semantic_enrichment === "queued") {
        const seq = atsRequestSeqRef.current;
        const pairCandidates = Array.from(new Set(atsMatches.map((m) => m.candidate_id)));
        if (pairCandidates.length > 0) {
          await pollAtsPairStatusesUntilSettled(
            pairCandidates.map((candidateId) => ({ candidate_id: candidateId, job_id: jobIdParam })),
          );
        } else {
          await pollJobMatchesUntilEnriched(
            jobIdParam,
            { limit: atsLimit, offset: atsOffset, sort_by: atsSortBy },
            {
              onTick: (matches) => {
                if (seq !== atsRequestSeqRef.current) return;
                setAtsMatches(matches);
              },
            }
          );
        }
        if (seq === atsRequestSeqRef.current) {
          await loadAtsMatches();
        }
      }
    } catch (err) {
      setAtsFetchError(err instanceof ApiError ? err.message : "ATS rescore failed.");
    } finally {
      setAtsRescoreBusy(false);
    }
  }

  const candidateNamesByIdNorm = useMemo(() => {
    const map: Record<string, string> = {};
    for (const candidate of jobCandidates) {
      const nid = normalizeCandidateId(candidate.id);
      if (!nid) continue;
      const fullName = `${candidate.first_name} ${candidate.last_name}`.trim();
      map[nid] = fullName || candidate.email || candidate.id;
    }
    return map;
  }, [jobCandidates]);

  const pendingAtsBannerEntries = useMemo(() => {
    if (!job) return [] as { candidateId: string; label: string }[];
    const seen = new Set<string>();
    const out: { candidateId: string; label: string }[] = [];
    for (const p of pipelines) {
      if (p.job_id !== job.id) continue;
      const nid = normalizeCandidateId(p.candidate_id);
      if (!nid || atsScoredCandidateIdSet.has(nid) || seen.has(nid)) continue;
      seen.add(nid);
      out.push({
        candidateId: p.candidate_id,
        label: candidateNamesByIdNorm[nid] ?? p.candidate_id,
      });
    }
    return out;
  }, [job, pipelines, atsScoredCandidateIdSet, candidateNamesByIdNorm]);

  const jdDocumentInput = useMemo(
    () => ({
      flavor: "job_jd" as const,
      jobId: jobIdParam || "",
      jdOriginalAvailable: Boolean(job?.jd_original_available),
      jdFileName: job?.jd_file_name ?? null,
    }),
    [jobIdParam, job?.jd_original_available, job?.jd_file_name],
  );

  if (profileLoading && !job) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
        <div className="border-b border-gray-100 pb-4">
          <div className="h-3 w-16 bg-gray-100 rounded animate-pulse mb-3" />
          <div className="h-8 w-96 bg-gray-100 rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-28 bg-gray-50 rounded-xl animate-pulse border border-gray-100" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-10 gap-6">
          <div className="lg:col-span-7 space-y-6">
            <div className="h-10 w-full bg-gray-50 rounded animate-pulse border border-gray-100" />
            <div className="h-[400px] w-full bg-gray-50 rounded animate-pulse border border-gray-100" />
          </div>
          <div className="lg:col-span-3 space-y-6">
            <div className="h-48 w-full bg-gray-50 rounded animate-pulse border border-gray-100" />
            <div className="h-32 w-full bg-gray-50 rounded animate-pulse border border-gray-100" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    const isNotFound = error.includes("not found");
    return (
      <div className="flex flex-col items-center justify-center p-20 text-center">
        <div className="max-w-md space-y-4">
          <p className="text-gray-900 font-semibold">{isNotFound ? "Job not available" : "Something went wrong"}</p>
          <p className="text-gray-500 text-sm">{error}</p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button type="button" onClick={() => router.push("/jobs")} variant="default" className="px-3 py-1.5 text-sm">
              Back to jobs
            </Button>
            {!isNotFound ? (
              <Button type="button" onClick={() => void loadData()} variant="outline" className="px-3 py-1.5 text-sm">
                Retry
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (!job) return null;

  const statusColors: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    open: "bg-emerald-50 text-emerald-700",
    paused: "bg-amber-50 text-amber-700",
    filled: "bg-blue-50 text-blue-700",
    closed: "bg-red-50 text-red-700",
  };

  const urgencyColors: Record<string, string> = {
    normal: "bg-gray-50 text-gray-500",
    high: "bg-orange-50 text-orange-700",
    critical: "bg-red-50 text-red-700",
  };

  const pipelineSummary = {
    total: pipelines.length,
    applied: pipelines.filter((item) => item.stage === "applied").length,
    aiInterview: pipelines.filter((item) => item.stage === "ai_interview").length,
    interview: pipelines.filter((item) => item.stage === "interview").length,
    offered: pipelines.filter((item) => item.stage === "offer").length,
    hired: pipelines.filter((item) => item.stage === "placed").length,
  };
  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* ── HEADER ────────────────────────────────────────────────── */}
      <div className="bg-white/95 backdrop-blur-md pb-4 mb-6 border-b border-gray-200">
        <button
          onClick={() => router.back()}
          className="text-sm font-medium text-gray-500 hover:text-gray-900 mb-4 flex items-center gap-2 transition-colors w-fit pt-2"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Jobs
        </button>
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            {job.client_name && (
              <p className="text-xs font-semibold text-orange-500 uppercase tracking-wide">
                {job.client_name}
              </p>
            )}
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
                {job.title}
              </h1>
              <div className="flex items-center gap-2 hidden sm:flex">
                <Badge className={`${statusColors[job.status] || statusColors.open} border-none`}>
                  {job.status.replace("_", " ")}
                </Badge>
                {job.urgency && (
                  <Badge className={`${urgencyColors[job.urgency] || urgencyColors.normal} border-none`}>
                    {job.urgency}
                  </Badge>
                )}
              </div>
            </div>
            {/* Mobile badges */}
            <div className="flex items-center gap-2 mt-2 sm:hidden">
                <Badge className={`${statusColors[job.status] || statusColors.open} border-none`}>
                  {job.status.replace("_", " ")}
                </Badge>
                {job.urgency && (
                  <Badge className={`${urgencyColors[job.urgency] || urgencyColors.normal} border-none`}>
                    {job.urgency}
                  </Badge>
                )}
            </div>
          </div>
          <div className="flex items-center gap-3 ml-4">
            {ALLOWED_STATUS_TRANSITIONS[job.status]?.length ? (
              <select
                className="rounded-md border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700"
                defaultValue=""
                disabled={statusUpdating}
                onChange={(e) => {
                  const val = e.target.value as JobStatus;
                  if (!val) return;
                  onStatusOptionClick(val);
                  e.currentTarget.value = "";
                }}
              >
                <option value="">Change Status</option>
                {ALLOWED_STATUS_TRANSITIONS[job.status].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            ) : null}
            <ActionMenu onEdit={openEditPanel} onDelete={() => setShowDeleteConfirm(true)} />
          </div>
        </div>
      </div>


      {/* ── MAIN LAYOUT ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-10 gap-8">
        
        {/* Left Column (70%) */}
        <div className="lg:col-span-7 space-y-6">
          <div className="min-h-[400px] space-y-6">
            <div className="animate-in fade-in duration-300 space-y-6">
              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
                <h2 className="mb-6 flex items-center gap-2 text-lg font-bold text-gray-900">
                  <FileText className="h-5 w-5 text-[#FF5A1F]" /> About This Role
                </h2>
                {job.description ? (
                  <div className="text-[15px] font-medium leading-relaxed text-gray-700 whitespace-pre-wrap">
                    {job.description}
                  </div>
                ) : (
                  <p className="text-sm italic text-gray-400">No description provided.</p>
                )}

                {job.key_responsibilities && job.key_responsibilities.length > 0 && (
                  <div className="mt-8 border-t border-gray-100 pt-6">
                    <h3 className="mb-4 flex items-center gap-2 text-base font-bold text-gray-900">
                      <Target className="h-5 w-5 text-[#FF5A1F]" /> Key Responsibilities
                    </h3>
                    <ul className="list-disc space-y-2 pl-5 text-[14px] text-gray-700">
                      {job.key_responsibilities.map((resp, i) => (
                        <li key={i} className="leading-relaxed">
                          {resp}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <DocumentCard
                heading="Job description document"
                document={jdDocumentInput}
                hasSource={Boolean(job.jd_original_available)}
                emptyTitle="No original JD file on record"
                emptyDescription="This job may have been created before document storage was enabled, or from a source without a saved file. Parsed text is still used for search and ATS behind the scenes."
                extras={
                  <>
                    {job.raw_jd_text ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 gap-2 border-gray-200 px-3 text-xs font-medium text-gray-700 hover:bg-gray-50"
                        onClick={() => {
                          void navigator.clipboard.writeText(job.raw_jd_text || "");
                        }}
                      >
                        <Clipboard className="h-3.5 w-3.5" />
                        Copy parsed text
                      </Button>
                    ) : null}
                    {isAdminRole(role) && job.raw_jd_text ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 border-dashed border-amber-300 px-3 text-xs font-medium text-amber-800 hover:bg-amber-50"
                        onClick={() => setShowParsedJdModal(true)}
                      >
                        View parsed text (admin)
                      </Button>
                    ) : null}
                  </>
                }
              />

              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
                      <Sparkles className="w-5 h-5 text-[#FF5A1F]" /> ATS Matches
                    </h3>
                    <div className="flex items-center gap-2">
                      <select
                        className="rounded-md border border-slate-200 px-2 py-1 text-xs"
                        value={atsSortBy}
                        onChange={(e) => {
                          setAtsOffset(0);
                          setAtsSortBy(e.target.value as "score_desc" | "missing_critical_asc");
                        }}
                      >
                        <option value="score_desc">Score desc</option>
                        <option value="missing_critical_asc">Least missing skills</option>
                      </select>
                      <Button
                        variant="outline"
                        className="text-xs"
                        disabled={atsRescoreBusy || atsSemanticInFlight || atsLoading}
                        onClick={() => void handleRescoreAts()}
                      >
                        {atsRescoreBusy ? "Rescoring…" : atsSemanticInFlight ? "AI…" : "Rescore"}
                      </Button>
                    </div>
                  </div>
                  {atsFetchError ? <p className="text-sm text-red-600">{atsFetchError}</p> : null}
                  {atsLoading ? (
                    <div className="space-y-2">
                      <div className="h-3 w-40 animate-pulse rounded bg-gray-100" />
                      <div className="h-20 animate-pulse rounded-lg border border-gray-100 bg-gray-50" />
                    </div>
                  ) : null}
                  {!atsLoading && atsRescoreBusy ? (
                    <p className="text-sm text-gray-500">Refreshing ATS rows (baseline + background AI)…</p>
                  ) : null}
                  {!atsLoading && !atsFetchError && atsMatches.length === 0 && pendingAtsBannerEntries.length === 0 ? (
                    <p className="text-sm text-gray-500">No ATS matches computed yet.</p>
                  ) : null}
                  {!atsLoading && (atsMatches.length > 0 || pendingAtsBannerEntries.length > 0) ? (
                    <div className="space-y-3">
                      {atsMatches.map((m) => {
                        const name = m.candidate_name || candidateNamesByIdNorm[normalizeCandidateId(m.candidate_id)] || m.candidate_id || "Unknown Candidate";
                        return (
                          <Link 
                            key={m.candidate_id} 
                            href={`/candidates/${m.candidate_id}?tab=ats`}
                            className="block rounded-[16px] border border-slate-100/80 bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.02)] hover:shadow-[0_8px_24px_rgba(0,0,0,0.06)] hover:border-slate-200 transition-all duration-300 group"
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-4">
                                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-slate-500 font-bold text-lg group-hover:bg-[#FF5A1F]/10 group-hover:text-[#FF5A1F] transition-colors duration-300">
                                  {name.charAt(0).toUpperCase()}
                                </div>
                                <div>
                                  <h4 className="text-[15px] font-bold text-slate-900 group-hover:text-[#FF5A1F] transition-colors duration-300">{name}</h4>
                                  <div className="flex items-center gap-2 mt-1">
                                    <span className="text-[12px] font-medium text-slate-500 flex items-center gap-1">
                                      <Calendar className="h-3.5 w-3.5" />
                                      {m.evaluated_at ? new Date(m.evaluated_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : "Pending"}
                                    </span>
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center gap-3 shrink-0">
                                <ATSScoreBadge score={m.fit_score} />
                                <ATSRecommendationBadge recommendation={m.recommendation} awaitingMatch={false} />
                                <ChevronRight className="h-5 w-5 text-slate-300 group-hover:text-[#FF5A1F] transition-transform group-hover:translate-x-1 duration-300" />
                              </div>
                            </div>
                            
                            <div className="mt-5 pt-4 border-t border-slate-100/80 grid grid-cols-2 gap-4">
                                <div>
                                  <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Matched Skills</p>
                                  {m.matched_skills && m.matched_skills.length > 0 ? (
                                    <div className="flex flex-wrap gap-1.5">
                                      {m.matched_skills.slice(0, 4).map(s => <span key={s} className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-100/50 text-[10px] font-bold">{s}</span>)}
                                      {m.matched_skills.length > 4 && <span className="px-2 py-0.5 rounded-md bg-slate-50 text-slate-600 border border-slate-100 text-[10px] font-bold">+{m.matched_skills.length - 4}</span>}
                                    </div>
                                  ) : <span className="text-xs text-slate-400">-</span>}
                                </div>
                                <div>
                                  <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Missing Skills</p>
                                  {m.missing_skills && m.missing_skills.length > 0 ? (
                                    <div className="flex flex-wrap gap-1.5">
                                      {m.missing_skills.slice(0, 3).map(s => <span key={s} className="px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 border border-rose-100/50 text-[10px] font-bold">{s}</span>)}
                                      {m.missing_skills.length > 3 && <span className="px-2 py-0.5 rounded-md bg-slate-50 text-slate-600 border border-slate-100 text-[10px] font-bold">+{m.missing_skills.length - 3}</span>}
                                    </div>
                                  ) : <span className="text-xs text-slate-400">-</span>}
                                </div>
                            </div>
                          </Link>
                        );
                      })}
                      {pendingAtsBannerEntries.length > 0 && (
                        <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/60 p-3">
                          <p className="text-xs font-semibold text-amber-700">
                            {pendingAtsBannerEntries.length} candidate(s) on this job have no ATS row yet (pipeline only).
                          </p>
                          <div className="mt-2 space-y-1">
                            {pendingAtsBannerEntries.map((entry) => (
                              <Link
                                key={entry.candidateId}
                                href={`/candidates/${entry.candidateId}?tab=ats`}
                                className="block text-xs text-amber-800 hover:underline"
                              >
                                {entry.label}
                              </Link>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="flex items-center justify-between pt-1 text-xs text-slate-600">
                        <span>
                          Showing {atsMatches.length ? atsOffset + 1 : 0}-{Math.min(atsOffset + atsMatches.length, atsTotal)} of {atsTotal}
                        </span>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            disabled={atsOffset === 0 || atsLoading}
                            onClick={() => setAtsOffset((prev) => Math.max(0, prev - atsLimit))}
                          >
                            Prev
                          </Button>
                          <Button
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            disabled={atsOffset + atsLimit >= atsTotal || atsLoading}
                            onClick={() => setAtsOffset((prev) => prev + atsLimit)}
                          >
                            Next
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
            </div>
          </div>
        </div>

        {/* Right Column (30%) */}
        <div className="lg:col-span-3 space-y-6">
          
          {/* Skills Panel */}
          <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
            <h3 className="text-base font-bold text-gray-900 mb-6 flex items-center gap-2">
              <Layers className="w-5 h-5 text-[#FF5A1F]" /> Skills
            </h3>
            
            <div className="space-y-6">
              <div>
                <h4 className="text-xs uppercase font-bold text-gray-500 tracking-wider mb-3">Required Skills</h4>
                {job.required_skills && job.required_skills.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {job.required_skills.map((skill, i) => (
                      <span key={i} className="px-2.5 py-1 rounded bg-gray-50 text-gray-600 text-xs font-medium border border-gray-200 shadow-sm transition-transform hover:-translate-y-0.5 cursor-default">
                        {skill}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-gray-400 text-sm italic">No skills listed</p>
                )}
              </div>
              
              <div>
                <h4 className="text-xs uppercase font-bold text-gray-500 tracking-wider mb-3">Preferred Skills</h4>
                {job.preferred_skills && job.preferred_skills.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {job.preferred_skills.map((skill, i) => (
                      <span key={i} className="px-2.5 py-1 rounded bg-gray-50 text-gray-600 text-xs font-medium border border-gray-200 shadow-sm transition-transform hover:-translate-y-0.5 cursor-default">
                        {skill}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-gray-400 text-sm italic">No skills listed</p>
                )}
              </div>
            </div>
          </div>

          {/* Job Details Card */}
          <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
            <h3 className="text-base font-bold text-gray-900 mb-5 flex items-center gap-2">
              <Briefcase className="w-5 h-5 text-[#FF5A1F]" /> Job Details
            </h3>
            
            <div className="space-y-4">
              <div className="flex flex-col gap-1 pb-3 border-b border-gray-100">
                <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2"><MapPin className="w-3.5 h-3.5" /> Location</span>
                <span className="text-sm font-semibold text-gray-900">{job.location || "Not specified"}</span>
              </div>
              <div className="flex flex-col gap-1 pb-3 border-b border-gray-100">
                <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2"><Briefcase className="w-3.5 h-3.5" /> Employment Type</span>
                <span className="text-sm font-semibold text-gray-900 capitalize">{job.employment_type?.replace('_', ' ') || "Not specified"}</span>
              </div>
              <div className="flex flex-col gap-1 pb-3 border-b border-gray-100">
                <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2"><Clock className="w-3.5 h-3.5" /> Experience</span>
                <span className="text-sm font-semibold text-gray-900">{job.experience_min_years !== null && job.experience_min_years !== undefined ? `${job.experience_min_years} - ${job.experience_max_years || '+'} years` : "Not specified"}</span>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Created On</span>
                <span className="text-sm font-semibold text-gray-900">{formatDate(job.created_at)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Edit Job Slide-In Panel ─────────────────────────────────── */}
      {showEdit && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Overlay */}
          <div 
            className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" 
            onClick={() => setShowEdit(false)}
          />
          
          {/* Panel */}
          <div className="relative w-full max-w-[480px] bg-white shadow-2xl h-full flex flex-col overflow-hidden animate-in slide-in-from-right duration-300">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b shrink-0">
              <h2 className="text-xl font-semibold text-slate-800">Edit Job</h2>
              <button 
                onClick={() => setShowEdit(false)} 
                className="text-slate-400 hover:text-slate-600 text-2xl font-bold p-1"
              >
                ✕
              </button>
            </div>
            
            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6 text-sm">
              <div className="space-y-4">
                {clients.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Client</label>
                    <select
                      className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm bg-white focus:border-[#FF5A1F] focus:ring-1 focus:ring-[#FF5A1F]/30 focus:outline-none"
                      value={editClientId}
                      onChange={(e) => setEditClientId(e.target.value)}
                    >
                      <option value="">— No change —</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Title *</label>
                  <Input placeholder="Software Engineer" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Description</label>
                  <textarea 
                    className="w-full h-32 rounded-md border border-slate-200 p-2 text-sm resize-none focus:ring-2 focus:ring-indigo-400 focus:outline-none" 
                    placeholder="Describe the role..."
                    value={editDescription} 
                    onChange={(e) => setEditDescription(e.target.value)} 
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Key Responsibilities (newline separated)</label>
                  <textarea 
                    className="w-full h-32 rounded-md border border-slate-200 p-2 text-sm resize-none focus:ring-2 focus:ring-indigo-400 focus:outline-none" 
                    placeholder="List key responsibilities..."
                    value={editKeyResponsibilities} 
                    onChange={(e) => setEditKeyResponsibilities(e.target.value)} 
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Location</label>
                  <Input placeholder="e.g. Remote, San Francisco" value={editLocation} onChange={(e) => setEditLocation(e.target.value)} />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Min Exp (Years)</label>
                    <Input type="number" placeholder="0" value={editExpMin} onChange={(e) => setEditExpMin(e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Max Exp (Years)</label>
                    <Input type="number" placeholder="5" value={editExpMax} onChange={(e) => setEditExpMax(e.target.value)} />
                  </div>
                </div>


                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
                    <Input value={editStatus} disabled />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Employment Type</label>
                    <select 
                      className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400 focus:outline-none" 
                      value={editEmploymentType} 
                      onChange={(e) => setEditEmploymentType(e.target.value)}
                    >
                      <option value="">(None)</option>
                      <option value="full_time">Full Time</option>
                      <option value="part_time">Part Time</option>
                      <option value="contract">Contract</option>
                      <option value="internship">Internship</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Required Skills (comma/newline)</label>
                  <textarea 
                    className="h-24 w-full rounded-md border border-slate-200 p-2 text-sm resize-none focus:ring-2 focus:ring-indigo-400 focus:outline-none" 
                    value={editRequiredSkills} 
                    onChange={(e) => setEditRequiredSkills(e.target.value)} 
                    placeholder="Python, FastAPI, AWS" 
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Preferred Skills (comma/newline)</label>
                  <textarea 
                    className="h-24 w-full rounded-md border border-slate-200 p-2 text-sm resize-none focus:ring-2 focus:ring-indigo-400 focus:outline-none" 
                    value={editPreferredSkills} 
                    onChange={(e) => setEditPreferredSkills(e.target.value)} 
                    placeholder="Redis, Docker, Terraform" 
                  />
                </div>
              </div>
            </div>

            {/* Sticky Footer */}
            <div className="p-6 border-t bg-slate-50 shrink-0">
              <Button
                className="w-full py-6 text-lg bg-indigo-600 hover:bg-indigo-700"
                disabled={updating}
                onClick={handleUpdateJob}
              >
                {updating ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation Modal ─────────────────────────────────── */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-6">
              <h3 className="text-xl font-bold text-gray-900 mb-2">Delete Job</h3>
              <p className="text-sm text-gray-500 mb-6">
                Are you sure you want to permanently delete this job? This action cannot be undone and will remove all associated data.
              </p>
              <div className="flex items-center justify-end gap-3">
                <Button variant="outline" onClick={() => setShowDeleteConfirm(false)} disabled={deleting}>
                  Cancel
                </Button>
                <Button className="bg-red-600 hover:bg-red-700 text-white" onClick={handleDeleteConfirm} disabled={deleting}>
                  {deleting ? "Deleting..." : "Delete Permanently"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
      {showParsedJdModal && job?.raw_jd_text ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <h3 className="text-base font-bold text-gray-900">Parsed JD text (admin)</h3>
              <button
                type="button"
                className="rounded-lg p-2 text-gray-400 hover:bg-gray-50 hover:text-gray-700"
                aria-label="Close"
                onClick={() => setShowParsedJdModal(false)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[calc(85vh-4rem)] overflow-auto p-5">
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-gray-800">{job.raw_jd_text}</pre>
            </div>
          </div>
        </div>
      ) : null}
      {showPauseReasonModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-2xl overflow-hidden">
            <div className="p-6">
              <h3 className="text-lg font-bold text-gray-900 mb-2">Pause job</h3>
              <p className="text-sm text-gray-500 mb-4">Enter reason</p>
              <textarea
                value={pauseReason}
                onChange={(e) => setPauseReason(e.target.value)}
                className="w-full rounded-md border border-slate-200 p-3 text-sm"
                placeholder="Waiting for client feedback"
              />
              <div className="mt-4 flex items-center justify-end gap-3">
                <Button variant="outline" onClick={() => setShowPauseReasonModal(false)} disabled={statusUpdating}>
                  Cancel
                </Button>
                <Button
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                  disabled={statusUpdating || !pauseReason.trim() || pendingStatus !== "paused"}
                  onClick={() => void applyStatusChange("paused", pauseReason.trim())}
                >
                  {statusUpdating ? "Updating..." : "Pause Job"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

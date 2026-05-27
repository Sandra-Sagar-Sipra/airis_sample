"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiError } from "@/lib/api/client";
import { checkDuplicate, type DuplicateMatch } from "@/lib/api/candidate-dedup";
import { DuplicateAlert } from "@/components/candidates/DuplicateAlert";
import {
  addCandidateInteraction,
  bulkAssignRecruiter,
  bulkDeleteCandidates,
  bulkUpdateCandidateStage,
  createBulkUploadJob,
  createCandidate,
  getBulkUploadJobStatus,
  getCandidates,
  type CandidateManagementParseResult,
  type BulkUploadJobStatus,
  updateCandidate,
  uploadResumeForReview,
} from "@/lib/api/candidates";
import { getJobs, submitCandidateToJob } from "@/lib/api/jobs";
import { getPipelines, updatePipeline } from "@/lib/api/pipeline";
import type { Candidate, Job, OrganizationUser, Pipeline } from "@/lib/api/types";
import { getUsers } from "@/lib/api/users";
import { CANDIDATES_CREATE_PERMISSION, hasPermission } from "@/lib/rbac";
import { useAuthStore } from "@/store/auth-store";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CheckCircle2, ArrowLeft, Edit3, FileText, Layers, ArrowRight, Upload, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type AddMode = "manual" | "resume" | "csv";

type CandidateDraft = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  location: string;
  headline: string;
  years_experience: string;
  summary: string;
  resume_s3_key: string;
  resume_file_name: string;
};

export default function CandidatesPage() {
  const router = useRouter();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [users, setUsers] = useState<OrganizationUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [savingReview, setSavingReview] = useState(false);
  const [bulkCreating, setBulkCreating] = useState(false);
  const [bulkPolling, setBulkPolling] = useState(false);
  const [viewImportedOnly, setViewImportedOnly] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [addMode, setAddMode] = useState<AddMode>("manual");
  const [activeStep, setActiveStep] = useState(1);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("");
  const [candidateRole, setCandidateRole] = useState("");
  const [yearsExperience, setYearsExperience] = useState("");
  const [summary, setSummary] = useState("");
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvResumeKeys, setCsvResumeKeys] = useState("");
  const [bulkFiles, setBulkFiles] = useState<File[]>([]);
  const [bulkStatus, setBulkStatus] = useState<
    Array<{ name: string; status: "pending" | "parsing" | "success" | "duplicate" | "error"; error?: string }>
  >([]);
  const [bulkJob, setBulkJob] = useState<BulkUploadJobStatus | null>(null);
  const [draftCandidate, setDraftCandidate] = useState<CandidateDraft | null>(null);
  const [parseResult, setParseResult] = useState<CandidateManagementParseResult | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "archived" | "deleted">("all");
  const [stageFilter, setStageFilter] = useState<
    "all" | "applied" | "screening" | "shortlisted" | "interview" | "offered" | "hired" | "rejected"
  >("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | "manual" | "resume_upload" | "bulk_upload" | "referral" | "agency">("all");
  const [experienceFilter, setExperienceFilter] = useState("");
  const [sortBy, setSortBy] = useState<"updated_at" | "first_name" | "years_experience">("updated_at");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [bulkRecruiterId, setBulkRecruiterId] = useState("");
  const [bulkStage, setBulkStage] = useState<"applied" | "screening" | "interview" | "offer" | "placed" | "rejected">(
    "screening"
  );
  const permissions = useAuthStore((state) => state.permissions);
  const searchParams = useSearchParams();
  const canCreate = hasPermission(permissions, CANDIDATES_CREATE_PERMISSION);

  // CAND-006: Duplicate detection state
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[] | null>(null);
  const [pendingCreate, setPendingCreate] = useState<(() => Promise<boolean>) | null>(null);

  function trackModuleEvent(eventName: string, payload?: Record<string, unknown>) {
    // Lightweight client telemetry hook; can be wired to analytics backend later.
    console.info("[candidate-module]", eventName, payload ?? {});
  }

  const loadCandidates = useCallback(async (opts?: { query?: string; location?: string }) => {
    setLoading(true);
    try {
      const data = await getCandidates(50, 0, {
        query: opts?.query || undefined,
        location: opts?.location || undefined,
        status: statusFilter === "all" ? undefined : statusFilter,
        stage: stageFilter === "all" ? undefined : stageFilter,
        source: sourceFilter === "all" ? undefined : sourceFilter,
        min_years_experience: experienceFilter.trim() ? Number(experienceFilter) : undefined,
        job_id: selectedJobId || undefined,
      });
      setCandidates(data);
      try {
        const pipelineData = await getPipelines(200, 0);
        setPipelines(pipelineData);
      } catch {
        // Candidate list remains usable even if pipeline summary cannot be loaded.
        setPipelines([]);
      }
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Unable to load candidates");
      }
    } finally {
      setLoading(false);
    }
  }, [experienceFilter, selectedJobId, sourceFilter, stageFilter, statusFilter]);

  async function loadJobs() {
    setLoadingJobs(true);
    try {
      const data = await getJobs(200, 0);
      setJobs(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load jobs");
    } finally {
      setLoadingJobs(false);
    }
  }

  async function loadUsers() {
    try {
      const data = await getUsers();
      setUsers(data.filter((user) => user.role === "recruiter" || user.role === "admin"));
    } catch {
      // Dropdown gracefully degrades if users list is unavailable.
      setUsers([]);
    }
  }



  useEffect(() => {
    const jobIdFromQuery = searchParams.get("jobId");
    if (jobIdFromQuery) {
      setSelectedJobId(jobIdFromQuery);
    }
    void loadJobs();
    void loadUsers();
  }, [searchParams]);

  async function _doCreateManual() {
    setCreating(true);
    try {
      const created = await createCandidate({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        location: location.trim() || undefined,
        headline: candidateRole.trim() || undefined,
        years_experience: yearsExperience.trim() ? Number(yearsExperience.trim()) : undefined,
        summary: summary.trim() || undefined,
        stage: "applied",
        source: "manual",
      });
      setCandidates((prev) => [created, ...prev]);
      trackModuleEvent("candidate_created_manual", { candidateId: created.id });
      setFirstName("");
      setLastName("");
      setEmail("");
      setPhone("");
      setLocation("");
      setCandidateRole("");
      setYearsExperience("");
      setSummary("");
      setError(null);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("This candidate already exists in the system (Duplicate email or phone).");
      } else {
        setError(err instanceof Error ? err.message : "Unable to create candidate.");
      }
      return false;
    } finally {
      setCreating(false);
    }
  }

  async function handleCreateCandidate() {
    if (!firstName.trim() || !lastName.trim()) {
      setError("First name and last name are required.");
      return false;
    }
    // CAND-006: Pre-check for duplicates before committing creation
    if (email.trim() || phone.trim()) {
      try {
        const dupResult = await checkDuplicate(email.trim() || null, phone.trim() || null);
        if (dupResult.has_duplicates) {
          setPendingCreate(() => _doCreateManual);
          setDuplicateMatches(dupResult.matches);
          return false;
        }
      } catch {
        // Non-blocking: if dedup check fails, fall through to creation
      }
    }
    await _doCreateManual();
    return true;
  }

  async function handleUploadResume() {
    if (!resumeFile) {
      setError("Please choose a resume file.");
      return false;
    }
    if (resumeFile.size > 10 * 1024 * 1024) {
      setError("File exceeds 10MB limit.");
      return false;
    }
    setUploading(true);
    try {
      const payload = await uploadResumeForReview(resumeFile);
      setDraftCandidate({
        first_name: payload.draft.first_name,
        last_name: payload.draft.last_name,
        email: payload.draft.email ?? "",
        phone: payload.draft.phone ?? "",
        location: payload.draft.location ?? "",
        headline: payload.draft.headline ?? "",
        years_experience:
          payload.draft.years_experience === null || payload.draft.years_experience === undefined
            ? ""
            : String(payload.draft.years_experience),
        summary: payload.draft.summary ?? "",
        resume_s3_key: payload.draft.resume_s3_key,
        resume_file_name: payload.draft.resume_file_name,
      });
      setParseResult(payload.parse_result);
      trackModuleEvent("resume_parsed_for_review", { fileName: resumeFile.name });
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to upload and parse resume.");
      return false;
    } finally {
      setUploading(false);
    }
  }

  async function _doSaveReviewedCandidate() {
    if (!draftCandidate) return false;
    setSavingReview(true);
    try {
      const created = await createCandidate({
        first_name: draftCandidate.first_name.trim(),
        last_name: draftCandidate.last_name.trim(),
        email: draftCandidate.email.trim() || undefined,
        phone: draftCandidate.phone.trim() || undefined,
        location: draftCandidate.location.trim() || undefined,
        headline: draftCandidate.headline.trim() || undefined,
        years_experience: draftCandidate.years_experience.trim()
          ? Number(draftCandidate.years_experience.trim())
          : undefined,
        summary: draftCandidate.summary.trim() || undefined,
        source: "resume_upload",
        stage: "applied",
        resume_s3_key: draftCandidate.resume_s3_key,
        resume_file_name: draftCandidate.resume_file_name,
        parse_confidence: parseResult?.parse_confidence ?? undefined,
        parsed_resume_data: parseResult?.parsed_resume_data,
      });
      setCandidates((prev) => [created, ...prev]);
      trackModuleEvent("candidate_created_resume", { candidateId: created.id });
      setDraftCandidate(null);
      setParseResult(null);
      setResumeFile(null);
      setError(null);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("This candidate already exists in the system (Duplicate email or phone).");
      } else {
        setError(err instanceof Error ? err.message : "Unable to save parsed candidate.");
      }
      return false;
    } finally {
      setSavingReview(false);
    }
  }

  async function handleSaveReviewedCandidate() {
    if (!draftCandidate) return false;
    if (!draftCandidate.first_name.trim() || !draftCandidate.last_name.trim()) {
      setError("First name and last name are required in parsed resume verification.");
      return false;
    }
    // CAND-006: Pre-check for duplicates
    const emailVal = draftCandidate.email.trim();
    const phoneVal = draftCandidate.phone.trim();
    if (emailVal || phoneVal) {
      try {
        const dupResult = await checkDuplicate(emailVal || null, phoneVal || null);
        if (dupResult.has_duplicates) {
          setPendingCreate(() => _doSaveReviewedCandidate);
          setDuplicateMatches(dupResult.matches);
          return false;
        }
      } catch {
        // Non-blocking: if dedup check fails, fall through to creation
      }
    }
    return await _doSaveReviewedCandidate();
  }

  async function handleCreateBulkUpload() {
    let files = csvResumeKeys
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    if (csvFile) {
      const text = await csvFile.text();
      const rows = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const parsedFromFile = rows
        .map((line) => line.split(",")[0]?.trim())
        .filter((line): line is string => Boolean(line && line.length > 0));
      files = [...new Set([...parsedFromFile, ...files])];
    }
    if (files.length === 0) {
      setError("Add at least one resume key for CSV/XLS bulk upload.");
      return;
    }
    setBulkCreating(true);
    try {
      const job = await createBulkUploadJob({ files, source: "import" });
      setBulkJob(job);
      setViewImportedOnly(false);
      trackModuleEvent("bulk_upload_started", { itemCount: files.length, jobId: job.id });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create bulk upload job.");
    } finally {
      setBulkCreating(false);
    }
  }

  async function handleBulkResumeUpload() {
    if (bulkFiles.length === 0) {
      setError("Please choose resume files.");
      return;
    }
    setBulkCreating(true);
    const newStatus = bulkFiles.map(f => ({ name: f.name, status: "pending" as const }));
    setBulkStatus(newStatus);

    for (let i = 0; i < bulkFiles.length; i++) {
      const file = bulkFiles[i];
      setBulkStatus(prev => prev.map((s, idx) => idx === i ? { ...s, status: "parsing" } : s));
      try {
        const payload = await uploadResumeForReview(file);
        const created = await createCandidate({
          first_name: payload.draft.first_name.trim() || "Unknown",
          last_name: payload.draft.last_name.trim() || "Candidate",
          email: payload.draft.email.trim() || undefined,
          phone: payload.draft.phone.trim() || undefined,
          location: payload.draft.location.trim() || undefined,
          headline: payload.draft.headline.trim() || undefined,
          years_experience: payload.draft.years_experience ?? undefined,
          summary: payload.draft.summary.trim() || undefined,
          source: "bulk_upload",
          stage: "applied",
          resume_s3_key: payload.draft.resume_s3_key,
          resume_file_name: payload.draft.resume_file_name,
          parse_confidence: payload.parse_result?.parse_confidence ?? undefined,
          parsed_resume_data: payload.parse_result?.parsed_resume_data,
        });
        setBulkStatus(prev => prev.map((s, idx) => idx === i ? { ...s, status: "success" } : s));
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setBulkStatus((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: "duplicate", error: "Already exists" } : s)));
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        setBulkStatus((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: "error", error: msg } : s)));
      }
    }
    setBulkCreating(false);
  }

  const refreshBulkStatus = useCallback(async () => {
    if (!bulkJob) return;
    setBulkPolling(true);
    try {
      const status = await getBulkUploadJobStatus(bulkJob.id);
      setBulkJob(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load bulk status.");
    } finally {
      setBulkPolling(false);
    }
  }, [bulkJob]);

  useEffect(() => {
    if (!bulkJob) return;
    if (bulkJob.status === "completed" || bulkJob.status === "failed") return;
    const timer = window.setInterval(() => {
      refreshBulkStatus();
    }, 6000);
    return () => window.clearInterval(timer);
  }, [bulkJob, refreshBulkStatus]);

  const bulkProgress = useMemo(() => {
    if (!bulkJob || bulkJob.total_items <= 0) return 0;
    return Math.min(100, Math.round((bulkJob.processed_items / bulkJob.total_items) * 100));
  }, [bulkJob]);

  const bulkStateLabel = useMemo(() => {
    if (!bulkJob) return null;
    if (bulkCreating) return "uploading";
    if (bulkJob.status === "pending" || bulkJob.status === "processing") return "processing";
    if (bulkJob.status === "completed") return "completed";
    return "completed";
  }, [bulkCreating, bulkJob]);

  const sortedCandidates = useMemo(() => {
    const data = viewImportedOnly ? candidates.filter((candidate) => candidate.source === "bulk_upload" || candidate.source === "import") : [...candidates];
    data.sort((a, b) => {
      let result = 0;
      if (sortBy === "first_name") {
        result = `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`);
      } else if (sortBy === "years_experience") {
        result = (a.years_experience ?? -1) - (b.years_experience ?? -1);
      } else {
        result = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
      }
      return sortDirection === "asc" ? result : -result;
    });
    return data;
  }, [candidates, sortBy, sortDirection, viewImportedOnly]);

  async function handleSearchApply() {
    await loadCandidates({
      query: searchQuery.trim() || undefined,
      location: locationFilter.trim() || undefined,
    });
  }



  const selectedJobTitle = jobs.find((job) => job.id === selectedJobId)?.title ?? "No job selected";
  const pipelineByCandidate = useMemo(() => {
    const map = new Map<string, Pipeline>();
    for (const item of pipelines) {
      if (!map.has(item.candidate_id)) {
        map.set(item.candidate_id, item);
      }
    }
    return map;
  }, [pipelines]);

  async function handleBulkStageChange() {
    if (selectedCandidateIds.length === 0) return;
    setBulkActionLoading(true);
    try {
      const prevCandidates = candidates;
      const optimisticStage = (
        { offer: "offered", placed: "hired" } as Record<string, "offered" | "hired">
      )[bulkStage] ?? (bulkStage as "applied" | "screening" | "interview" | "rejected");
      setCandidates((prev) =>
        prev.map((candidate) =>
          selectedCandidateIds.includes(candidate.id) ? { ...candidate, stage: optimisticStage } : candidate
        )
      );
      await bulkUpdateCandidateStage({ candidate_ids: selectedCandidateIds, stage: optimisticStage });
      setSelectedCandidateIds([]);
      await loadCandidates({
        query: searchQuery.trim() || undefined,
        location: locationFilter.trim() || undefined,
      });
    } catch (err) {
      await loadCandidates({
        query: searchQuery.trim() || undefined,
        location: locationFilter.trim() || undefined,
      });
      setError(err instanceof Error ? err.message : "Unable to apply bulk stage update.");
    } finally {
      setBulkActionLoading(false);
    }
  }

  async function handleBulkArchive() {
    if (selectedCandidateIds.length === 0) return;
    setBulkActionLoading(true);
    try {
      const prevCandidates = candidates;
      setCandidates((prev) => prev.filter((candidate) => !selectedCandidateIds.includes(candidate.id)));
      await bulkDeleteCandidates({ candidate_ids: selectedCandidateIds });
      setSelectedCandidateIds([]);
      await loadCandidates({
        query: searchQuery.trim() || undefined,
        location: locationFilter.trim() || undefined,
      });
    } catch (err) {
      await loadCandidates({
        query: searchQuery.trim() || undefined,
        location: locationFilter.trim() || undefined,
      });
      setError(err instanceof Error ? err.message : "Unable to delete selected candidates.");
    } finally {
      setBulkActionLoading(false);
    }
  }

  async function handleBulkAssignRecruiter() {
    if (selectedCandidateIds.length === 0) return;
    if (!bulkRecruiterId.trim()) {
      setError("Select recruiter for bulk assignment.");
      return;
    }
    setBulkActionLoading(true);
    const previous = candidates;
    try {
      setCandidates((prev) =>
        prev.map((candidate) =>
          selectedCandidateIds.includes(candidate.id) ? { ...candidate, recruiter_id: bulkRecruiterId.trim() } : candidate
        )
      );
      await bulkAssignRecruiter({
        candidate_ids: selectedCandidateIds,
        recruiter_id: bulkRecruiterId.trim(),
      });
      setSelectedCandidateIds([]);
      setBulkRecruiterId("");
    } catch (err) {
      setCandidates(previous);
      setError(err instanceof Error ? err.message : "Unable to assign recruiter.");
    } finally {
      setBulkActionLoading(false);
    }
  }

  const handleNext = () => setActiveStep((prev) => prev + 1);
  const handleBack = () => setActiveStep((prev) => Math.max(1, prev - 1));

  // Removed redundant monkey-patching of handlers

  const renderStepper = () => (
    <div className="mb-8 flex items-center justify-between border-b border-gray-100 pb-6">
      {['Method', 'Upload', 'Review', 'Done'].map((step, idx) => {
        const isCompleted = activeStep > idx + 1;
        const isActive = activeStep === idx + 1;
        return (
          <div key={step} className="flex items-center">
            <div className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full border text-sm font-medium transition-colors",
              isActive ? "border-[#FF5A1F] bg-orange-50 text-[#FF5A1F]" :
                isCompleted ? "border-green-600 bg-green-50 text-green-600" : "border-gray-200 text-gray-400"
            )}>
              {isCompleted ? <CheckCircle2 className="w-4 h-4" /> : idx + 1}
            </div>
            <span className={cn("ml-3 text-sm font-medium", isActive ? "text-gray-900" : "text-gray-500")}>
              {step}
            </span>
            {idx < 3 && <div className="mx-4 md:mx-8 h-px w-8 md:w-16 bg-gray-200" />}
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      {/* CAND-006: Duplicate detection modal */}
      {duplicateMatches && (
        <DuplicateAlert
          matches={duplicateMatches}
          onCancel={() => {
            setDuplicateMatches(null);
            setPendingCreate(null);
          }}
          onContinue={async () => {
            const action = pendingCreate;
            setDuplicateMatches(null);
            setPendingCreate(null);
            if (action) {
              const success = await action();
              if (success) setActiveStep(4);
            }
          }}
        />
      )}

    <section className="mx-auto max-w-4xl space-y-6 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Add Candidate</h1>
        <Link href="/candidates" className="text-sm font-medium text-gray-500 hover:text-gray-900 transition-colors flex items-center gap-2">
          <ArrowLeft className="w-4 h-4" /> Back to List
        </Link>
      </div>

      <div className="bg-white p-8 rounded-xl shadow-sm border border-gray-200">
        {renderStepper()}

        {error && (
          <div className="mb-6 rounded-lg bg-red-50 p-4 text-sm text-red-700 flex items-center gap-2 border border-red-100">
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
        )}

        {activeStep === 1 && (
          <div className="animate-in fade-in duration-300">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-gray-900">Select Method</h2>
              <p className="text-sm text-gray-500 mt-1">Choose how you want to add the candidate.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { id: "manual", title: "Add Manually", desc: "Type details yourself", icon: Edit3 },
                { id: "resume", title: "Upload Resume", desc: "AI extracts details", icon: FileText },
                { id: "csv", title: "Bulk AI Parse", desc: "Upload multiple files", icon: Layers }
              ].map((m) => (
                <button
                  key={m.id}
                  onClick={() => setAddMode(m.id as AddMode)}
                  className={cn(
                    "flex flex-col p-5 rounded-xl border transition-all text-left group",
                    addMode === m.id
                      ? "border-[#FF5A1F] bg-orange-50/30 ring-1 ring-[#FF5A1F]"
                      : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                  )}
                >
                  <m.icon className={cn("w-6 h-6 mb-3", addMode === m.id ? "text-[#FF5A1F]" : "text-gray-400 group-hover:text-gray-600")} />
                  <p className={cn("text-sm font-semibold", addMode === m.id ? "text-gray-900" : "text-gray-700")}>{m.title}</p>
                  <p className="text-xs text-gray-500 mt-1">{m.desc}</p>
                </button>
              ))}
            </div>

            <div className="flex justify-end pt-8 mt-4">
              <Button onClick={handleNext} className="bg-[#FF5A1F] hover:bg-[#E54E1A] text-white">
                Next <ArrowRight className="ml-2 w-4 h-4" />
              </Button>
            </div>
          </div>
        )}

        {activeStep === 2 && addMode === "manual" && (
          <div className="animate-in fade-in duration-300">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-gray-900">Manual Entry</h2>
              <p className="text-sm text-gray-500 mt-1">Provide the essential candidate details.</p>
            </div>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              {[
                { label: "First Name", value: firstName, setter: setFirstName, placeholder: "John" },
                { label: "Last Name", value: lastName, setter: setLastName, placeholder: "Doe" },
                { label: "Email Address", value: email, setter: setEmail, placeholder: "john@example.com" },
                { label: "Phone Number", value: phone, setter: setPhone, placeholder: "(555) 000-0000" },
                { label: "Location", value: location, setter: setLocation, placeholder: "New York, NY" },
                { label: "Role / Title", value: candidateRole, setter: setCandidateRole, placeholder: "Frontend Engineer" },
                { label: "Years Experience", value: yearsExperience, setter: setYearsExperience, placeholder: "5", type: "number" },
                { label: "Summary", value: summary, setter: setSummary, placeholder: "Brief summary..." },
              ].map((f) => (
                <div key={f.label} className="space-y-2">
                  <label className="text-sm font-medium text-gray-700">{f.label}</label>
                  <Input
                    placeholder={f.placeholder}
                    value={f.value}
                    onChange={(e) => f.setter(e.target.value)}
                    type={f.type || "text"}
                    className="h-10 border-gray-200 focus:border-[#FF5A1F] focus:ring-[#FF5A1F]/20"
                  />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between pt-8 mt-8 border-t border-gray-100">
              <Button variant="outline" onClick={handleBack} className="border-gray-200 text-gray-600 hover:bg-gray-50">Back</Button>
              <Button
                onClick={async () => {
                  const success = await handleCreateCandidate();
                  if (success) setActiveStep(4);
                }}
                disabled={creating}
                className="bg-[#FF5A1F] hover:bg-[#E54E1A] text-white min-w-[120px]"
              >
                {creating ? "Saving..." : "Submit Candidate"}
              </Button>
            </div>
          </div>
        )}

        {activeStep === 2 && addMode === "resume" && (
          <div className="animate-in fade-in duration-300">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-gray-900">Upload Resume</h2>
              <p className="text-sm text-gray-500 mt-1">We&apos;ll automatically extract the details for you to review.</p>
            </div>

            <div className="max-w-xl">
              <label
                htmlFor="resume-file-input"
                className={cn(
                  "flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-10 transition-colors cursor-pointer",
                  resumeFile ? "border-[#FF5A1F]/30 bg-orange-50/20" : "border-gray-200 hover:border-[#FF5A1F]/40 hover:bg-gray-50/50"
                )}
              >
                {resumeFile ? (
                  <div className="flex flex-col items-center gap-3">
                    <FileText className="w-8 h-8 text-[#FF5A1F]" />
                    <div className="text-center">
                      <p className="text-sm font-medium text-gray-900">{resumeFile.name}</p>
                      <p className="text-xs text-gray-500 mt-1">{(resumeFile.size / 1024).toFixed(0)} KB</p>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        setResumeFile(null);
                        setDraftCandidate(null);
                      }}
                      className="text-xs font-medium text-red-600 hover:text-red-700 mt-2 bg-red-50 px-3 py-1 rounded-md transition-colors"
                    >
                      Remove File
                    </button>
                  </div>
                ) : (
                  <div className="text-center">
                    <Upload className="w-8 h-8 text-gray-400 mx-auto mb-4" />
                    <p className="text-sm font-medium text-gray-700">Drag & Drop or <span className="text-[#FF5A1F]">Browse</span></p>
                    <p className="text-xs text-gray-500 mt-2">Accepted formats: PDF, DOCX (Max 10MB)</p>
                  </div>
                )}
              </label>
              <input
                id="resume-file-input"
                type="file"
                accept=".pdf,.docx"
                className="hidden"
                onChange={(e) => {
                  setResumeFile(e.target.files?.[0] ?? null);
                  setDraftCandidate(null);
                }}
              />
            </div>

            <div className="mt-8 flex items-center justify-between border-t border-gray-100 pt-8">
              <Button variant="outline" onClick={handleBack} className="border-gray-200 text-gray-600 hover:bg-gray-50">Back</Button>
              <Button
                onClick={async () => {
                  if (draftCandidate) {
                    setActiveStep(3);
                  } else {
                    const success = await handleUploadResume();
                    if (success) setActiveStep(3);
                  }
                }}
                disabled={uploading || !resumeFile}
                className="min-w-[120px] bg-[#FF5A1F] text-white hover:bg-[#E54E1A]"
              >
                {uploading ? "Parsing..." : draftCandidate ? "Review Parsed Data" : "Upload & Parse"}
              </Button>
            </div>
          </div>
        )}

        {activeStep === 2 && addMode === "csv" && (
          <div className="animate-in fade-in duration-300">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-gray-900">Bulk AI Parse</h2>
              <p className="text-sm text-gray-500 mt-1">Upload multiple resumes to process them as a batch.</p>
            </div>

            <div className="space-y-6 max-w-2xl">
              <label
                htmlFor="bulk-file-input"
                className="flex flex-col items-center justify-center border-2 border-dashed border-gray-200 rounded-xl p-8 transition-colors cursor-pointer hover:border-[#FF5A1F]/40 hover:bg-gray-50/50"
              >
                <Layers className="w-8 h-8 text-gray-400 mb-3" />
                <p className="text-sm font-medium text-gray-700">Select Multiple Resumes</p>
                <p className="text-xs text-gray-500 mt-1">PDF or DOCX files</p>
              </label>
              <input
                id="bulk-file-input"
                type="file"
                multiple
                accept=".pdf,.docx"
                onChange={(e) => {
                  if (e.target.files) {
                    setBulkFiles(Array.from(e.target.files));
                  }
                }}
                className="hidden"
              />

              {bulkStatus.length > 0 && (
                <div className="rounded-xl border border-gray-200 overflow-hidden">
                  <div className="bg-gray-50 px-4 py-3 border-b border-gray-200 flex items-center justify-between">
                    <h3 className="text-xs font-semibold text-gray-600 uppercase">Queue ({bulkFiles.length})</h3>
                    <button onClick={() => { setBulkFiles([]); setBulkStatus([]); }} className="text-xs text-gray-500 hover:text-red-600">Clear</button>
                  </div>
                  <div className="max-h-60 overflow-y-auto p-2">
                    {bulkStatus.map((item, idx) => (
                      <div key={idx} className="flex items-center justify-between p-2 rounded-lg hover:bg-gray-50">
                        <span className="truncate text-sm text-gray-700 max-w-[250px]">{item.name}</span>
                        <div className="flex items-center gap-2 ml-4">
                          {item.status === "parsing" && <span className="text-xs text-blue-600">Parsing...</span>}
                          {item.status === "success" && <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Done</span>}
                          {item.status === "duplicate" && <span className="text-xs text-amber-600">Duplicate</span>}
                          {item.status === "error" && <span className="text-xs text-red-600">Failed</span>}
                          {item.status === "pending" && <span className="text-xs text-gray-400">Waiting</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {bulkJob && (
                <div className="rounded-xl bg-orange-50 p-4 border border-[#FF5A1F]/20">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-gray-900">Job Status: {bulkStateLabel} ({bulkJob.processed_items}/{bulkJob.total_items})</p>
                    <span className="text-sm text-[#FF5A1F] font-medium">{bulkProgress}%</span>
                  </div>
                  <div className="h-2 w-full bg-orange-100 rounded-full overflow-hidden">
                    <div className="h-full bg-[#FF5A1F] transition-all duration-300" style={{ width: `${bulkProgress}%` }} />
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-8 mt-8 border-t border-gray-100">
              <Button variant="outline" onClick={handleBack} className="border-gray-200 text-gray-600 hover:bg-gray-50">Back</Button>
              <div className="flex items-center gap-3">
                {bulkFiles.length > 0 && !bulkCreating && bulkStatus.filter(s => s.status === 'success').length === 0 && (
                  <Button
                    onClick={handleBulkResumeUpload}
                    className="bg-slate-900 hover:bg-slate-800 text-white"
                  >
                    Start AI Parsing
                  </Button>
                )}
                {((bulkJob && bulkJob.status === 'completed') || (bulkStatus.length > 0 && !bulkCreating && bulkStatus.some(s => s.status === 'success'))) && (
                  <Button
                    onClick={() => setActiveStep(4)}
                    className="bg-[#FF5A1F] hover:bg-[#E54E1A] text-white"
                  >
                    Finish Batch
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {activeStep === 3 && draftCandidate && (
          <div className="animate-in fade-in duration-300">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-gray-900">Review Parsed Data</h2>
              <p className="text-sm text-gray-500 mt-1">Verify the extracted details below.</p>
            </div>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              {[
                { label: "First Name", value: draftCandidate.first_name, key: 'first_name' },
                { label: "Last Name", value: draftCandidate.last_name, key: 'last_name' },
                { label: "Email Address", value: draftCandidate.email, key: 'email' },
                { label: "Phone Number", value: draftCandidate.phone, key: 'phone' },
                { label: "Location", value: draftCandidate.location, key: 'location' },
                { label: "Role / Title", value: draftCandidate.headline, key: 'headline' },
                { label: "Years Experience", value: draftCandidate.years_experience, key: 'years_experience', type: 'number' },
                { label: "Summary", value: draftCandidate.summary, key: 'summary' },
              ].map((f) => (
                <div key={f.label} className="space-y-2">
                  <label className="text-sm font-medium text-gray-700">{f.label}</label>
                  <Input
                    value={f.value}
                    onChange={(e) => setDraftCandidate(p => p ? { ...p, [f.key as keyof CandidateDraft]: e.target.value } : p)}
                    type={f.type || "text"}
                    className="h-10 border-gray-200 focus:border-[#FF5A1F] focus:ring-[#FF5A1F]/20"
                  />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between pt-8 mt-8 border-t border-gray-100">
              <Button variant="outline" onClick={handleBack} className="border-gray-200 text-gray-600 hover:bg-gray-50">Back</Button>
              <Button
                onClick={async () => {
                  const success = await handleSaveReviewedCandidate();
                  if (success) setActiveStep(4);
                }}
                disabled={savingReview}
                className="bg-[#FF5A1F] hover:bg-[#E54E1A] text-white min-w-[120px]"
              >
                {savingReview ? "Saving..." : "Confirm & Save"}
              </Button>
            </div>
          </div>
        )}

        {activeStep === 4 && (
          <div className="animate-in fade-in duration-300 py-10 text-center">
            <div className="mx-auto h-16 w-16 rounded-full bg-green-100 flex items-center justify-center text-green-600 mb-5">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <h2 className="text-2xl font-semibold text-gray-900">Candidate Added!</h2>
            <p className="text-gray-500 mt-2 max-w-sm mx-auto">The candidate profile has been successfully created.</p>

            <div className="flex justify-center gap-4 pt-8">
              <Button
                variant="outline"
                onClick={() => {
                  setActiveStep(1);
                  setDraftCandidate(null);
                  setFirstName("");
                  setLastName("");
                  setResumeFile(null);
                  setCsvFile(null);
                  setBulkJob(null);
                  setBulkFiles([]);
                  setBulkStatus([]);
                }}
                className="border-gray-200 text-gray-700 hover:bg-gray-50"
              >
                Add Another
              </Button>
              <Link href="/candidates">
                <Button className="bg-[#FF5A1F] hover:bg-[#E54E1A] text-white">Go to Candidate List</Button>
              </Link>
            </div>
          </div>
        )}
      </div>
    </section>
    </>
  );
}
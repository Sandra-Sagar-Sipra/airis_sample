"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api/client";
import {
  createJob,
  getJobs,
  updateJob,
  deleteJob,
  parseJD,
  uploadJobJdDocument,
  readCachedJobsList,
  writeCachedJobsList,
  type JobParseResult,
} from "@/lib/api/jobs";
import { listAllClients } from "@/lib/api/clients";
import { JOBS_CREATE_PERMISSION, JOBS_UPDATE_PERMISSION, hasPermission } from "@/lib/rbac";
import { isAdminRole } from "@/lib/dashboard-nav";
import type { Client, Job, JobStatus } from "@/lib/api/types";
import { useAuthStore } from "@/store/auth-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Briefcase, CircleDot, Shield, CheckCircle2, RefreshCw, MapPin, GraduationCap, Calendar, Zap } from "lucide-react";

// ─── helpers ────────────────────────────────────────────────────────────────

function enrichmentStatusLabel(status: string | null | undefined): string | null {
  if (!status || status === "ready") return null;
  if (status === "enriching") return "Preparing ATS metadata…";
  if (status === "created") return "Just created";
  if (status === "failed") return "Metadata failed";
  return null;
}


function SkillTags({
  skills,
  onRemove,
  onAdd,
  placeholder,
}: {
  skills: string[];
  onRemove: (i: number) => void;
  onAdd: (s: string) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  function commit() {
    const v = draft.trim();
    if (v && !skills.includes(v)) onAdd(v);
    setDraft("");
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {skills.map((s, i) => (
          <span
            key={i}
            className="flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-[#FF5A1F] border border-[#FF5A1F]/20"
          >
            {s}
            <button type="button" onClick={() => onRemove(i)} className="text-[#FF5A1F]/70 hover:text-red-500">
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1">
        <Input
          className="h-7 text-xs"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
        />
        <Button type="button" variant="outline" className="h-7 px-2 text-xs" onClick={commit}>
          Add
        </Button>
      </div>
    </div>
  );
}

// ─── modal overlay ───────────────────────────────────────────────────────────

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-slate-400 hover:text-slate-700 text-xl font-bold"
        >
          ✕
        </button>
        {children}
      </div>
    </div>
  );
}

function ActionMenu({ onEdit, onDetails, onDelete }: { onEdit: () => void; onDetails: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);
  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(!open); }}
        className="p-1.5 hover:bg-slate-100 rounded-md transition-colors"
      >
        <svg className="w-5 h-5 text-slate-400" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-32 bg-white border border-slate-100 rounded-md shadow-xl z-20 py-1 animate-in fade-in zoom-in-95 duration-100">
          <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); onDetails(); }} className="w-full text-left px-4 py-2 text-xs hover:bg-slate-50 font-medium text-slate-700">View Details</button>
          <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); onEdit(); }} className="w-full text-left px-4 py-2 text-xs hover:bg-slate-50 font-medium text-indigo-600">Edit Job</button>
          <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); onDelete(); }} className="w-full text-left px-4 py-2 text-xs hover:bg-slate-50 font-medium text-red-600">Delete Job</button>
        </div>
      )}
    </div>
  );
}

// ─── JD input modal (paste / upload) ────────────────────────────────────────

function JDInputModal({
  onClose,
  onParsed,
}: {
  onClose: () => void;
  onParsed: (result: JobParseResult, sourceFile: File | null) => void;
}) {
  const [tab, setTab] = useState<"paste" | "upload">("paste");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseStep, setParseStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const PARSE_STEPS = ["Parsing JD...", "Extracting skills...", "Structuring data..."];

  useEffect(() => {
    if (!parsing) return;
    const interval = setInterval(() => {
      setParseStep((prev) => (prev + 1) % PARSE_STEPS.length);
    }, 1500);
    return () => clearInterval(interval);
  }, [parsing]);

  async function handleParse() {
    setError(null);
    if (tab === "paste" && !text.trim()) { setError("Paste a job description first."); return; }
    if (tab === "upload" && !file) { setError("Select a JD file first."); return; }
    try {
      setParsing(true);
      const result = tab === "paste"
        ? await parseJD({ type: "text", text })
        : await parseJD({ type: "file", file: file! });
      onParsed(
        {
          ...result,
          raw_jd_text: result.raw_jd_text ?? (tab === "paste" ? text : undefined),
          parsing_source: tab === "paste" ? "text" : "file",
          parsing_status: "success",
        },
        tab === "upload" ? file : null
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Parsing failed. Try again.");
    } finally {
      setParsing(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="p-6">
        <h2 className="text-xl font-semibold mb-1">Import from Job Description</h2>
        <p className="text-sm text-slate-500 mb-4">Paste or upload a JD — AI will extract all fields automatically.</p>

        {/* tabs */}
        <div className="flex border-b mb-4">
          {(["paste", "upload"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setError(null); }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === t ? "border-[#FF5A1F] text-[#FF5A1F]" : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {t === "paste" ? "📋 Paste JD" : "📄 Upload JD"}
            </button>
          ))}
        </div>

        {tab === "paste" ? (
          <textarea
            className="w-full h-64 rounded-md border border-slate-200 p-3 text-sm resize-none focus:outline-none focus:border-[#FF5A1F] focus:ring-1 focus:ring-[#FF5A1F]"
            placeholder="Paste the full job description here…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <div
            onClick={() => fileRef.current?.click()}
            className="flex h-40 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 text-slate-400 hover:border-[#FF5A1F]/50 hover:bg-orange-50/30 hover:text-[#FF5A1F] transition-colors"
          >
            <span className="text-3xl">📂</span>
            <p className="mt-2 text-sm">{file ? file.name : "Click to select a JD file"}</p>
            <p className="text-xs mt-1">Accepted: .pdf, .doc, .docx, .txt</p>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.doc,.docx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
        )}

        {error && (
          <div className="mt-4 flex items-center justify-between bg-red-50 p-3 rounded-md border border-red-200">
            <p className="text-sm text-red-600">{error}</p>
            <Button variant="outline" onClick={handleParse} className="px-3 py-1.5 text-xs text-red-700 border-red-200 hover:bg-red-100">
              Retry
            </Button>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <Button onClick={handleParse} disabled={parsing} className="bg-[#FF5A1F] hover:bg-[#E54E1A] text-white">
            {parsing ? PARSE_STEPS[parseStep] : "Parse JD →"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── preview / confirm modal ─────────────────────────────────────────────────

function JDPreviewModal({
  initial,
  sourceFile,
  clientId,
  onBack,
  onClose,
  onCreated,
}: {
  initial: JobParseResult;
  sourceFile: File | null;
  clientId: string;
  onBack: () => void;
  onClose: () => void;
  onCreated: (job: Job) => void;
}) {
  const [title, setTitle] = useState(initial.title ?? "");
  const [location, setLocation] = useState(initial.location ?? "");
  const [employmentType, setEmploymentType] = useState(initial.employment_type ?? "");
  const [expMin, setExpMin] = useState(initial.experience_min_years !== null ? String(initial.experience_min_years) : "");
  const [expMax, setExpMax] = useState(initial.experience_max_years !== null ? String(initial.experience_max_years) : "");
  const [urgency, setUrgency] = useState(initial.urgency ?? "normal");
  const [description, setDescription] = useState(initial.description ?? "");
  const [keyResponsibilities, setKeyResponsibilities] = useState<string>(initial.key_responsibilities?.join("\n") ?? "");
  const [requiredSkills, setRequiredSkills] = useState<string[]>(initial.required_skills ?? []);
  const [preferredSkills, setPreferredSkills] = useState<string[]>(initial.preferred_skills ?? []);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createLock = useRef(false);

  async function handleCreate() {
    if (!title.trim()) { setError("Title is required."); return; }
    if (createLock.current) return;
    createLock.current = true;
    setError(null);
    try {
      setCreating(true);
      const job = await createJob({
        client_id: clientId,
        title: title.trim(),
        description: description.trim() || null,
        status: "open",
        location: location.trim() || undefined,
        experience_min_years: expMin ? Number(expMin) : null,
        experience_max_years: expMax ? Number(expMax) : null,
        employment_type: employmentType || null,
        urgency: urgency || "normal",
        required_skills: requiredSkills,
        preferred_skills: preferredSkills,
        key_responsibilities: keyResponsibilities.split(/[\n]+/g).map((s) => s.trim()).filter(Boolean),
        raw_jd_text: initial.raw_jd_text,
        parsing_source: initial.parsing_source,
        parsing_status: initial.parsing_status,
      });
      let created = job;
      if (sourceFile) {
        try {
          created = await uploadJobJdDocument(job.id, sourceFile);
        } catch (uploadErr) {
          setError(
            uploadErr instanceof ApiError
              ? `${uploadErr.message} The job was created; you can re-upload the JD from job settings when available.`
              : "Job created but JD file upload failed. Try again from the job page."
          );
          onCreated(job);
          return;
        }
      }
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create job.");
    } finally {
      createLock.current = false;
      setCreating(false);
    }
  }

  const urgencyColors: Record<string, string> = {
    normal: "bg-slate-100 text-slate-700",
    high: "bg-orange-100 text-orange-700",
    critical: "bg-red-100 text-red-700",
  };

  return (
    <Modal onClose={onClose}>
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Review Parsed Job</h2>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${urgencyColors[urgency] ?? urgencyColors.normal}`}>
            {urgency}
          </span>
        </div>
        <p className="text-sm text-slate-500">Review and edit any field before saving.</p>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 text-sm">
          <div className="md:col-span-2">
            <label className="block text-xs text-slate-500 mb-1">Title *</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Job title" />
          </div>

          <div>
            <label className="block text-xs text-slate-500 mb-1">Location</label>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Remote, Bangalore" />
          </div>

          <div>
            <label className="block text-xs text-slate-500 mb-1">Employment Type</label>
            <select
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
              value={employmentType}
              onChange={(e) => setEmploymentType(e.target.value)}
            >
              <option value="">(None)</option>
              <option value="full_time">Full Time</option>
              <option value="part_time">Part Time</option>
              <option value="contract">Contract</option>
              <option value="internship">Internship</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-slate-500 mb-1">Experience (years)</label>
            <div className="flex gap-2">
              <Input type="number" placeholder="Min" value={expMin} onChange={(e) => setExpMin(e.target.value)} />
              <Input type="number" placeholder="Max" value={expMax} onChange={(e) => setExpMax(e.target.value)} />
            </div>
          </div>


          <div>
            <label className="block text-xs text-slate-500 mb-1">Urgency</label>
            <select
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
              value={urgency}
              onChange={(e) => setUrgency(e.target.value)}
            >
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs text-slate-500 mb-1">About This Role</label>
            <textarea
              className="w-full h-32 rounded-md border border-slate-200 p-2 text-sm resize-none"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs text-slate-500 mb-1">Key Responsibilities (newline separated)</label>
            <textarea
              className="w-full h-32 rounded-md border border-slate-200 p-2 text-sm resize-none"
              value={keyResponsibilities}
              onChange={(e) => setKeyResponsibilities(e.target.value)}
              placeholder="List key responsibilities here..."
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs text-slate-500 mb-1">Required Skills</label>
            <SkillTags
              skills={requiredSkills}
              onRemove={(i) => setRequiredSkills((prev) => prev.filter((_, idx) => idx !== i))}
              onAdd={(s) => setRequiredSkills((prev) => [...prev, s])}
              placeholder="Add required skill…"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs text-slate-500 mb-1">Preferred Skills</label>
            <SkillTags
              skills={preferredSkills}
              onRemove={(i) => setPreferredSkills((prev) => prev.filter((_, idx) => idx !== i))}
              onAdd={(s) => setPreferredSkills((prev) => [...prev, s])}
              placeholder="Add preferred skill…"
            />
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex justify-between pt-2">
          <Button variant="outline" onClick={onBack}>← Back</Button>
          <Button onClick={handleCreate} disabled={creating} className="bg-[#FF5A1F] hover:bg-[#E54E1A] text-white">
            {creating ? "Creating…" : "Create Job ✓"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── main page ────────────────────────────────────────────────────────────────


export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>(() => readCachedJobsList() ?? []);
  const [listLoading, setListLoading] = useState(() => readCachedJobsList() === null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "closed">("all");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const permissions = useAuthStore((state) => state.permissions);
  const role = useAuthStore((state) => state.role);
  const canCreateJobs =
    hasPermission(permissions, JOBS_CREATE_PERMISSION) ||
    hasPermission(permissions, JOBS_UPDATE_PERMISSION) ||
    isAdminRole(role);

  const [creating, setCreating] = useState(false);
  const [clientId, setClientId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [status, setStatus] = useState<JobStatus>("open");
  const [requiredSkills, setRequiredSkills] = useState("");
  const [preferredSkills, setPreferredSkills] = useState("");
  const [expMin, setExpMin] = useState("");
  const [expMax, setExpMax] = useState("");
  const [employmentType, setEmploymentType] = useState("");

  // Client options for selectors
  const [clientOptions, setClientOptions] = useState<Client[]>([]);
  useEffect(() => {
    void listAllClients()
      .then((all) => setClientOptions(all.filter((c) => !c.is_deleted)))
      .catch(() => {});
  }, []);

  // Edit form state
  const [showEdit, setShowEdit] = useState(false);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);

  // Import from JD flow state
  const [showJDInput, setShowJDInput] = useState(false);
  const [jdClientId, setJdClientId] = useState("");
  const [jdImport, setJdImport] = useState<{ result: JobParseResult; sourceFile: File | null } | null>(null);


  const refreshJobs = useCallback(async (options?: { silent?: boolean }) => {
    const hasCached = jobs.length > 0 || readCachedJobsList() !== null;
    if (!options?.silent) {
      setIsRefreshing(true);
      if (!hasCached) {
        setListLoading(true);
      }
    }
    try {
      const data = await getJobs(50, 0);
      setJobs(data);
      writeCachedJobsList(data);
      setError(null);
    } catch (err) {
      if (!options?.silent) {
        setError(err instanceof ApiError ? err.message : "Failed to load jobs.");
      }
    } finally {
      setListLoading(false);
      if (!options?.silent) {
        setIsRefreshing(false);
      }
    }
  }, [jobs.length]);

  const refreshJobsRef = useRef(refreshJobs);
  refreshJobsRef.current = refreshJobs;

  const needsEnrichmentPoll = jobs.some((j) => j.enrichment_status === "enriching");

  async function handleDeleteJob(jobId: string) {
    if (!window.confirm("Are you sure you want to delete this job? This action cannot be undone.")) return;
    try {
      await deleteJob(jobId);
      await refreshJobs();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete job.");
    }
  }

  useEffect(() => {
    void refreshJobsRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load once on mount
  }, []);

  useEffect(() => {
    if (!needsEnrichmentPoll) {
      return;
    }
    const interval = globalThis.setInterval(() => {
      void refreshJobsRef.current({ silent: true });
    }, 8000);
    return () => globalThis.clearInterval(interval);
  }, [needsEnrichmentPoll]);

  useEffect(() => {
    if (!notice) return;
    const t = globalThis.setTimeout(() => setNotice(null), 8000);
    return () => globalThis.clearTimeout(t);
  }, [notice]);

  function resetForm() {
    setTitle(""); setDescription(""); setLocation(""); setClientId("");
    setExpMin(""); setExpMax(""); setEmploymentType("");
    setStatus("open");
  }

  function openEdit(job: Job) {
    setTitle(job.title || "");
    setDescription(job.description || "");
    setLocation(job.location || "");
    setClientId(job.client_id || "");
    setStatus(job.status || "open");
    setRequiredSkills(job.required_skills?.join(", ") || "");
    setPreferredSkills(job.preferred_skills?.join(", ") || "");
    setExpMin(job.experience_min_years?.toString() || "");
    setExpMax(job.experience_max_years?.toString() || "");
    setEmploymentType(job.employment_type || "");

    setEditingJobId(job.id);
    setShowEdit(true);
  }

  function getStatusBadgeClass(jobStatus: JobStatus) {
    if (jobStatus === "open") return "bg-green-100 text-green-700";
    if (jobStatus === "paused") return "bg-yellow-100 text-yellow-700";
    if (jobStatus === "filled") return "bg-blue-100 text-blue-700";
    if (jobStatus === "closed") return "bg-red-100 text-red-600";
    return "bg-gray-100 text-gray-600";
  }

  function getStatusLabel(jobStatus: JobStatus) {
    return jobStatus.replace("_", " ");
  }

  const filteredJobs = jobs.filter((job) => {
    const matchesSearch = job.title.toLowerCase().includes(searchQuery.toLowerCase().trim());
    if (!matchesSearch) return false;
    if (statusFilter === "all") return true;
    if (statusFilter === "closed") return job.status === "filled" || job.status === "closed";
    return job.status === statusFilter;
  });

  return (
    <section className="relative space-y-4">
      {notice ? (
        <div
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900"
          role="status"
        >
          {notice}
        </div>
      ) : null}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-8 w-8 !p-0 rounded-full"
            onClick={() => void refreshJobs()}
            disabled={isRefreshing}
            title="Refresh Jobs"
          >
            <RefreshCw className={`h-4 w-4 text-slate-600 ${isRefreshing ? "animate-spin" : ""}`} />
            <span className="sr-only">Refresh</span>
          </Button>
          {canCreateJobs ? (
            <Link href="/jobs/create">
              <Button className="h-11 bg-[#FF5A1F] hover:bg-[#e04814] text-white rounded-2xl px-5 font-bold shadow-sm transition-colors">
                + Create Job
              </Button>
            </Link>
          ) : null}
        </div>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {/* ── KPI Strip ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-[20px] shadow-[0_2px_12px_rgba(0,0,0,0.02)] bg-white p-5 border border-slate-100/50 hover:shadow-[0_8px_24px_rgba(0,0,0,0.04)] transition-all duration-300 group cursor-default">
          <div className="flex items-center justify-between mb-4">
            <p className="text-[13px] font-semibold text-slate-600 group-hover:text-[#FF5A1F] transition-colors duration-300">Total Jobs</p>
          </div>
          <div className="flex items-center gap-2">
            <p className="text-[32px] leading-none font-bold text-slate-900 group-hover:text-[#FF5A1F] transition-colors duration-300">{jobs.length}</p>
          </div>
        </div>

        <div className="rounded-[20px] shadow-[0_2px_12px_rgba(0,0,0,0.02)] bg-white p-5 border border-slate-100/50 hover:shadow-[0_8px_24px_rgba(0,0,0,0.04)] transition-all duration-300 group cursor-default">
          <div className="flex items-center justify-between mb-4">
            <p className="text-[13px] font-semibold text-slate-600 group-hover:text-[#FF5A1F] transition-colors duration-300">Open Jobs</p>
          </div>
          <div className="flex items-center gap-2">
            <p className="text-[32px] leading-none font-bold text-slate-900 group-hover:text-[#FF5A1F] transition-colors duration-300">{jobs.filter(j => j.status === "open").length}</p>
          </div>
        </div>

        <div className="rounded-[20px] shadow-[0_2px_12px_rgba(0,0,0,0.02)] bg-white p-5 border border-slate-100/50 hover:shadow-[0_8px_24px_rgba(0,0,0,0.04)] transition-all duration-300 group cursor-default">
          <div className="flex items-center justify-between mb-4">
            <p className="text-[13px] font-semibold text-slate-600 group-hover:text-[#FF5A1F] transition-colors duration-300">Paused</p>
          </div>
          <div className="flex items-center gap-2">
            <p className="text-[32px] leading-none font-bold text-slate-900 group-hover:text-[#FF5A1F] transition-colors duration-300">{jobs.filter(j => j.status === "paused").length}</p>
          </div>
        </div>

        <div className="rounded-[20px] shadow-[0_2px_12px_rgba(0,0,0,0.02)] bg-white p-5 border border-slate-100/50 hover:shadow-[0_8px_24px_rgba(0,0,0,0.04)] transition-all duration-300 group cursor-default">
          <div className="flex items-center justify-between mb-4">
            <p className="text-[13px] font-semibold text-slate-600 group-hover:text-[#FF5A1F] transition-colors duration-300">Closed</p>
          </div>
          <div className="flex items-center gap-2">
            <p className="text-[32px] leading-none font-bold text-slate-900 group-hover:text-[#FF5A1F] transition-colors duration-300">{jobs.filter(j => j.status === "filled" || j.status === "closed").length}</p>
          </div>
        </div>
      </div>

      {/* ── Job list ─────────────────────────────────────────────────── */}
      <div className="rounded-[20px] shadow-[0_2px_12px_rgba(0,0,0,0.02)] bg-white overflow-hidden border border-slate-100/50 mt-6">
        <div className="p-6 flex flex-col md:flex-row items-center justify-between gap-4 border-b border-slate-100/80">
          <h2 className="text-[20px] font-extrabold text-slate-900 shrink-0">Job List</h2>
          <div className="flex flex-1 items-center justify-end gap-4 w-full">
            <div className="relative w-full max-w-[320px] group">
              <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-[#FF5A1F] transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                className="w-full h-11 pl-11 pr-4 text-[14px] font-medium bg-white border border-slate-200/80 rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.02)] focus:outline-none focus:ring-2 focus:ring-[#FF5A1F]/15 focus:border-[#FF5A1F]/30 transition-all duration-200 placeholder:text-slate-400 text-slate-800"
                placeholder="Search jobs..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </div>
            <div className="flex items-center gap-2 bg-slate-50 p-1 rounded-2xl border border-slate-200/80">
              {(["all", "open", "closed"] as const).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => setStatusFilter(filter)}
                  className={`cursor-pointer rounded-xl px-4 py-1.5 text-[13px] font-bold transition-all duration-200 ${statusFilter === filter ? "bg-white text-slate-900 shadow-sm border border-slate-200/50" : "text-slate-500 hover:text-slate-700"
                    }`}
                >
                  {filter === "all" ? "All" : filter === "closed" ? "Closed" : filter.charAt(0).toUpperCase() + filter.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="p-6">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filteredJobs.map((job) => (
              <div key={job.id} className="relative group transition-transform duration-300 hover:-translate-y-1 cursor-pointer">
                <Link
                  href={`/jobs/${job.id}`}
                  className="relative flex h-full flex-col rounded-2xl bg-white p-5 border border-slate-100/80 shadow-[0_2px_8px_rgba(0,0,0,0.02)] transition-all duration-300 hover:shadow-[0_8px_24px_rgba(0,0,0,0.06)] hover:border-slate-200"
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-2">
                      {job.client_name && (
                        <p className="truncate text-[11px] font-semibold text-orange-500 uppercase tracking-wide">
                          {job.client_name}
                        </p>
                      )}
                      <p className="truncate text-base font-bold text-slate-900 group-hover:text-[#FF5A1F] transition-colors duration-300">{job.title}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-wide uppercase ${getStatusBadgeClass(job.status)}`}>
                          {getStatusLabel(job.status)}
                        </span>
                        {enrichmentStatusLabel(job.enrichment_status) ? (
                          <span className="inline-flex rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-bold tracking-wide text-amber-800">
                            {enrichmentStatusLabel(job.enrichment_status)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="mb-4 grid grid-cols-2 gap-y-2 gap-x-4 text-[13px] font-medium text-slate-500">
                    <div className="flex items-center gap-1.5">
                      <MapPin className="h-4 w-4 text-slate-400" />
                      <span className="truncate max-w-[120px]">{job.location || "TBD"}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <GraduationCap className="h-4 w-4 text-slate-400" />
                      <span>
                        {(job.experience_min_years !== null || job.experience_max_years !== null)
                          ? `${job.experience_min_years ?? 0}-${job.experience_max_years ?? "+"} yrs`
                          : "TBD"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Calendar className="h-4 w-4 text-slate-400" />
                      <span>{job.created_at ? new Date(job.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : "Unknown"}</span>
                    </div>
                    {job.urgency && job.urgency !== "normal" && (
                      <div className="flex items-center gap-1.5 text-orange-600">
                        <Zap className="h-4 w-4 text-orange-400" />
                        <span className="capitalize">{job.urgency}</span>
                      </div>
                    )}
                  </div>

                  <div className="mt-auto pt-4 border-t border-slate-100/80 flex items-center justify-between text-[13px] font-bold text-slate-400 group-hover:text-[#FF5A1F] transition-colors duration-300">
                    <span>View Details</span>
                    <span className="transform transition-transform duration-300 group-hover:translate-x-1">→</span>
                  </div>
                </Link>
              </div>
            ))}
            {listLoading && jobs.length === 0 ? (
              <div className="rounded-xl bg-slate-50 p-8 text-center text-sm font-medium text-slate-500 md:col-span-2 xl:col-span-3">
                Loading jobs...
              </div>
            ) : !filteredJobs.length ? (
              <div className="rounded-xl bg-slate-50 p-8 text-center text-sm font-medium text-slate-500 md:col-span-2 xl:col-span-3">
                No jobs found for the current search or filters.
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* ── Edit Job Slide-In Panel ─────────────────────────────────── */}
      {showEdit ? (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => { setShowEdit(false); resetForm(); setError(null); }} />
          <div className="relative w-full max-w-[480px] bg-white shadow-2xl h-full flex flex-col overflow-hidden animate-in slide-in-from-right duration-300">
            <div className="flex items-center justify-between p-6 border-b shrink-0">
              <h2 className="text-xl font-semibold text-slate-800">Edit Job</h2>
              <button onClick={() => { setShowEdit(false); resetForm(); setError(null); }} className="text-slate-400 hover:text-slate-600 text-2xl font-bold p-1">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-6 text-sm">
              <div className="space-y-4">
                {clientOptions.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Client</label>
                    <select
                      className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm bg-white focus:border-[#FF5A1F] focus:ring-1 focus:ring-[#FF5A1F]/30 focus:outline-none"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                    >
                      <option value="">— No change —</option>
                      {clientOptions.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Title *</label>
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
                  <select className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value as JobStatus)}>
                    <option value="draft">Draft</option><option value="open">Open</option><option value="paused">Paused</option><option value="closed">Closed</option><option value="filled">Filled</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Description</label>
                  <textarea className="w-full h-32 rounded-md border border-slate-200 p-2 text-sm resize-none" value={description} onChange={(e) => setDescription(e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Location</label>
                  <Input value={location} onChange={(e) => setLocation(e.target.value)} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div><label className="block text-xs font-medium text-slate-500 mb-1">Min Exp</label><Input type="number" value={expMin} onChange={(e) => setExpMin(e.target.value)} /></div>
                  <div><label className="block text-xs font-medium text-slate-500 mb-1">Max Exp</label><Input type="number" value={expMax} onChange={(e) => setExpMax(e.target.value)} /></div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Required Skills (comma/newline)</label>
                  <textarea className="h-24 w-full rounded-md border border-slate-200 p-2 text-sm resize-none" value={requiredSkills} onChange={(e) => setRequiredSkills(e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Preferred Skills (comma/newline)</label>
                  <textarea className="h-24 w-full rounded-md border border-slate-200 p-2 text-sm resize-none" value={preferredSkills} onChange={(e) => setPreferredSkills(e.target.value)} />
                </div>
              </div>
              {error && <p className="text-sm font-medium text-red-600 bg-red-50 p-3 rounded-md border border-red-100">{error}</p>}
            </div>
            <div className="p-6 border-t bg-slate-50 shrink-0">
              <Button className="w-full py-6 text-lg bg-[#FF5A1F] hover:bg-[#E54E1A] text-white" disabled={creating} onClick={async () => {
                if (!title.trim() || !editingJobId) return;
                try {
                  setCreating(true);
                  const req = requiredSkills.split(/[\n,]+/g).map((s) => s.trim()).filter(Boolean);
                  const pref = preferredSkills.split(/[\n,]+/g).map((s) => s.trim()).filter(Boolean);
                  await updateJob(editingJobId, {
                    ...(clientId.trim() ? { client_id: clientId.trim() } : {}),
                    title: title.trim(),
                    description: description.trim() || null,
                    location: location.trim() || undefined,
                    experience_min_years: expMin ? Number(expMin) : undefined,
                    experience_max_years: expMax ? Number(expMax) : undefined,
                    required_skills: req.length ? req : undefined,
                    preferred_skills: pref.length ? pref : undefined,
                  });
                  setShowEdit(false); resetForm(); await refreshJobs();
                } catch (err) { setError("Unable to update job."); } finally { setCreating(false); }
              }}>{creating ? "Saving..." : "Save Changes"}</Button>
            </div>
          </div>
        </div>
      ) : null}



      {/* ── JD Input modal ───────────────────────────────────────────── */}
      {showJDInput ? (
        <JDInputModal
          onClose={() => setShowJDInput(false)}
          onParsed={(result, sourceFile) => {
            setJdImport({ result, sourceFile });
            setShowJDInput(false);
          }}
        />
      ) : null}

      {/* ── Preview / confirm modal ──────────────────────────────────── */}
      {jdImport ? (
        <JDPreviewModal
          initial={jdImport.result}
          sourceFile={jdImport.sourceFile}
          clientId={jdClientId}
          onBack={() => {
            setJdImport(null);
            setShowJDInput(true);
          }}
          onClose={() => { setJdImport(null); setJdClientId(""); }}
          onCreated={(job) => {
            setJdImport(null);
            setJdClientId("");
            setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
            setNotice("Job created. Preparing ATS metadata in the background.");
            void refreshJobs();
          }}
        />
      ) : null}
    </section >
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api/client";
import {
  createJob,
  parseJD,
  uploadJobJdDocument,
  checkDuplicateJob,
  type DuplicateJobMatchOut,
  type JobParseResult,
} from "@/lib/api/jobs";
import { listAllClients } from "@/lib/api/clients";
import { JOBS_CREATE_PERMISSION, JOBS_UPDATE_PERMISSION, hasPermission } from "@/lib/rbac";
import { isAdminRole } from "@/lib/dashboard-nav";
import type { Client, Job } from "@/lib/api/types";
import { useAuthStore } from "@/store/auth-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ClipboardPaste,
  Edit3,
  FileText,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { assertAllowedDocumentFile } from "@/lib/documents/fileSecurityValidator";

type JobAddMode = "manual" | "upload" | "paste";

const STEPPER_LABELS = ["Method", "Job info", "Review", "Done"] as const;
const PARSE_STEPS = ["Parsing JD…", "Extracting skills…", "Structuring data…"];

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
            key={`${s}-${i}`}
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
          className="h-7 text-xs border-gray-200 focus:border-[#FF5A1F] focus:ring-[#FF5A1F]/20"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
        <Button type="button" variant="outline" className="h-7 px-2 text-xs" onClick={commit}>
          Add
        </Button>
      </div>
    </div>
  );
}

function buildDescriptionWithAppendix(
  base: string,
  requirementsText: string,
  appendixLines: { label: string; value: string }[]
): string {
  const parts: string[] = [];
  if (base.trim()) parts.push(base.trim());
  if (requirementsText.trim()) {
    parts.push(`Requirements\n${requirementsText.trim()}`);
  }
  const appendix = appendixLines
    .filter((l) => l.value.trim())
    .map((l) => `${l.label}: ${l.value.trim()}`)
    .join("\n");
  if (appendix) parts.push(`Additional details\n${appendix}`);
  return parts.join("\n\n");
}

export default function JobCreatePage() {
  const permissions = useAuthStore((state) => state.permissions);
  const role = useAuthStore((state) => state.role);
  const token = useAuthStore((state) => state.token);
  const refreshPermissions = useAuthStore((state) => state.refreshPermissions);

  const canCreateJobs =
    hasPermission(permissions, JOBS_CREATE_PERMISSION) ||
    hasPermission(permissions, JOBS_UPDATE_PERMISSION) ||
    isAdminRole(role);

  const [activeStep, setActiveStep] = useState(1);
  const [addMode, setAddMode] = useState<JobAddMode>("manual");
  const [error, setError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateJobMatchOut[] | null>(null);
  const [ignoreDuplicate, setIgnoreDuplicate] = useState(false);

  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState("");
  const [employmentType, setEmploymentType] = useState("");
  const [workMode, setWorkMode] = useState("");
  const [location, setLocation] = useState("");
  const [expMin, setExpMin] = useState("");
  const [expMax, setExpMax] = useState("");
  const [salaryMin, setSalaryMin] = useState("");
  const [salaryMax, setSalaryMax] = useState("");
  const [salaryCurrency, setSalaryCurrency] = useState("USD");
  const [urgency, setUrgency] = useState("normal");
  const [description, setDescription] = useState("");
  const [keyResponsibilities, setKeyResponsibilities] = useState("");
  const [requirementsText, setRequirementsText] = useState("");
  const [hiringManager, setHiringManager] = useState("");
  const [openingsCount, setOpeningsCount] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [requiredSkills, setRequiredSkills] = useState<string[]>([]);
  const [preferredSkills, setPreferredSkills] = useState<string[]>([]);

  const [rawJdText, setRawJdText] = useState<string | null>(null);
  const [parsingSource, setParsingSource] = useState<string | null>(null);
  const [parsingStatus, setParsingStatus] = useState<string | null>(null);

  const [jdUploadFile, setJdUploadFile] = useState<File | null>(null);
  const [jdPasteText, setJdPasteText] = useState("");
  const [jdSourceFile, setJdSourceFile] = useState<File | null>(null);
  /** For upload/paste: false = step 2 shows only JD input + parse; true = step 2 shows full form (after Back/Edit from Review). */
  const [jdStep2ShowForm, setJdStep2ShowForm] = useState(false);
  const [jdParsedApplied, setJdParsedApplied] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseStep, setParseStep] = useState(0);
  const jdFileRef = useRef<HTMLInputElement>(null);

  const [clientId, setClientId] = useState<string>("");
  const [clients, setClients] = useState<Client[]>([]);

  const [creating, setCreating] = useState(false);
  const createLock = useRef(false);
  const [createdJob, setCreatedJob] = useState<Job | null>(null);

  useEffect(() => {
    if (!token) return;
    void refreshPermissions();
  }, [token, refreshPermissions]);

  // Fetch available clients for the selector
  useEffect(() => {
    void listAllClients()
      .then((all) => setClients(all.filter((c) => !c.is_deleted)))
      .catch(() => {}); // graceful — client selector degrades to empty
  }, []);

  useEffect(() => {
    if (!parsing) return;
    const interval = window.setInterval(() => {
      setParseStep((prev) => (prev + 1) % PARSE_STEPS.length);
    }, 1500);
    return () => window.clearInterval(interval);
  }, [parsing]);

  function selectJobMethod(m: JobAddMode) {
    setAddMode(m);
    setError(null);
    setJdStep2ShowForm(false);
    if (m === "manual") {
      setJdUploadFile(null);
      setJdSourceFile(null);
      setJdPasteText("");
      setJdParsedApplied(true);
      setParsingSource(null);
      setParsingStatus(null);
      setRawJdText(null);
    } else if (m === "upload") {
      setJdPasteText("");
      setJdParsedApplied(false);
      setRawJdText(null);
      setParsingSource(null);
      setParsingStatus(null);
    } else {
      setJdUploadFile(null);
      setJdSourceFile(null);
      setJdParsedApplied(false);
      setRawJdText(null);
      setParsingSource(null);
      setParsingStatus(null);
    }
  }

  const applyParseResult = useCallback(
    (result: JobParseResult, sourceFile: File | null, source: "text" | "file", pastedRaw: string) => {
      setTitle(result.title ?? "");
      setLocation(result.location ?? "");
      setEmploymentType(result.employment_type ?? "");
      setExpMin(result.experience_min_years !== null && result.experience_min_years !== undefined ? String(result.experience_min_years) : "");
      setExpMax(result.experience_max_years !== null && result.experience_max_years !== undefined ? String(result.experience_max_years) : "");
      setSalaryMin(result.salary_min !== null && result.salary_min !== undefined ? String(result.salary_min) : "");
      setSalaryMax(result.salary_max !== null && result.salary_max !== undefined ? String(result.salary_max) : "");
      setSalaryCurrency(result.salary_currency || "USD");
      setUrgency(result.urgency || "normal");
      setDescription(result.description ?? "");
      setKeyResponsibilities(result.key_responsibilities?.join("\n") ?? "");
      setRequiredSkills(result.required_skills ?? []);
      setPreferredSkills(result.preferred_skills ?? []);
      setRawJdText(result.raw_jd_text ?? (source === "text" ? pastedRaw : null));
      setParsingSource(source === "text" ? "text" : "file");
      setParsingStatus("success");
      setJdSourceFile(sourceFile);
      setJdParsedApplied(true);
      setError(null);
    },
    []
  );

  async function handleParseJd() {
    setError(null);
    if (addMode === "paste" && !jdPasteText.trim()) {
      setError("Paste a job description first.");
      return;
    }
    if (addMode === "upload" && !jdUploadFile) {
      setError("Select a JD file first.");
      return;
    }
    try {
      if (addMode === "upload" && jdUploadFile) assertAllowedDocumentFile(jdUploadFile);
      setParsing(true);
      const result =
        addMode === "paste"
          ? await parseJD({ type: "text", text: jdPasteText })
          : await parseJD({ type: "file", file: jdUploadFile! });
      applyParseResult(
        {
          ...result,
          raw_jd_text: result.raw_jd_text ?? (addMode === "paste" ? jdPasteText : undefined),
          parsing_source: addMode === "paste" ? "text" : "file",
          parsing_status: "success",
        },
        addMode === "upload" ? jdUploadFile : null,
        addMode === "paste" ? "text" : "file",
        jdPasteText
      );
      if (addMode === "upload" || addMode === "paste") {
        setJdStep2ShowForm(false);
        setActiveStep(3);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Parsing failed. Try again.");
    } finally {
      setParsing(false);
    }
  }

  function validateCoreFields(): string | null {
    if (!title.trim()) return "Job title is required.";
    if (expMin && expMax && Number(expMin) > Number(expMax)) {
      return "Experience minimum cannot be greater than maximum.";
    }
    if (salaryMin && salaryMax && Number(salaryMin) > Number(salaryMax)) {
      return "Salary minimum cannot be greater than maximum.";
    }
    return null;
  }

  function buildCreatePayload() {
    const descriptionPayload = buildDescriptionWithAppendix(description, requirementsText, [
      { label: "Department", value: department },
      { label: "Work mode", value: workMode },
      { label: "Hiring manager", value: hiringManager },
      { label: "Openings", value: openingsCount },
      { label: "Expiry / target date", value: expiryDate },
    ]);
    return {
      client_id: clientId.trim() || null,
      title: title.trim(),
      description: descriptionPayload.trim() || null,
      status: "open" as const,
      location: location.trim() || undefined,
      salary_min: salaryMin.trim() ? Number(salaryMin) : null,
      salary_max: salaryMax.trim() ? Number(salaryMax) : null,
      salary_currency: salaryCurrency.trim() || "USD",
      experience_min_years: expMin.trim() ? Number(expMin) : null,
      experience_max_years: expMax.trim() ? Number(expMax) : null,
      employment_type: employmentType.trim() || null,
      urgency: urgency.trim() || "normal",
      required_skills: requiredSkills,
      preferred_skills: preferredSkills,
      key_responsibilities: keyResponsibilities
        .split(/[\n]+/g)
        .map((s) => s.trim())
        .filter(Boolean),
      raw_jd_text: rawJdText?.trim() || null,
      parsing_source: parsingSource,
      parsing_status: parsingStatus,
    };
  }

  async function handleCreateJob() {
    const v = validateCoreFields();
    if (v) {
      setError(v);
      return;
    }

    if (!ignoreDuplicate) {
      try {
        setCreating(true);
        const res = await checkDuplicateJob({ title: title.trim(), client_id: clientId.trim() || undefined, location: location.trim() || undefined });
        if (res.has_duplicates && res.matches.length > 0) {
          setDuplicateWarning(res.matches);
          setCreating(false);
          return;
        }
      } catch (err) {
        console.error("Duplicate check failed, proceeding anyway", err);
      } finally {
        setCreating(false);
      }
    }

    if (createLock.current) return;
    createLock.current = true;
    setError(null);
    setCreating(true);
    try {
      const payload = buildCreatePayload();
      let job = await createJob(payload);
      if (jdSourceFile) {
        try {
          job = await uploadJobJdDocument(job.id, jdSourceFile);
        } catch (uploadErr) {
          setError(
            uploadErr instanceof ApiError
              ? `${uploadErr.message} The job was created; you can re-upload the JD from job settings when available.`
              : "Job created but JD file upload failed. Try again from the job page."
          );
          setCreatedJob(job);
          setActiveStep(4);
          return;
        }
      }
      setCreatedJob(job);
      setActiveStep(4);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create job.");
    } finally {
      createLock.current = false;
      setCreating(false);
    }
  }

  const handleNextFromStep1 = () => {
    setError(null);
    setJdStep2ShowForm(false);
    setActiveStep(2);
  };

  const handleNextFromStep2 = () => {
    const v = validateCoreFields();
    if (v) {
      setError(v);
      return;
    }
    if ((addMode === "upload" || addMode === "paste") && !jdParsedApplied) {
      setError("Parse the JD first, or switch to Create Manually.");
      return;
    }
    setError(null);
    setActiveStep(3);
  };

  const handleBackFromReview = () => {
    setError(null);
    if (addMode === "upload" || addMode === "paste") {
      setJdStep2ShowForm(true);
    }
    setActiveStep(2);
  };

  const handleBack = () => {
    setError(null);
    setActiveStep((s) => Math.max(1, s - 1));
  };

  const resetWizard = () => {
    setActiveStep(1);
    setAddMode("manual");
    setError(null);
    setClientId("");
    setTitle("");
    setDepartment("");
    setEmploymentType("");
    setWorkMode("");
    setLocation("");
    setExpMin("");
    setExpMax("");
    setSalaryMin("");
    setSalaryMax("");
    setSalaryCurrency("USD");
    setUrgency("normal");
    setDescription("");
    setKeyResponsibilities("");
    setRequirementsText("");
    setHiringManager("");
    setOpeningsCount("");
    setExpiryDate("");
    setRequiredSkills([]);
    setPreferredSkills([]);
    setRawJdText(null);
    setParsingSource(null);
    setParsingStatus(null);
    setJdUploadFile(null);
    setJdPasteText("");
    setJdSourceFile(null);
    setJdParsedApplied(false);
    setJdStep2ShowForm(false);
    setCreatedJob(null);
  };

  const renderStepper = () => (
    <div className="mb-8 flex items-center justify-between border-b border-gray-100 pb-6">
      {STEPPER_LABELS.map((step, idx) => {
        const isCompleted = activeStep > idx + 1;
        const isActive = activeStep === idx + 1;
        return (
          <div key={step} className="flex items-center">
            <div
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full border text-sm font-medium transition-colors",
                isActive
                  ? "border-[#FF5A1F] bg-orange-50 text-[#FF5A1F]"
                  : isCompleted
                    ? "border-green-600 bg-green-50 text-green-600"
                    : "border-gray-200 text-gray-400"
              )}
            >
              {isCompleted ? <CheckCircle2 className="w-4 h-4" /> : idx + 1}
            </div>
            <span className={cn("ml-3 text-sm font-medium", isActive ? "text-gray-900" : "text-gray-500")}>{step}</span>
            {idx < STEPPER_LABELS.length - 1 && <div className="mx-4 md:mx-8 h-px w-8 md:w-16 bg-gray-200" />}
          </div>
        );
      })}
    </div>
  );

  const inputClass = "h-10 border-gray-200 focus:border-[#FF5A1F] focus:ring-[#FF5A1F]/20";
  const selectClass =
    "w-full rounded-md border border-gray-200 px-3 py-2 text-sm h-10 bg-white focus:border-[#FF5A1F] focus:ring-[#FF5A1F]/20 focus:outline-none";
  const textareaClass =
    "w-full rounded-md border border-gray-200 p-2 text-sm resize-none focus:border-[#FF5A1F] focus:ring-1 focus:ring-[#FF5A1F]/20 focus:outline-none";

  function renderJobInformationForm(opts?: { omitSalary?: boolean }) {
    const omitSalary = opts?.omitSalary ?? false;
    return (
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        {clients.length > 0 && (
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-medium text-gray-700">
              Client <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <select
              className={selectClass}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              <option value="">— Select a client —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="space-y-2 md:col-span-2">
          <label className="text-sm font-medium text-gray-700">Job Title *</label>
          <Input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Senior Software Engineer" />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700">Department</label>
          <Input className={inputClass} value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Engineering" />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700">Employment Type</label>
          <select className={selectClass} value={employmentType} onChange={(e) => setEmploymentType(e.target.value)}>
            <option value="">(None)</option>
            <option value="full_time">Full Time</option>
            <option value="part_time">Part Time</option>
            <option value="contract">Contract</option>
            <option value="internship">Internship</option>
          </select>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700">Work Mode</label>
          <select className={selectClass} value={workMode} onChange={(e) => setWorkMode(e.target.value)}>
            <option value="">(None)</option>
            <option value="remote">Remote</option>
            <option value="hybrid">Hybrid</option>
            <option value="onsite">On-site</option>
          </select>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700">Location</label>
          <Input className={inputClass} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Remote, Bangalore…" />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700">Experience (years)</label>
          <div className="flex gap-2">
            <Input className={inputClass} type="number" placeholder="Min" value={expMin} onChange={(e) => setExpMin(e.target.value)} />
            <Input className={inputClass} type="number" placeholder="Max" value={expMax} onChange={(e) => setExpMax(e.target.value)} />
          </div>
        </div>
        {!omitSalary && (
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">Salary range</label>
            <div className="flex flex-wrap gap-2">
              <Input className={cn(inputClass, "min-w-[100px] flex-1")} type="number" placeholder="Min" value={salaryMin} onChange={(e) => setSalaryMin(e.target.value)} />
              <Input className={cn(inputClass, "min-w-[100px] flex-1")} type="number" placeholder="Max" value={salaryMax} onChange={(e) => setSalaryMax(e.target.value)} />
              <Input className={cn(inputClass, "w-24")} placeholder="USD" value={salaryCurrency} onChange={(e) => setSalaryCurrency(e.target.value)} />
            </div>
          </div>
        )}
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700">Priority</label>
          <select className={selectClass} value={urgency} onChange={(e) => setUrgency(e.target.value)}>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700">Hiring Manager</label>
          <Input className={inputClass} value={hiringManager} onChange={(e) => setHiringManager(e.target.value)} placeholder="Name or email" />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700">Openings Count</label>
          <Input className={inputClass} type="number" min={0} value={openingsCount} onChange={(e) => setOpeningsCount(e.target.value)} placeholder="1" />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700">Expiry Date</label>
          <Input className={inputClass} type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
        </div>
        <div className="space-y-2 md:col-span-2">
          <label className="text-sm font-medium text-gray-700">Required Skills</label>
          <SkillTags
            skills={requiredSkills}
            onRemove={(i) => setRequiredSkills((prev) => prev.filter((_, idx) => idx !== i))}
            onAdd={(s) => setRequiredSkills((prev) => [...prev, s])}
            placeholder="Add required skill…"
          />
        </div>
        <div className="space-y-2 md:col-span-2">
          <label className="text-sm font-medium text-gray-700">Nice to Have Skills</label>
          <SkillTags
            skills={preferredSkills}
            onRemove={(i) => setPreferredSkills((prev) => prev.filter((_, idx) => idx !== i))}
            onAdd={(s) => setPreferredSkills((prev) => [...prev, s])}
            placeholder="Add preferred skill…"
          />
        </div>
        <div className="space-y-2 md:col-span-2">
          <label className="text-sm font-medium text-gray-700">Job Description</label>
          <textarea className={cn(textareaClass, "min-h-[128px]")} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="About this role…" />
        </div>
        <div className="space-y-2 md:col-span-2">
          <label className="text-sm font-medium text-gray-700">Responsibilities (one per line)</label>
          <textarea
            className={cn(textareaClass, "min-h-[96px]")}
            value={keyResponsibilities}
            onChange={(e) => setKeyResponsibilities(e.target.value)}
            placeholder="List responsibilities…"
          />
        </div>
        <div className="space-y-2 md:col-span-2">
          <label className="text-sm font-medium text-gray-700">Requirements</label>
          <textarea
            className={cn(textareaClass, "min-h-[96px]")}
            value={requirementsText}
            onChange={(e) => setRequirementsText(e.target.value)}
            placeholder="Must-have qualifications…"
          />
        </div>
      </div>
    );
  }

  if (!canCreateJobs) {
    return (
      <section className="mx-auto max-w-4xl space-y-6 py-6">
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
          <p className="text-sm text-gray-600">You don&apos;t have permission to create jobs.</p>
          <Link href="/jobs" className="mt-4 inline-flex text-sm font-medium text-[#FF5A1F] hover:underline">
            Back to Jobs
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Create Job</h1>
        <Link href="/jobs" className="flex items-center gap-2 text-sm font-medium text-gray-500 transition-colors hover:text-gray-900">
          <ArrowLeft className="h-4 w-4" /> Back to List
        </Link>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        {renderStepper()}

        {error && (
          <div className="mb-6 flex items-center gap-2 rounded-lg border border-red-100 bg-red-50 p-4 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {activeStep === 1 && (
          <div className="animate-in fade-in duration-300">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-gray-900">Select Method</h2>
              <p className="mt-1 text-sm text-gray-500">Choose how you want to create this job.</p>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {[
                { id: "manual" as const, title: "Create Manually", desc: "Enter all details yourself", icon: Edit3 },
                { id: "upload" as const, title: "Upload JD", desc: "AI extracts fields from a file", icon: Upload },
                { id: "paste" as const, title: "Paste JD", desc: "Paste text and parse with AI", icon: ClipboardPaste },
              ].map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => selectJobMethod(m.id)}
                  className={cn(
                    "group flex flex-col rounded-xl border p-5 text-left transition-all",
                    addMode === m.id
                      ? "border-[#FF5A1F] bg-orange-50/30 ring-1 ring-[#FF5A1F]"
                      : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                  )}
                >
                  <m.icon className={cn("mb-3 h-6 w-6", addMode === m.id ? "text-[#FF5A1F]" : "text-gray-400 group-hover:text-gray-600")} />
                  <p className={cn("text-sm font-semibold", addMode === m.id ? "text-gray-900" : "text-gray-700")}>{m.title}</p>
                  <p className="mt-1 text-xs text-gray-500">{m.desc}</p>
                </button>
              ))}
            </div>

            <div className="mt-8 flex justify-end pt-4">
              <Button onClick={handleNextFromStep1} className="bg-[#FF5A1F] text-white hover:bg-[#E54E1A]">
                Next <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {activeStep === 2 && (
          <div className="animate-in fade-in duration-300">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-gray-900">Job Information</h2>
              <p className="mt-1 text-sm text-gray-500">
                {addMode === "manual" && "Provide job details. Fields marked * are required before review."}
                {addMode === "upload" &&
                  (jdStep2ShowForm
                    ? "Edit job details below, then continue to review."
                    : "Upload a job description file, then parse with AI to review extracted fields.")}
                {addMode === "paste" &&
                  (jdStep2ShowForm
                    ? "Edit job details below, then continue to review."
                    : "Paste the full job description, then parse with AI to review extracted fields.")}
              </p>
            </div>

            {addMode === "upload" && !jdStep2ShowForm && (
              <div className="mb-8 space-y-4">
                <label
                  htmlFor="jd-upload-input"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = e.dataTransfer.files?.[0];
                    if (f) {
                      setJdUploadFile(f);
                      setJdParsedApplied(false);
                    }
                  }}
                  className={cn(
                    "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 transition-colors",
                    jdUploadFile ? "border-[#FF5A1F]/30 bg-orange-50/20" : "border-gray-200 hover:border-[#FF5A1F]/40 hover:bg-gray-50/50"
                  )}
                >
                  {jdUploadFile ? (
                    <div className="flex flex-col items-center gap-3">
                      <FileText className="h-8 w-8 text-[#FF5A1F]" />
                      <p className="text-sm font-medium text-gray-900">{jdUploadFile.name}</p>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          setJdUploadFile(null);
                          setJdParsedApplied(false);
                        }}
                        className="mt-2 rounded-md bg-red-50 px-3 py-1 text-xs font-medium text-red-600 transition-colors hover:text-red-700"
                      >
                        Remove File
                      </button>
                    </div>
                  ) : (
                    <div className="text-center">
                      <Upload className="mx-auto mb-4 h-8 w-8 text-gray-400" />
                      <p className="text-sm font-medium text-gray-700">
                        Drag & Drop or <span className="text-[#FF5A1F]">Browse</span>
                      </p>
                      <p className="mt-2 text-xs text-gray-500">Accepted: .pdf, .doc, .docx, .txt (max 15MB)</p>
                    </div>
                  )}
                </label>
                <input
                  id="jd-upload-input"
                  ref={jdFileRef}
                  type="file"
                  accept=".pdf,.doc,.docx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    setJdUploadFile(e.target.files?.[0] ?? null);
                    setJdParsedApplied(false);
                  }}
                />
                <div className="flex justify-end">
                  <Button onClick={() => void handleParseJd()} disabled={parsing || !jdUploadFile} className="bg-[#FF5A1F] text-white hover:bg-[#E54E1A]">
                    {parsing ? PARSE_STEPS[parseStep] : "Parse JD →"}
                  </Button>
                </div>
              </div>
            )}

            {addMode === "paste" && !jdStep2ShowForm && (
              <div className="mb-8 space-y-4">
                <div className="flex border-b border-gray-200">
                  <div className="border-b-2 border-[#FF5A1F] px-4 py-2 text-sm font-medium text-[#FF5A1F]">Paste JD</div>
                </div>
                <textarea
                  className={cn(textareaClass, "min-h-[200px]")}
                  placeholder="Paste the full job description here…"
                  value={jdPasteText}
                  onChange={(e) => {
                    setJdPasteText(e.target.value);
                    setJdParsedApplied(false);
                  }}
                />
                <div className="flex justify-end">
                  <Button onClick={() => void handleParseJd()} disabled={parsing || !jdPasteText.trim()} className="bg-[#FF5A1F] text-white hover:bg-[#E54E1A]">
                    {parsing ? PARSE_STEPS[parseStep] : "Parse JD →"}
                  </Button>
                </div>
              </div>
            )}

            {(addMode === "manual" || ((addMode === "upload" || addMode === "paste") && jdStep2ShowForm)) && (
              <>
                {renderJobInformationForm()}
                <div className="mt-8 flex items-center justify-between border-t border-gray-100 pt-8">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setError(null);
                      if (addMode === "manual") {
                        handleBack();
                      } else {
                        setActiveStep(3);
                      }
                    }}
                    className="border-gray-200 text-gray-600 hover:bg-gray-50"
                  >
                    Back
                  </Button>
                  <Button onClick={handleNextFromStep2} className="min-w-[120px] bg-[#FF5A1F] text-white hover:bg-[#E54E1A]">
                    Next <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              </>
            )}

            {(addMode === "upload" || addMode === "paste") && !jdStep2ShowForm && (
              <div className="flex justify-start border-t border-gray-100 pt-8">
                <Button variant="outline" onClick={handleBack} className="border-gray-200 text-gray-600 hover:bg-gray-50">
                  Back
                </Button>
              </div>
            )}
          </div>
        )}

        {activeStep === 3 && (
          <div className="animate-in fade-in duration-300">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-gray-900">Job Information</h2>
              <p className="mt-1 text-sm text-gray-500">Review and edit details below, then create the job.</p>
            </div>
            {renderJobInformationForm({ omitSalary: true })}
            <div className="mt-8 flex items-center justify-between border-t border-gray-100 pt-8">
              <Button variant="outline" onClick={handleBackFromReview} className="border-gray-200 text-gray-600 hover:bg-gray-50">
                Back
              </Button>
              <Button
                onClick={() => void handleCreateJob()}
                disabled={creating}
                className="min-w-[140px] bg-[#FF5A1F] text-white hover:bg-[#E54E1A]"
              >
                {creating ? "Creating…" : "Create Job"}
              </Button>
            </div>
          </div>
        )}

        {activeStep === 4 && (
          <div className="animate-in fade-in duration-300 py-10 text-center">
            <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-green-600">
              <CheckCircle2 className="h-8 w-8" />
            </div>
            <h2 className="text-2xl font-semibold text-gray-900">Job created</h2>
            <p className="mx-auto mt-2 max-w-sm text-gray-500">
              {createdJob ? `“${createdJob.title}” is saved.` : "The job has been successfully created."}
            </p>
            <div className="flex flex-wrap justify-center gap-4 pt-8">
              <Link href="/jobs">
                <Button variant="outline" className="border-gray-200 text-gray-700 hover:bg-gray-50">
                  Back to Jobs
                </Button>
              </Link>
              {createdJob ? (
                <Link href={`/jobs/${createdJob.id}`}>
                  <Button className="bg-[#FF5A1F] text-white hover:bg-[#E54E1A]">View Job</Button>
                </Link>
              ) : null}
            </div>
            <button
              type="button"
              onClick={resetWizard}
              className="mt-6 text-sm font-medium text-gray-500 underline-offset-2 hover:text-gray-800 hover:underline"
            >
              Create another job
            </button>
          </div>
        )}
      </div>

      {duplicateWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 sm:p-0">
          <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
            <div className="mb-5 flex items-start gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-100 text-[#FF5A1F]">
                <AlertCircle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Potential Duplicate Job Found</h3>
                <p className="mt-1 text-sm text-gray-500">
                  We found existing jobs in your organization with a similar title and location.
                </p>
              </div>
            </div>

            <div className="mb-6 max-h-[40vh] overflow-y-auto rounded-lg border border-gray-100 bg-gray-50">
              {duplicateWarning.map((match) => (
                <div key={match.job_id} className="flex flex-col gap-2 border-b border-gray-100 p-4 last:border-0 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-medium text-gray-900">{match.title}</p>
                    <div className="mt-1 flex items-center gap-3 text-xs text-gray-500">
                      <span className="capitalize">Status: {match.status}</span>
                      <span>Created: {new Date(match.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <Link 
                    href={`/jobs/${match.job_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center text-sm font-medium text-[#FF5A1F] hover:underline sm:mt-0"
                  >
                    View Existing
                  </Link>
                </div>
              ))}
            </div>

            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button
                variant="outline"
                onClick={() => setDuplicateWarning(null)}
                className="border-gray-200 text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setIgnoreDuplicate(true);
                  setDuplicateWarning(null);
                  setTimeout(() => void handleCreateJob(), 0);
                }}
                className="bg-[#FF5A1F] text-white hover:bg-[#E54E1A]"
              >
                Continue Creating Anyway
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

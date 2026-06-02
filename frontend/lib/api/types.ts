export type LoginPayload = {
  email: string;
  password: string;
};

export type SignupPayload = {
  email: string;
  password: string;
  organization_name: string;
};

export type UserRole = string;
export type UserType = "internal" | "client";
export type Permission = string;

export type TokenResponse = {
  access_token: string;
  token_type: string;
  role: UserRole;
  user_type: UserType;
  organization_id: string;
  permissions: Permission[];
};

export type MePermissionsResponse = {
  role: UserRole | "";
  permissions: Permission[];
};

export type SignupResponse = {
  message: string;
};

/** Role key must exist as organization_roles.key for the tenant (built-in or custom). */
export type InviteRole = string;

export type CreateInvitePayload = {
  email: string;
  role: InviteRole;
  expires_in_days?: number;
};

export type InviteCreateResponse = {
  message: string;
  token: string;
  invite: {
    id: string;
    email: string;
    organization_id: string;
    role: string;
    status: string;
    expires_at: string;
    created_at: string;
  };
};

export type AcceptInvitePayload = {
  token: string;
  password: string;
};

export type InviteAcceptResponse = {
  message: string;
};

export type InviteStatus = "sent" | "opened" | "accepted" | "expired";

export type InviteListItem = {
  id: string;
  email: string;
  role: string;
  /** F-INV-05: full lifecycle status */
  status: InviteStatus;
  created_at: string;
  expires_at: string;
  /** F-INV-05: per-transition timestamps (null until transition occurs) */
  sent_at: string | null;
  opened_at: string | null;
  accepted_at: string | null;
  expired_at: string | null;
};

export type InviteResendResponse = {
  message: string;
};

/** Must match an organization_roles.key in the current organization. */
export type UserRoleOption = string;

export type OrganizationUser = {
  id: string;
  email: string;
  role: string;
  type: string;
  created_at: string;
};

export type UpdateUserRolePayload = {
  role: UserRoleOption;
};

export type OrganizationRole = {
  id: string;
  organization_id: string;
  name: string;
  key: string;
};

export type PermissionCatalogItem = {
  code: string;
  display_name: string;
};

export type PermissionModuleGroup = {
  module: string;
  permissions: PermissionCatalogItem[];
};

export type ReplaceRolePermissionsPayload = {
  permissions: string[];
};

export type RoleInUseAffectedUser = {
  id: string;
  email: string;
};

/**
 * Structured body inside `ApiError.detail.detail` when the API returns
 * 409 ROLE_IN_USE for a blocked role deletion.
 */
export type RoleInUseErrorDetail = {
  message: string;
  code: "ROLE_IN_USE";
  affected_users: RoleInUseAffectedUser[];
};

export type Candidate = {
  id: string;
  organization_id: string;
  /** Present when API exposes candidate provenance (vendor vs internal submission). */
  source_type?: "internal" | "vendor";
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  location: string | null;
  role: string | null;
  stage?: "applied" | "ai_interview" | "shortlisted" | "interview" | "offered" | "hired" | "rejected";
  job_id?: string | null;
  recruiter_id?: string | null;
  resume_s3_key?: string | null;
  resume_file_name?: string | null;
  source?: "manual" | "resume_upload" | "bulk_upload" | "referral" | "agency" | "import" | "merge";
  status?: "active" | "archived" | "deleted";
  years_experience: number | null;
  experience_summary: string | null;
  education: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  parse_status?: "pending" | "processing" | "completed" | "failed" | null;
  parse_error?: string | null;
  parsed_at?: string | null;
  parsed_resume_data?: {
    skills?: string[];
    inferred_skills?: string[];
    ecosystem_tags?: string[];
    years_of_experience?: number | null;
    previous_titles?: string[];
    education?: string | string[] | null;
    certifications?: string[];
    normalized_keywords?: string[];
    seniority_guess?: string | null;
    cloud_platforms?: string[];
    frameworks_enriched?: string[];
    databases_enriched?: string[];
    leadership_signals?: string[];
    resume_recruiter_summary?: string | null;
    extraction_version?: string | null;
  } | null;
};

/** Assigned vendor on a job (GET /jobs/:id/vendors). */
export type JobVendorAssignment = {
  vendor_id: string;
  email: string;
};

/** Row from GET /jobs/:jobId/candidates (single request). */
export type JobCandidateListItem = {
  pipeline_id: string;
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  source_type: "internal" | "vendor";
};

/** Candidate submitted to a job (UI row). */
export type JobCandidateRow = {
  pipeline_id: string;
  candidate: Candidate;
};

export type CandidateCreatePayload = {
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  location?: string;
  experience_summary?: string;
  education?: string;
  notes?: string;
};

export type JobStatus = "draft" | "open" | "paused" | "closed" | "filled";

export type Client = {
  id: string;
  organization_id: string;
  name: string;
  legal_name?: string | null;
  industry?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  notes?: string | null;
  is_deleted: boolean;
  deleted_at?: string | null;
  assigned_recruiter_ids: string[];
  created_at: string;
  updated_at: string;
};

export type ClientCreatePayload = {
  name: string;
  industry: string;
  email: string;
  legal_name?: string | null;
  website?: string | null;
  phone?: string | null;
  location?: string | null;
  notes?: string | null;
  assigned_recruiter_ids?: string[];
};

export type ClientUpdatePayload = Partial<Omit<ClientCreatePayload, "assigned_recruiter_ids">>;

export type ClientRecruiter = {
  recruiter_id: string;
  assigned_at: string;
  assigned_by: string | null;
  /** Enriched at API time from the profiles table. */
  email: string | null;
  role: string | null;
};

/** Recruiter-eligible user returned by the assignment dropdown endpoint. */
export type RecruiterUser = {
  id: string;
  email: string;
  role: string;
};

export type Job = {
  id: string;
  organization_id: string;
  client_id?: string | null;
  client_name?: string | null;  // Embedded from clients table — avoids separate lookup
  title: string;
  description: string | null;
  status: JobStatus;
  paused_reason?: string | null;
  location?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  salary_currency?: string | null;
  experience_min_years?: number | null;
  experience_max_years?: number | null;
  employment_type?: string | null;
  urgency?: string | null;
  required_skills?: string[];
  preferred_skills?: string[];
  key_responsibilities?: string[];
  raw_jd_text?: string | null;
  parsing_source?: string | null;
  parsing_status?: string | null;
  /** Original JD binary stored server-side (not derived from parsed text). */
  jd_file_name?: string | null;
  jd_original_available?: boolean;
  /** Async ATS / match pipeline: created | enriching | ready | failed */
  enrichment_status?: string | null;
  created_by?: string | null;
  filled_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type JobMetrics = {
  job_id: string;
  vendor_count: number;
  candidate_count: number;
};

export type JobMatchEntry = {
  rank: number;
  candidate_id: string;
  candidate_name?: string | null;
  /** Hybrid score when AI enrichment applied (else equals deterministic). */
  fit_score: number;
  deterministic_match_score?: number | null;
  semantic_match_score?: number | null;
  ai_enrichment_status?: string | null;
  ats_pipeline_status?: string | null;
  enrichment_started_at?: string | null;
  deterministic_completed_at?: string | null;
  semantic_completed_at?: string | null;
  enrichment_error?: string | null;
  recruiter_summary?: string | null;
  confidence_reasoning?: string | null;
  semantic_skill_matches?: string[];
  transferable_skills?: string[];
  inferred_strengths?: string[];
  inferred_gaps?: string[];
  category_scores: {
    required_skills: number;
    preferred_skills: number;
    experience: number;
    title: number;
    education: number;
    // v2 weight categories
    communication?: number | null;
    culture?: number | null;
    breadth?: number | null;
    hybrid?: {
      deterministic_score?: number;
      semantic_score?: number | null;
      final_score?: number;
      weights?: { deterministic?: number; semantic?: number };
    };
    // v2 debug transparency
    skill_match_log?: Array<{
      jd_skill: string;
      match_type: "exact" | "synonym" | "category" | "missing";
      candidate_skill?: string | null;
      section?: "required" | "preferred";
    }> | null;
    score_explanation?: string | null;
  };
  already_submitted: boolean;
  matched_skills: string[];
  missing_skills: string[];
  recommendation: string;
  confidence_score?: number | null;
  /** When this candidate–job match was last scored (ISO). */
  evaluated_at?: string | null;
};

export type JobMatchesResponse = {
  job_id: string;
  matches: JobMatchEntry[];
  total_count: number;
  generated_at: string;
  limit: number;
  offset: number;
};

export type CandidateMatchEntry = {
  job_id: string;
  job_title?: string | null;
  fit_score: number;
  deterministic_match_score?: number | null;
  semantic_match_score?: number | null;
  ai_enrichment_status?: string | null;
  ats_pipeline_status?: string | null;
  enrichment_started_at?: string | null;
  deterministic_completed_at?: string | null;
  semantic_completed_at?: string | null;
  enrichment_error?: string | null;
  recruiter_summary?: string | null;
  confidence_reasoning?: string | null;
  semantic_skill_matches?: string[];
  transferable_skills?: string[];
  inferred_strengths?: string[];
  inferred_gaps?: string[];
  category_scores: {
    required_skills: number;
    preferred_skills: number;
    experience: number;
    title: number;
    education: number;
    // v2 weight categories
    communication?: number | null;
    culture?: number | null;
    breadth?: number | null;
    hybrid?: {
      deterministic_score?: number;
      semantic_score?: number | null;
      final_score?: number;
      weights?: { deterministic?: number; semantic?: number };
    };
    // v2 debug transparency
    skill_match_log?: Array<{
      jd_skill: string;
      match_type: "exact" | "synonym" | "category" | "missing";
      candidate_skill?: string | null;
      section?: "required" | "preferred";
    }> | null;
    score_explanation?: string | null;
  };
  matched_skills: string[];
  missing_skills: string[];
  recommendation: string;
  confidence_score?: number | null;
  evaluated_at?: string | null;
};

export type CandidateMatchesResponse = {
  candidate_id: string;
  matches: CandidateMatchEntry[];
  total_count: number;
  limit: number;
  offset: number;
  pipeline_job_count?: number;
  /** NO_PIPELINE_JOBS | NO_SCORE_ROWS_YET when matches are empty */
  ats_hint?: string | null;
};

export type AtsPairStatusResponse = {
  candidate_id: string;
  job_id: string;
  processing_state: string;
  progress: number;
  last_updated?: string | null;
  deterministic_score?: number | null;
  semantic_score?: number | null;
  final_score?: number | null;
  semantic_completion_status?: string | null;
  enrichment_error?: string | null;
  enqueue_delay_ms?: number | null;
};

export type PipelineStage = "applied" | "ai_interview" | "interview" | "offer" | "placed" | "rejected";
export type PipelineStatus = "active" | "on_hold" | "withdrawn" | "closed";

export type Pipeline = {
  id: string;
  organization_id: string;
  candidate_id: string;
  job_id: string;
  stage: PipelineStage;
  status: PipelineStatus;
  notes: string | null;
  /** Set when the stage was last changed via transition_stage (PIPE-004). Null for pre-migration rows. */
  stage_updated_at: string | null;
  /** Set when the status was last changed via change_pipeline_status (PIPE-003). */
  status_changed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Denormalized job + client context — populated on paginated list responses only. */
  job_title?: string | null;
  client_id?: string | null;
  client_name?: string | null;
};

/** PIPE-004: Metadata returned in paginated pipeline list responses. */
export type PipelineListMeta = {
  total: number;
  limit: number;
  offset: number;
  stage_counts: Partial<Record<PipelineStage, number>>;
};

/** PIPE-004: Paginated pipeline list with metadata. */
export type PipelineListResponse = {
  data: Pipeline[];
  meta: PipelineListMeta;
};

/** One row in the pipeline stage-transition audit log (PIPE-002). */
export type PipelineStageHistory = {
  id: string;
  pipeline_id: string;
  organization_id: string;
  previous_stage: PipelineStage | null;
  new_stage: PipelineStage;
  actor_user_id: string | null;
  reason: string | null;
  transitioned_at: string;
  created_at: string;
};

/** One row in the pipeline status-change audit log (PIPE-003). */
export type PipelineStatusHistory = {
  id: string;
  pipeline_id: string;
  organization_id: string;
  previous_status: PipelineStatus | null;
  new_status: PipelineStatus;
  actor_user_id: string | null;
  reason: string | null;
  changed_at: string;
  created_at: string;
};

/** PIPE-003: Payload for changing pipeline status. */
export type PipelineStatusChangePayload = {
  status: PipelineStatus;
  reason?: string;
};

/** PIPE-003: Payload for the withdraw endpoint. */
export type WithdrawPipelinePayload = {
  reason: string;
};

// ── PIPE-005: Submission Tracking ────────────────────────────────────

export type SubmissionOutcome = "pending" | "accepted" | "rejected";
export type VendorSubmissionStatus = "submitted" | "under_review" | "accepted" | "rejected";
export type JobSubmissionStatus = "pending" | "shortlisted" | "rejected" | "interviewing" | "offered" | "hired";

/** Full submission record (recruiter/admin view). */
export type JobSubmission = {
  id: string;
  job_id: string;
  candidate_id: string;
  submission_status: JobSubmissionStatus;
  submitted_at: string;
  submitted_by: string;
  notes: string | null;
  vendor_id: string | null;
  outcome: SubmissionOutcome;
  client_feedback: string | null;
  vendor_status: VendorSubmissionStatus | null;
};

/** Vendor-facing submission row — no cross-vendor data. */
export type VendorSubmission = {
  id: string;
  job_id: string;
  candidate_id: string;
  submitted_at: string;
  outcome: SubmissionOutcome;
  vendor_status: VendorSubmissionStatus;
  /** Only present when outcome is final (accepted/rejected). */
  client_feedback: string | null;
  notes: string | null;
};

/** PIPE-005: Update outcome + optional feedback. */
export type SubmissionOutcomePayload = {
  outcome: SubmissionOutcome;
  client_feedback?: string;
};

/** PIPE-005: Update feedback only. */
export type ClientFeedbackPayload = {
  client_feedback: string;
};

// ── Interview domain ──────────────────────────────────────────────────

export type InterviewStatus =
  | "scheduled"
  | "pending_panel"
  | "panel_confirmed"
  | "in_progress"
  | "confirmed"
  | "completed"
  | "cancelled"
  | "no_show"
  | "rescheduled"
  | "feedback_pending"
  | "feedback_submitted";

export type InterviewType =
  | "hr"
  | "technical"
  | "managerial"
  | "final"
  | "ai_screening";

export type MeetingType = "virtual" | "in_person" | "phone" | "hybrid";

export type ParticipantRole = "lead" | "panel" | "observer" | "hiring_manager";
export type ParticipantStatus = "invited" | "accepted" | "declined";

export type FeedbackRecommendation =
  | "strong_yes"
  | "yes"
  | "neutral"
  | "no"
  | "strong_no";

export type AISummaryRecommendation =
  | "strongly_recommend"
  | "recommend"
  | "neutral"
  | "do_not_recommend";

export type AISummaryPayload = {
  key_strengths: string[];
  concerns: string[];
  overall_assessment: string;
  recommendation: AISummaryRecommendation;
  reasoning: string;
  _fallback?: boolean;
  error?: string;
};

export type AISummaryResponse = {
  interview_id: string;
  ai_summary: AISummaryPayload | { error: string } | null;
  ai_summary_generated_at: string | null;
  ai_summary_provider: string | null;
  ai_summary_edited: boolean;
};

export type AISummaryUpdatePayload = {
  key_strengths?: string[];
  concerns?: string[];
  overall_assessment?: string;
  recommendation?: AISummaryRecommendation;
  reasoning?: string;
};

export type Interview = {
  id: string;
  organization_id: string;
  pipeline_id: string;
  candidate_id: string | null;
  job_id: string | null;
  interview_type: InterviewType | null;
  meeting_type: MeetingType | null;
  scheduled_at: string;
  duration_minutes: number | null;
  meeting_link: string | null;
  meeting_provider: string | null;
  location: string | null;
  status: InterviewStatus;
  interviewer_name: string | null;
  notes: string | null;
  created_by: string | null;
  started_at: string | null;
  ended_at: string | null;
  // AI-004
  ai_summary: AISummaryPayload | { error: string } | null;
  ai_summary_generated_at: string | null;
  ai_summary_provider: string | null;
  ai_summary_edited: boolean;
  created_at: string;
  updated_at: string;
};

export type QueueInterview = Interview & {
  candidate_first_name: string | null;
  candidate_last_name: string | null;
  job_title: string | null;
  participant_count: number;
};

export type InterviewParticipant = {
  id: string;
  interview_id: string;
  user_id: string;
  participant_role: ParticipantRole;
  status: ParticipantStatus;
  joined_at: string | null;
  created_at: string;
};

export type InterviewCreatePayload = {
  pipeline_id: string;
  interview_type?: InterviewType | null;
  meeting_type?: MeetingType | null;
  scheduled_at: string;
  duration_minutes?: number | null;
  meeting_link?: string | null;
  location?: string | null;
  status?: InterviewStatus;
  interviewer_name?: string | null;
  notes?: string | null;
};

export type InterviewUpdatePayload = Partial<Omit<InterviewCreatePayload, "pipeline_id">>;

export type InterviewFeedback = {
  id: string;
  interview_id: string;
  reviewer_id: string;
  technical_score: number | null;
  communication_score: number | null;
  problem_solving_score: number | null;
  culture_fit_score: number | null;
  system_design_score: number | null;
  leadership_score: number | null;
  rating: number | null;
  recommendation: FeedbackRecommendation | null;
  strengths: string | null;
  weaknesses: string | null;
  notes: string | null;
  submitted_at: string | null;
  created_at: string;
};

export type InterviewFeedbackPayload = {
  technical_score?: number | null;
  communication_score?: number | null;
  problem_solving_score?: number | null;
  culture_fit_score?: number | null;
  system_design_score?: number | null;
  leadership_score?: number | null;
  rating?: number | null;
  recommendation?: FeedbackRecommendation | null;
  strengths?: string | null;
  weaknesses?: string | null;
  notes?: string | null;
};

export type InterviewNote = {
  id: string;
  interview_id: string;
  interviewer_id: string;
  section: string | null;
  content: string;
  autosaved_at: string | null;
  finalized: boolean;
  created_at: string;
  updated_at: string;
};

// ── SCHED-006: Interview reminders ────────────────────────────────────────

export type ReminderStatus = "scheduled" | "processing" | "sent" | "skipped" | "failed" | "cancelled";

export type InterviewReminder = {
  id: string;
  interview_id: string;
  reminder_type: "24h" | "1h";
  recipient_type: "candidate" | "interviewer";
  recipient_email: string;
  scheduled_for: string;
  status: ReminderStatus;
  sent_at: string | null;
  failure_reason: string | null;
  created_at: string;
};

export type CandidateWorkspaceInfo = {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  location: string | null;
  experience_summary: string | null;
  education: string | null;
  notes: string | null;
};

export type FeedbackSummary = {
  count: number;
  avg_technical: number | null;
  avg_communication: number | null;
  avg_problem_solving: number | null;
  avg_culture_fit: number | null;
  avg_system_design: number | null;
  avg_leadership: number | null;
  avg_overall: number | null;
  recommendations: Record<string, number>;
};

export type WorkspaceData = {
  interview: Interview;
  candidate: CandidateWorkspaceInfo | null;
  job_title: string | null;
  participants: InterviewParticipant[];
  notes: InterviewNote[];
  feedback_summary: FeedbackSummary | null;
};

export type InterviewerProfile = {
  id: string;
  organization_id: string;
  user_id: string;
  title: string | null;
  department: string | null;
  is_active: boolean;
  max_interviews_per_day: number | null;
  timezone: string | null;
  bio: string | null;
  skills: string[];
  created_at: string;
};

// ── AI Screening domain ───────────────────────────────────────────────

export type ScreeningStatus =
  | "pending"
  | "generating_questions"
  | "questions_ready"
  | "evaluating"
  | "completed"
  | "failed"
  | "cancelled";

export type ScreeningType =
  | "technical"
  | "hr"
  | "communication"
  | "leadership"
  | "behavioral"
  | "role_fit";

export type ScreeningRecommendation =
  | "strong_proceed"
  | "proceed"
  | "needs_manual_review"
  | "weak_match"
  | "reject_recommendation";

export type RecruiterDecision = "advance" | "reject" | "hold" | "needs_review";

export type AIScreening = {
  id: string;
  organization_id: string;
  candidate_id: string;
  job_id: string | null;
  created_by: string | null;
  status: ScreeningStatus;
  screening_type: ScreeningType;
  ai_model: string | null;
  overall_score: number | null;
  communication_score: number | null;
  technical_score: number | null;
  confidence_score: number | null;
  recommendation: ScreeningRecommendation | null;
  ai_summary: string | null;
  recruiter_summary: string | null;
  recruiter_decision: RecruiterDecision | null;
  recruiter_notes: string | null;
  prompt_tokens_used: number | null;
  completion_tokens_used: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type AIScreeningQuestion = {
  id: string;
  screening_id: string;
  category: string;
  difficulty: "easy" | "medium" | "hard";
  position: number;
  question_text: string;
  expected_signals: {
    key_concepts?: string[];
    red_flags?: string[];
    ideal_depth?: string;
  } | null;
  generated_by_ai: boolean;
  created_at: string;
};

export type AIScreeningAnswer = {
  id: string;
  screening_id: string;
  question_id: string;
  answer_text: string;
  recruiter_entered: boolean;
  source_type: "manual" | "uploaded" | "link_response";
  created_at: string;
  updated_at: string;
};

export type AIScreeningEvaluation = {
  id: string;
  screening_id: string;
  question_id: string;
  ai_score: number | null;
  communication_rating: number | null;
  technical_rating: number | null;
  strengths: string[] | null;
  concerns: string[] | null;
  reasoning: string | null;
  follow_up_suggestion: string | null;
  confidence: number | null;
  created_at: string;
  updated_at: string;
};

export type AIScreeningDetail = AIScreening & {
  questions: AIScreeningQuestion[];
  answers: AIScreeningAnswer[];
  evaluations: AIScreeningEvaluation[];
  candidate_name: string | null;
  candidate_email: string | null;
  job_title: string | null;
  ats_score: number | null;
  ats_recommendation: string | null;
};

export type AIScreeningListItem = {
  id: string;
  candidate_id: string;
  job_id: string | null;
  status: ScreeningStatus;
  screening_type: ScreeningType;
  overall_score: number | null;
  recommendation: ScreeningRecommendation | null;
  recruiter_decision: RecruiterDecision | null;
  created_at: string;
  completed_at: string | null;
  candidate_name: string | null;
  candidate_email: string | null;
  job_title: string | null;
};

export type AIScreeningCreatePayload = {
  candidate_id: string;
  job_id?: string | null;
  screening_type?: ScreeningType;
};

export type AnswerUpsertPayload = {
  answer_text: string;
  source_type?: "manual" | "uploaded" | "link_response";
};

export type RecruiterDecisionPayload = {
  decision: RecruiterDecision;
  notes?: string | null;
};

export type StartScreeningPayload = {
  candidate_id: string;
  job_id?: string | null;
  screening_type?: ScreeningType;
  move_pipeline_stage?: boolean;
  pipeline_id?: string | null;
};

// ── Interview Transcript domain ───────────────────────────────────────────────

export type TranscriptSpeaker = "interviewer" | "candidate" | "unknown";

export type TranscriptSegment = {
  id: string;
  session_id: string;
  interview_id: string;
  speaker: TranscriptSpeaker;
  content: string;
  offset_ms: number | null;
  duration_ms: number | null;
  source: string;
  created_at: string;
};

export type TranscriptSegmentPayload = {
  speaker?: TranscriptSpeaker;
  content: string;
  offset_ms?: number | null;
  duration_ms?: number | null;
  source?: string;
};

export type CopilotWsEventType =
  | "transcript_added"
  | "session_updated"
  | "error"
  | "ping"
  | "pong";

export type CopilotWsEvent = {
  type: CopilotWsEventType;
  data: Record<string, unknown>;
  ts: string;
};

// ── PIPE-007: Pipeline Analytics ─────────────────────────────────────────────

export type StageFunnelEntry = {
  stage: string;
  label: string;
  entered: number;
  advanced: number;
  rejected: number;
  still_in_stage: number;
  /** Percentage of entered that advanced (0–100). */
  conversion_rate: number;
  /** Percentage of entered that were rejected directly (0–100). */
  rejection_rate: number;
};

export type StageDurationEntry = {
  stage: string;
  label: string;
  avg_days: number;
  median_days: number | null;
  sample_count: number;
  /** True when avg_days is >25% above the overall mean across all stages. */
  is_slow: boolean;
};

export type DropOffEntry = {
  stage: string;
  label: string;
  rejected_count: number;
  drop_off_rate: number;
  /** True for the stage with the highest drop-off rate. */
  is_bottleneck: boolean;
  rank: number;
};

export type PipelineAnalytics = {
  organization_id: string;
  job_id: string | null;
  date_range_start: string | null;
  date_range_end: string | null;
  total_pipelines: number;
  total_placed: number;
  total_rejected: number;
  overall_placement_rate: number;
  funnel: StageFunnelEntry[];
  stage_durations: StageDurationEntry[];
  drop_off: DropOffEntry[];
  generated_at: string;
};

export type PipelineAnalyticsParams = {
  jobId?: string;
  startDate?: string;
  endDate?: string;
};

// ── PIPE-008: Offer Management ─────────────────────────────────────────────

export type OfferResponseStatus = "pending" | "accepted" | "declined" | "negotiating";

export type OfferEventType =
  | "offer_created"
  | "offer_revised"
  | "response_updated"
  | "expiry_alert_sent"
  | "offer_expired";

/** Full offer record (PIPE-008). */
export type PipelineOffer = {
  id: string;
  organization_id: string;
  pipeline_id: string;
  candidate_id: string;
  job_id: string;
  offered_salary: string; // Decimal serialized as string
  currency: string;       // ISO 4217, e.g. "USD"
  offer_date: string;     // YYYY-MM-DD
  expiry_date: string;    // YYYY-MM-DD
  offer_response: OfferResponseStatus;
  decline_reason: string | null;
  previous_stage: string | null;
  expiry_alert_sent: boolean;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Computed by service layer:
  days_until_expiry: number | null;
  is_expired: boolean;
};

/** One event in the offer audit log. */
export type PipelineOfferEvent = {
  id: string;
  organization_id: string;
  pipeline_id: string;
  offer_id: string;
  event_type: OfferEventType;
  actor_user_id: string | null;
  previous_response: string | null;
  new_response: string | null;
  notes: string | null;
  created_at: string;
};

/** Payload to create a new offer. */
export type OfferCreatePayload = {
  offered_salary: number;
  currency: string;
  offer_date: string;  // YYYY-MM-DD
  expiry_date: string; // YYYY-MM-DD
  notes?: string;
};

/** Payload to revise an existing offer. */
export type OfferRevisePayload = {
  offered_salary?: number;
  currency?: string;
  expiry_date?: string;
  notes?: string;
};

/** Payload to submit a candidate's response. */
export type OfferRespondPayload = {
  response: OfferResponseStatus;
  decline_reason?: string;
  revert_to_previous_stage?: boolean;
};

// ── AI-003: Interview question generation ─────────────────────────────────────

export type InterviewQuestionCategory = "technical" | "behavioural" | "situational";

export type InterviewQuestion = {
  category: InterviewQuestionCategory;
  question_text: string;
  follow_up_probe: string | null;
  ideal_answer_traits: string[];
};

export type GenerateQuestionsRequest = {
  job_title: string;
  job_description: string;
  required_skills: string[];
};

export type GenerateQuestionsResponse = {
  questions: InterviewQuestion[];
  questions_by_category: Record<InterviewQuestionCategory, number>;
  provider_used: string;
  fallback_used: boolean;
  duration_ms: number;
};

// Analytics Dashboard
export interface JobStatusCount { status: string; count: number; }
export interface ClientJobCount { client_name: string; count: number; }
export interface RecentJobDto { id: string; title: string; client_name: string; status: string; created_at: string; }
export interface OpenJobsResponse { total_active: number; by_status: JobStatusCount[]; by_client: ClientJobCount[]; recent_jobs: RecentJobDto[]; }

export interface StageCount { stage: string; count: number; }
export interface SourceCount { source: string; count: number; }
export interface PipelineOverviewResponse { total_candidates: number; by_stage: StageCount[]; by_source: SourceCount[]; }

export interface RecruiterActivityMetric { recruiter_name: string; submissions: number; interviews: number; placements: number; }
export interface RecruiterActivityResponse { total_submissions: number; total_interviews: number; total_placements: number; by_recruiter: RecruiterActivityMetric[]; }
export interface TimeToShortlistResponse { average_days: number; fastest_days: number; slowest_days: number; }
export interface PlacementMetric { name: string; count: number; }
export interface PlacementTrackingResponse { total_placements: number; by_recruiter: PlacementMetric[]; by_client: PlacementMetric[]; }

export interface DashboardSummaryResponse {
  open_jobs: OpenJobsResponse;
  pipeline: PipelineOverviewResponse;
  recruiter_activity: RecruiterActivityResponse;
  time_to_shortlist: TimeToShortlistResponse;
  placement_tracking: PlacementTrackingResponse;
}

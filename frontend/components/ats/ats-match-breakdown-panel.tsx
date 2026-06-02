"use client";

import { ATSRecommendationBadge } from "@/components/ats/ats-recommendation-badge";
import { ATSScoreBadge } from "@/components/ats/ats-score-badge";

type SkillMatchLogEntry = {
  jd_skill: string;
  match_type: "exact" | "synonym" | "category" | "missing";
  candidate_skill?: string | null;
  section?: "required" | "preferred";
};

type MatchBreakdownData = {
  fit_score?: number | null;
  deterministic_match_score?: number | null;
  semantic_match_score?: number | null;
  ai_enrichment_status?: string | null;
  ats_pipeline_status?: string | null;
  enrichment_error?: string | null;
  deterministic_completed_at?: string | null;
  semantic_completed_at?: string | null;
  recommendation?: string | null;
  confidence_score?: number | null;
  confidence_reasoning?: string | null;
  recruiter_summary?: string | null;
  semantic_skill_matches?: string[];
  transferable_skills?: string[];
  inferred_strengths?: string[];
  inferred_gaps?: string[];
  category_scores?: {
    required_skills?: number;
    preferred_skills?: number;
    experience?: number;
    title?: number;
    education?: number;
    // v2 categories
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
    skill_match_log?: SkillMatchLogEntry[] | null;
    score_explanation?: string | null;
  } | null;
  matched_skills?: string[];
  missing_skills?: string[];
  evaluated_at?: string | null;
};

type ATSMatchBreakdownPanelProps = {
  data?: MatchBreakdownData | null;
  title?: string;
  isLoading?: boolean;
};

function SkillTags({ values, tone }: { values?: string[]; tone: "match" | "missing" | "info" }) {
  if (!values?.length) return <p className="text-xs text-slate-500">-</p>;
  const cls =
    tone === "match"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : tone === "missing"
        ? "bg-rose-50 text-rose-700 border-rose-200"
        : "bg-indigo-50 text-indigo-800 border-indigo-200";
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.slice(0, 12).map((skill) => (
        <span key={skill} className={`rounded-full border px-2 py-0.5 text-[11px] ${cls}`}>
          {skill}
        </span>
      ))}
    </div>
  );
}

function BulletList({ items }: { items?: string[] }) {
  if (!items?.length) return <p className="text-xs text-slate-500">-</p>;
  return (
    <ul className="list-disc space-y-1 pl-4 text-xs text-slate-700">
      {items.slice(0, 8).map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

function ProgressRow({ label, value }: { label: string; value?: number }) {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-600">{label}</span>
        <span className="font-medium text-slate-800">{pct}%</span>
      </div>
      <div className="h-1.5 rounded bg-slate-100">
        <div className="h-1.5 rounded bg-indigo-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function ATSMatchBreakdownPanel({ data, title = "ATS Breakdown", isLoading }: ATSMatchBreakdownPanelProps) {
  if (isLoading) {
    return (
      <div className="rounded-lg border border-slate-200 p-4 text-sm text-slate-500">
        Loading ATS breakdown…
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-lg border border-slate-200 p-4 text-sm text-slate-500">
        No ATS match row for this job yet. Submit the candidate or run Rescore ATS.
      </div>
    );
  }

  const hybrid = data.category_scores?.hybrid;
  const showHybrid =
    hybrid &&
    typeof hybrid.deterministic_score === "number" &&
    typeof hybrid.final_score === "number";

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-slate-900">{title}</p>
        <ATSScoreBadge score={data.fit_score} />
        <ATSRecommendationBadge recommendation={data.recommendation} awaitingMatch={false} />
        {data.ai_enrichment_status === "complete" ? (
          <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700">
            AI enriched
          </span>
        ) : data.ai_enrichment_status === "failed" ? (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
            AI unavailable
          </span>
        ) : data.ai_enrichment_status === "skipped" ? (
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
            AI skipped
          </span>
        ) : data.ats_pipeline_status === "ai_enriching" ||
            (data.ats_pipeline_status === "deterministic_complete" &&
              (data.ai_enrichment_status === "pending" || data.ai_enrichment_status === "enriching")) ? (
          <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-800">
            AI enrichment running…
          </span>
        ) : null}
      </div>

      {data.enrichment_error ? (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50/90 px-3 py-2 text-xs text-amber-900">
          <p className="font-semibold text-amber-950">Semantic enrichment</p>
          <p className="mt-1 leading-relaxed">{data.enrichment_error}</p>
          <p className="mt-1 text-[11px] text-amber-800">Baseline deterministic score above still applies.</p>
        </div>
      ) : null}

      {showHybrid ? (
        <div className="mb-4 rounded-md border border-slate-100 bg-slate-50/80 px-3 py-2 text-xs text-slate-600">
          <span className="font-medium text-slate-700">Hybrid score: </span>
          {Math.round((hybrid!.weights?.deterministic ?? 0.7) * 100)}% deterministic ({hybrid!.deterministic_score}) +{" "}
          {hybrid!.semantic_score != null ? (
            <>
              {Math.round((hybrid!.weights?.semantic ?? 0.3) * 100)}% semantic ({hybrid!.semantic_score}) →{" "}
            </>
          ) : (
            <>semantic layer skipped → </>
          )}
          <span className="font-semibold text-slate-900">{hybrid!.final_score}</span>
        </div>
      ) : null}

      {data.recruiter_summary ? (
        <div className="mb-4 rounded-md border border-violet-100 bg-violet-50/50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-800">Recruiter summary</p>
          <p className="mt-1 text-sm leading-relaxed text-slate-800">{data.recruiter_summary}</p>
          {data.confidence_reasoning ? (
            <p className="mt-2 text-xs italic text-slate-600">{data.confidence_reasoning}</p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <ProgressRow label="Required Skills (35%)" value={data.category_scores?.required_skills} />
        <ProgressRow label="Preferred Skills (15%)" value={data.category_scores?.preferred_skills} />
        <ProgressRow label="Experience (20%)" value={data.category_scores?.experience} />
        <ProgressRow label="Title Alignment (10%)" value={data.category_scores?.title} />
        <ProgressRow label="Education (5%)" value={data.category_scores?.education} />
        {data.category_scores?.communication != null && (
          <ProgressRow label="Communication (5%)" value={data.category_scores.communication} />
        )}
        {data.category_scores?.culture != null && (
          <ProgressRow label="Culture & Practices (5%)" value={data.category_scores.culture} />
        )}
        {data.category_scores?.breadth != null && (
          <ProgressRow label="Skill Breadth (5%)" value={data.category_scores.breadth} />
        )}
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Matched Skills</p>
          <SkillTags values={data.matched_skills} tone="match" />
        </div>
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Missing Skills</p>
          <SkillTags values={data.missing_skills} tone="missing" />
        </div>
        {(data.semantic_skill_matches?.length ?? 0) > 0 ? (
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Semantic skill matches</p>
            <SkillTags values={data.semantic_skill_matches} tone="info" />
          </div>
        ) : null}
        {(data.transferable_skills?.length ?? 0) > 0 ? (
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Transferable skills</p>
            <SkillTags values={data.transferable_skills} tone="info" />
          </div>
        ) : null}
        {(data.inferred_strengths?.length ?? 0) > 0 ? (
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Inferred strengths</p>
            <BulletList items={data.inferred_strengths} />
          </div>
        ) : null}
        {(data.inferred_gaps?.length ?? 0) > 0 ? (
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Inferred gaps</p>
            <BulletList items={data.inferred_gaps} />
          </div>
        ) : null}
      </div>

      {/* v2 ATS Debug Transparency Panel */}
      {(data.category_scores?.skill_match_log?.length ?? 0) > 0 && (
        <details className="mt-4 rounded-md border border-slate-200">
          <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:bg-slate-50">
            Skill Match Log (how each JD skill was matched)
          </summary>
          <div className="divide-y divide-slate-100 px-3 pb-2">
            {data.category_scores!.skill_match_log!.map((entry, i) => (
              <div key={i} className="flex items-center gap-2 py-1.5 text-xs">
                <span
                  className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${
                    entry.match_type === "exact"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : entry.match_type === "synonym"
                        ? "border-sky-200 bg-sky-50 text-sky-700"
                        : entry.match_type === "category"
                          ? "border-amber-200 bg-amber-50 text-amber-700"
                          : "border-rose-200 bg-rose-50 text-rose-700"
                  }`}
                >
                  {entry.match_type}
                </span>
                <span className="text-slate-700">{entry.jd_skill}</span>
                {entry.candidate_skill && entry.candidate_skill !== entry.jd_skill && (
                  <span className="text-slate-400">via &ldquo;{entry.candidate_skill}&rdquo;</span>
                )}
                <span className="ml-auto shrink-0 text-[10px] text-slate-400">
                  {entry.section === "preferred" ? "preferred" : "required"}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
      {data.category_scores?.score_explanation && (
        <div className="mt-2 rounded-md bg-slate-50 px-3 py-2 font-mono text-[10px] text-slate-500">
          {data.category_scores.score_explanation}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-500">
        <span>
          Confidence:{" "}
          {typeof data.confidence_score === "number" ? `${Math.round(data.confidence_score * 100)}%` : "-"}
        </span>
        <span>Evaluated: {data.evaluated_at ? new Date(data.evaluated_at).toLocaleString() : "-"}</span>
        {data.semantic_completed_at ? (
          <span>Last AI enrichment: {new Date(data.semantic_completed_at).toLocaleString()}</span>
        ) : null}
        {data.deterministic_completed_at ? (
          <span>Baseline scored: {new Date(data.deterministic_completed_at).toLocaleString()}</span>
        ) : null}
      </div>
    </div>
  );
}

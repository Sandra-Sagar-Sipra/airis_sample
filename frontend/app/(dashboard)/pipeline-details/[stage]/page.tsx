"use client";

import { useEffect, useState, use } from "react";
import { getPipelinesWithMeta } from "@/lib/api/pipeline";
import { getCandidatesByIds } from "@/lib/api/candidates";
import type { Pipeline, PipelineStage } from "@/lib/api/types";
import { Loader2, ArrowLeft, Building2, Briefcase, Calendar, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

function getRelativeTimeString(dateString: string | null): string {
  if (!dateString) return "";
  const timeMs = new Date(dateString).getTime();
  const deltaSeconds = Math.round((timeMs - Date.now()) / 1000);
  const cutoffs = [60, 3600, 86400, 86400 * 7, 86400 * 30, 86400 * 365, Infinity];
  const units: Intl.RelativeTimeFormatUnit[] = ["second", "minute", "hour", "day", "week", "month", "year"];
  const unitIndex = cutoffs.findIndex(cutoff => cutoff > Math.abs(deltaSeconds));
  const divider = unitIndex ? cutoffs[unitIndex - 1] : 1;
  const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  return rtf.format(Math.floor(deltaSeconds / divider), units[unitIndex]);
}

const stageTitles: Record<string, string> = {
  applied: "Applied",
  sourced: "Sourced",
  screening: "Screening",
  ai_screening: "AI Screening",
  interview: "Interview",
  assessment: "Assessment",
  offer: "Offer",
  placed: "Placed",
  rejected: "Rejected",
  active_pipeline: "Active Pipeline Candidates",
  placements: "All Placements",
};

export default function PipelineDetailsPage({
  params,
}: {
  params: Promise<{ stage: string }>;
}) {
  const router = useRouter();
  const resolvedParams = use(params);
  const stage = resolvedParams.stage as PipelineStage | "active_pipeline" | "placements";
  
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [candidatesMap, setCandidatesMap] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredPipelines = pipelines.filter((p) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const cand = candidatesMap[p.candidate_id];
    const candName = cand ? `${cand.first_name} ${cand.last_name}`.toLowerCase() : "";
    const candRole = (cand?.role || cand?.headline || p.job_title || "").toLowerCase();
    const clientName = (p.client_name || "").toLowerCase();
    
    return candName.includes(q) || candRole.includes(q) || clientName.includes(q);
  });

  useEffect(() => {
    if (!stage) return;
    
    setLoading(true);
    const fetchParams: any = { limit: 100 };
    if (stage === "active_pipeline") {
      fetchParams.status = "active";
    } else if (stage === "placements") {
      fetchParams.stage = "placed";
    } else {
      fetchParams.stage = stage;
      fetchParams.status = "active";
    }
    
    getPipelinesWithMeta(fetchParams)
      .then((res) => {
        setPipelines(res.data);
        setLoading(false);
        if (res.data.length > 0) {
          const candidateIds = res.data.map((p: Pipeline) => p.candidate_id);
          getCandidatesByIds(candidateIds).then((cands) => {
            const map: Record<string, any> = {};
            cands.forEach((c: any) => { map[c.id] = c; });
            setCandidatesMap(map);
          }).catch((err) => {
            console.error("Failed to fetch candidate details", err);
          });
        }
      })
      .catch(() => {
        setPipelines([]);
        setLoading(false);
      });
  }, [stage]);

  const title = stageTitles[stage] || stage;

  return (
    <section className="min-w-0 space-y-6 pb-12 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
        <div className="flex items-center gap-4">
          <button 
            onClick={() => router.back()}
            className="p-2 rounded-full hover:bg-slate-100 text-slate-500 hover:text-slate-900 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 flex items-center gap-3">
              {title}
              {!loading && (
                <span className="text-sm font-medium text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded-full border border-slate-200">
                  {pipelines.length} {pipelines.length === 1 ? 'candidate' : 'candidates'}
                </span>
              )}
            </h1>
            <p className="text-sm text-slate-500 mt-1">Detailed view of candidates in this stage</p>
          </div>
        </div>

        {/* Search */}
        {!loading && pipelines.length > 0 && (
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text" 
              placeholder="Search candidates, roles, clients..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 transition-all shadow-sm"
            />
          </div>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex flex-col justify-center items-center h-64 gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-[#FF5A1F]" />
          <p className="text-sm text-slate-500 font-medium">Loading candidates...</p>
        </div>
      ) : pipelines.length > 0 ? (
        <div className="bg-white border border-slate-200 rounded-[24px] shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-600">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs uppercase font-semibold text-slate-500 tracking-wider">
                <tr>
                  <th className="px-6 py-4 rounded-tl-[24px]">Candidate</th>
                  <th className="px-6 py-4">Job & Client</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4">Joined / Updated</th>
                  <th className="px-6 py-4 text-right rounded-tr-[24px] w-[1%] whitespace-nowrap">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredPipelines.map((p) => {
                  const cand = candidatesMap[p.candidate_id];
                  const candName = cand ? `${cand.first_name} ${cand.last_name}` : `Candidate ${p.candidate_id.substring(0, 8)}`;
                  const candInitials = cand ? `${cand.first_name?.[0] || ""}${cand.last_name?.[0] || ""}`.toUpperCase() : "C";
                  const candRole = cand?.role || cand?.headline || p.job_title || "Unknown Role";
                  
                  return (
                    <tr 
                      key={p.id} 
                      onClick={() => router.push(`/candidates/${p.candidate_id}`)} 
                      onMouseEnter={() => router.prefetch(`/candidates/${p.candidate_id}`)}
                      className="group hover:bg-orange-50/50 cursor-pointer transition-colors"
                    >
                      <td className="px-6 py-4 min-w-[200px]">
                        <div className="flex items-center gap-4">
                          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-600 font-bold text-sm group-hover:bg-orange-100 group-hover:text-[#FF5A1F] transition-colors shadow-sm">
                            {candInitials}
                          </div>
                          <div className="min-w-0">
                            <div className="font-bold text-slate-900 group-hover:text-[#FF5A1F] transition-colors truncate">
                              {candName}
                            </div>
                            <div className="text-[13px] text-slate-500 mt-0.5 truncate">
                              {candRole}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 min-w-[200px]">
                        <div className="flex flex-col gap-1.5 text-[13px]">
                          {p.job_title && (
                            <div className="flex items-center gap-2 text-slate-700 font-medium">
                              <Briefcase className="w-3.5 h-3.5 text-slate-400" />
                              <span className="truncate max-w-[200px]">{p.job_title}</span>
                            </div>
                          )}
                          {p.client_name && (
                            <div className="flex items-center gap-2 text-slate-500">
                              <Building2 className="w-3.5 h-3.5 text-slate-400" />
                              <span className="truncate max-w-[200px]">{p.client_name}</span>
                            </div>
                          )}
                          {!p.job_title && !p.client_name && <span className="text-slate-400 italic">No job assigned</span>}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex flex-col gap-1.5 items-start">
                          <span className="inline-flex px-2 py-0.5 bg-orange-50 border border-orange-100 text-[10px] font-bold uppercase tracking-wider text-[#FF5A1F] rounded-md">
                            {stageTitles[p.stage] || p.stage.replace("_", " ")}
                          </span>
                          <span className="inline-flex px-2 py-0.5 bg-slate-50 border border-slate-200 text-[10px] font-bold uppercase tracking-wider text-slate-600 rounded-md">
                            {p.status.replace("_", " ")}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex flex-col gap-1.5 text-[13px]">
                          <div className="flex items-center gap-2 text-slate-700">
                            <Calendar className="w-3.5 h-3.5 text-slate-400" />
                            <span>Joined {new Date(p.created_at).toLocaleDateString()}</span>
                          </div>
                          <div className="text-[11px] text-slate-400 font-medium ml-5.5 pl-5">
                            Updated {getRelativeTimeString(p.stage_updated_at || p.updated_at)}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap w-[1%] text-right">
                        <div className="flex justify-end items-center w-full">
                          <span className="text-[13px] font-bold text-[#FF5A1F] group-hover:text-orange-600 transition-colors flex items-center gap-1">
                            View details <span>&rarr;</span>
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            
            {filteredPipelines.length === 0 && (
              <div className="text-center py-12 flex flex-col items-center bg-slate-50/50">
                <div className="text-slate-500 text-sm">No candidates match your search</div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="text-center py-24 flex flex-col items-center bg-white rounded-3xl border border-dashed border-slate-200 shadow-sm">
          <div className="w-16 h-16 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center mb-4">
            <span className="text-slate-400 font-medium text-xl">0</span>
          </div>
          <div className="text-slate-700 font-bold text-lg">No candidates found</div>
          <div className="text-slate-500 text-sm mt-2 max-w-sm">
            There are no candidates currently in the {title} stage.
          </div>
          <button 
            onClick={() => router.push('/dashboard')}
            className="mt-6 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 transition-colors"
          >
            Back to Dashboard
          </button>
        </div>
      )}
    </section>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  assignRecruiters,
  listClientRecruiters,
  removeRecruiterFromClient,
} from "@/lib/api/clients";
import type { ClientRecruiter, RecruiterUser } from "@/lib/api/types";

// ── Simple inline toast ───────────────────────────────────────────────────────

type Toast = { id: number; type: "success" | "error"; message: string };

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counterRef = useRef(0);

  function push(type: Toast["type"], message: string) {
    const id = ++counterRef.current;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }

  return { toasts, success: (m: string) => push("success", m), error: (m: string) => push("error", m) };
}

// ── Role badge ────────────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: string | null }) {
  if (!role) return null;
  return (
    <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 capitalize">
      {role}
    </span>
  );
}

// ── Searchable dropdown ───────────────────────────────────────────────────────

type DropdownProps = {
  options: RecruiterUser[];
  onSelect: (user: RecruiterUser) => void;
  disabled?: boolean;
};

function RecruiterDropdown({ options, onSelect, disabled }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = options.filter((u) =>
    u.email.toLowerCase().includes(query.toLowerCase())
  );

  if (options.length === 0) return null;

  return (
    <div ref={ref} className="relative flex-1">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-full items-center justify-between rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-500 shadow-sm hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-[#FF5A1F]/30 disabled:opacity-50"
      >
        <span>Search recruiter to add…</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-lg">
          {/* Search input */}
          <div className="border-b border-gray-100 px-2 py-1.5">
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by email…"
              className="w-full rounded-sm px-1 py-0.5 text-sm text-gray-900 placeholder-gray-400 outline-none"
            />
          </div>

          {/* Options list */}
          <ul className="max-h-48 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-xs text-gray-400 italic">No matches found.</li>
            ) : (
              filtered.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-orange-50 hover:text-[#FF5A1F]"
                    onClick={() => {
                      onSelect(u);
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    <span className="flex-1 truncate">{u.email}</span>
                    <RoleBadge role={u.role} />
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Assigned recruiter row ────────────────────────────────────────────────────

type AssignedRowProps = {
  assignment: ClientRecruiter;
  canAssign: boolean;
  onRemove: (recruiterId: string) => void;
  removing: boolean;
};

function AssignedRecruiterRow({ assignment, canAssign, onRemove, removing }: AssignedRowProps) {
  const displayEmail = assignment.email ?? `${assignment.recruiter_id.slice(0, 8)}…`;
  const assignedDate = new Date(assignment.assigned_at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        {/* Avatar initials */}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-100 text-[11px] font-semibold text-[#FF5A1F] uppercase">
          {displayEmail.slice(0, 2)}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-gray-900">{displayEmail}</p>
          <p className="text-xs text-gray-400">
            Assigned {assignedDate}
            {assignment.role && (
              <>
                {" · "}
                <span className="capitalize">{assignment.role}</span>
              </>
            )}
          </p>
        </div>
      </div>

      {canAssign && (
        <button
          type="button"
          disabled={removing}
          onClick={() => onRemove(assignment.recruiter_id)}
          className="ml-3 shrink-0 rounded p-1 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-40"
          aria-label={`Remove ${displayEmail}`}
          title="Remove from client"
        >
          {removing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <X className="h-3.5 w-3.5" />
          )}
        </button>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type Props = {
  clientId: string;
  availableRecruiters: RecruiterUser[];
  /** Whether the current user has clients:assign or clients:update permission. */
  canAssign?: boolean;
};

export function RecruiterAssignmentSelector({
  clientId,
  availableRecruiters,
  canAssign = false,
}: Props) {
  const [assignments, setAssignments] = useState<ClientRecruiter[]>([]);
  const [fetchLoading, setFetchLoading] = useState(true);
  const [assigning, setAssigning] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const { toasts, success, error: showError } = useToasts();

  // Load current assignments
  useEffect(() => {
    setFetchLoading(true);
    listClientRecruiters(clientId)
      .then(setAssignments)
      .catch(() => showError("Failed to load assigned recruiters."))
      .finally(() => setFetchLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  // Recruiters not yet assigned (for dropdown options)
  const assignedIds = new Set(assignments.map((a) => a.recruiter_id));
  const unassigned = availableRecruiters.filter((r) => !assignedIds.has(r.id));

  async function handleAssign(user: RecruiterUser) {
    setAssigning(true);
    try {
      const updated = await assignRecruiters(clientId, [user.id]);
      setAssignments(updated);
      success(`${user.email} assigned successfully.`);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "Failed to assign recruiter.");
    } finally {
      setAssigning(false);
    }
  }

  async function handleRemove(recruiterId: string) {
    setRemovingId(recruiterId);
    const removed = assignments.find((a) => a.recruiter_id === recruiterId);
    // Optimistic update
    setAssignments((prev) => prev.filter((a) => a.recruiter_id !== recruiterId));
    try {
      await removeRecruiterFromClient(clientId, recruiterId);
      success(`${removed?.email ?? "Recruiter"} removed.`);
    } catch (err: unknown) {
      // Rollback on failure
      if (removed) setAssignments((prev) => [...prev, removed]);
      showError(err instanceof Error ? err.message : "Failed to remove recruiter.");
    } finally {
      setRemovingId(null);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="space-y-1.5">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                t.type === "success"
                  ? "bg-green-50 border border-green-200 text-green-700"
                  : "bg-red-50 border border-red-200 text-red-700"
              }`}
            >
              {t.type === "success" ? (
                <Check className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <X className="h-3.5 w-3.5 shrink-0" />
              )}
              {t.message}
            </div>
          ))}
        </div>
      )}

      {/* Assigned recruiter list */}
      {fetchLoading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading assigned recruiters…
        </div>
      ) : assignments.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 py-6 text-center">
          <UserPlus className="mx-auto mb-2 h-6 w-6 text-gray-300" />
          <p className="text-sm font-medium text-gray-400">No recruiters assigned</p>
          {canAssign ? (
            <p className="mt-0.5 text-xs text-gray-400">
              Use the dropdown below to assign a recruiter to this client.
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-gray-400">
              You don&apos;t have permission to manage recruiter assignments.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {assignments.map((a) => (
            <AssignedRecruiterRow
              key={a.recruiter_id}
              assignment={a}
              canAssign={canAssign}
              onRemove={handleRemove}
              removing={removingId === a.recruiter_id}
            />
          ))}
        </div>
      )}

      {/* Assignment controls — only shown to users with assign permission */}
      {canAssign && !fetchLoading && (
        <div className="border-t border-gray-100 pt-3">
          {unassigned.length === 0 ? (
            <p className="text-xs text-gray-400 italic">
              {availableRecruiters.length === 0
                ? "No recruiter-role users found in your organization."
                : "All available recruiters are already assigned to this client."}
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <RecruiterDropdown
                options={unassigned}
                onSelect={handleAssign}
                disabled={assigning}
              />
              {assigning && (
                <div className="flex items-center gap-1 text-xs text-gray-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Assigning…
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { UserPlus, X, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addParticipant, getParticipants, removeParticipant } from "@/lib/api/interviews";
import type { InterviewParticipant, OrganizationUser, ParticipantRole } from "@/lib/api/types";

const ROLE_OPTIONS: { value: ParticipantRole; label: string }[] = [
  { value: "lead",            label: "Lead" },
  { value: "panel",           label: "Panel" },
  { value: "observer",        label: "Observer" },
  { value: "hiring_manager",  label: "Hiring Manager" },
];

const ROLE_STYLE: Record<string, string> = {
  lead:           "bg-orange-100 text-orange-700",
  panel:          "bg-blue-100 text-blue-700",
  observer:       "bg-gray-100 text-gray-600",
  hiring_manager: "bg-purple-100 text-purple-700",
};

interface Props {
  interviewId: string;
  orgUsers?: OrganizationUser[];
  canManage?: boolean;
}

export function PanelManager({ interviewId, orgUsers = [], canManage = false }: Props) {
  const [participants, setParticipants] = useState<InterviewParticipant[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedRole, setSelectedRole] = useState<ParticipantRole>("panel");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getParticipants(interviewId);
      setParticipants(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [interviewId]);

  useEffect(() => { void load(); }, [load]);

  async function handleAdd() {
    if (!selectedUserId) return;
    setAdding(true);
    setError(null);
    try {
      const p = await addParticipant(interviewId, { user_id: selectedUserId, participant_role: selectedRole });
      setParticipants((prev) => [...prev, p]);
      setAddOpen(false);
      setSelectedUserId("");
      setSelectedRole("panel");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add participant.");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(participantId: string) {
    setRemovingId(participantId);
    try {
      await removeParticipant(interviewId, participantId);
      setParticipants((prev) => prev.filter((p) => p.id !== participantId));
    } catch {
      // ignore
    } finally {
      setRemovingId(null);
    }
  }

  const alreadyAdded = new Set(participants.map((p) => p.user_id));
  const availableUsers = orgUsers.filter((u) => !alreadyAdded.has(u.id));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-gray-400" />
          <span className="text-xs font-semibold text-gray-700">
            Panel ({participants.filter((p) => p.status === "accepted").length} confirmed)
          </span>
        </div>
        {canManage && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setAddOpen((p) => !p)}
          >
            <UserPlus className="w-3.5 h-3.5 mr-1" />
            Add
          </Button>
        )}
      </div>

      {addOpen && canManage && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] text-gray-500 uppercase font-semibold">User</label>
              {availableUsers.length > 0 ? (
                <select
                  className="w-full rounded-md border border-gray-200 px-2.5 py-1.5 text-xs bg-white outline-none focus:border-[#FF5A1F]"
                  value={selectedUserId}
                  onChange={(e) => setSelectedUserId(e.target.value)}
                >
                  <option value="">Select user…</option>
                  {availableUsers.map((u) => (
                    <option key={u.id} value={u.id}>{u.email}</option>
                  ))}
                </select>
              ) : (
                <Input
                  placeholder="User ID (UUID)"
                  className="h-7 text-xs"
                  value={selectedUserId}
                  onChange={(e) => setSelectedUserId(e.target.value)}
                />
              )}
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-gray-500 uppercase font-semibold">Role</label>
              <select
                className="w-full rounded-md border border-gray-200 px-2.5 py-1.5 text-xs bg-white outline-none focus:border-[#FF5A1F]"
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value as ParticipantRole)}
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>
          {error && <p className="text-[10px] text-red-600">{error}</p>}
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs bg-[#FF5A1F] hover:bg-[#E54E1A] text-white"
              onClick={handleAdd} disabled={adding || !selectedUserId}>
              {adding ? "Adding…" : "Add to Panel"}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-1.5">
          {[1, 2].map((i) => (
            <div key={i} className="h-9 rounded-lg bg-gray-100 animate-pulse" />
          ))}
        </div>
      ) : participants.length === 0 ? (
        <p className="text-xs text-gray-400 italic">No panelists assigned yet.</p>
      ) : (
        <div className="space-y-1.5">
          {participants.map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded-lg bg-white border border-gray-200 px-3 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${ROLE_STYLE[p.participant_role] ?? "bg-gray-100 text-gray-600"}`}>
                  {p.participant_role.replace("_", " ")}
                </span>
                <span className="text-xs text-gray-600 truncate font-mono">
                  {orgUsers.find((u) => u.id === p.user_id)?.email ?? p.user_id.slice(0, 12) + "…"}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-[10px] font-medium ${
                  p.status === "accepted" ? "text-green-600" :
                  p.status === "declined" ? "text-red-500" : "text-gray-400"
                }`}>
                  {p.status}
                </span>
                {canManage && (
                  <button
                    onClick={() => handleRemove(p.id)}
                    disabled={removingId === p.id}
                    className="text-gray-300 hover:text-red-500 transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

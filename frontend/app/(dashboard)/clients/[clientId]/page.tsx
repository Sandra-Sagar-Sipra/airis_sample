"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Building2,
  Globe,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Tag,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ClientWorkspaceForm } from "@/components/clients/ClientWorkspaceForm";
import { DeleteClientDialog } from "@/components/clients/DeleteClientDialog";
import { RecruiterAssignmentSelector } from "@/components/clients/RecruiterAssignmentSelector";
import { getClient, listAvailableRecruiters, softDeleteClient, updateClient } from "@/lib/api/clients";
import { hasPermission } from "@/lib/rbac";
import { useAuthStore } from "@/store/auth-store";
import type { Client, ClientUpdatePayload, RecruiterUser } from "@/lib/api/types";

const CLIENTS_UPDATE_PERMISSION = "clients:update";
const CLIENTS_DELETE_PERMISSION = "clients:delete";
const CLIENTS_ASSIGN_PERMISSION = "clients:assign";

export default function ClientDetailPage() {
  const { clientId } = useParams<{ clientId: string }>();
  const router = useRouter();
  const permissions = useAuthStore((s) => s.permissions);
  const canUpdate = hasPermission(permissions, CLIENTS_UPDATE_PERMISSION);
  const canDelete = hasPermission(permissions, CLIENTS_DELETE_PERMISSION);
  const canAssign =
    hasPermission(permissions, CLIENTS_ASSIGN_PERMISSION) ||
    hasPermission(permissions, CLIENTS_UPDATE_PERMISSION);

  const [client, setClient] = useState<Client | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [availableRecruiters, setAvailableRecruiters] = useState<RecruiterUser[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, recruiters] = await Promise.all([
        getClient(clientId),
        listAvailableRecruiters(clientId).catch(() => [] as RecruiterUser[]),
      ]);
      setClient(data);
      setAvailableRecruiters(recruiters);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load client.");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => { load(); }, [load]);

  async function handleUpdate(payload: ClientUpdatePayload) {
    const updated = await updateClient(clientId, payload);
    setClient(updated);
    setEditing(false);
  }

  async function handleDelete() {
    await softDeleteClient(clientId);
    router.push("/clients");
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32 text-sm text-gray-400">
        Loading client…
      </div>
    );
  }

  if (error || !client) {
    return (
      <div className="p-6">
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error ?? "Client not found."}
        </div>
        <Link href="/clients" className="mt-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft className="h-4 w-4" /> Back to Clients
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Breadcrumb */}
      <Link
        href="/clients"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
      >
        <ArrowLeft className="h-4 w-4" />
        Client Workspaces
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-50">
            <Building2 className="h-5 w-5 text-[#FF5A1F]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-gray-900">{client.name}</h1>
              {client.is_deleted && (
                <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600">
                  Archived
                </span>
              )}
            </div>
            {client.legal_name && (
              <p className="text-sm text-gray-500">{client.legal_name}</p>
            )}
          </div>
        </div>

        {!client.is_deleted && (
          <div className="flex gap-2">
            {canUpdate && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing((v) => !v)}
                className="gap-1"
              >
                {editing ? <X className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
                {editing ? "Cancel" : "Edit"}
              </Button>
            )}
            {canDelete && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowDelete(true)}
                className="text-red-600 border-red-200 hover:bg-red-50"
              >
                Archive
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Edit form */}
      {editing && (
        <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 font-semibold text-gray-900">Edit Client</h2>
          <ClientWorkspaceForm
            initial={client}
            onSubmit={handleUpdate as (p: ClientUpdatePayload) => Promise<void>}
            onCancel={() => setEditing(false)}
            isEdit
          />
        </div>
      )}

      {/* Details grid */}
      {!editing && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <DetailCard label="Industry" icon={<Tag className="h-4 w-4" />} value={client.industry} />
          <DetailCard label="Contact Email" icon={<Mail className="h-4 w-4" />} value={client.email} />
          <DetailCard label="Website" icon={<Globe className="h-4 w-4" />} value={client.website} />
          <DetailCard label="Phone" icon={<Phone className="h-4 w-4" />} value={client.phone} />
          <DetailCard label="Location" icon={<MapPin className="h-4 w-4" />} value={client.location} />
        </div>
      )}

      {/* Notes */}
      {!editing && client.notes && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold text-gray-700">Notes</h3>
          <p className="text-sm text-gray-600 whitespace-pre-wrap">{client.notes}</p>
        </div>
      )}

      {/* Recruiter assignments */}
      {!client.is_deleted && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-semibold text-gray-700">Assigned Recruiters</h3>
          <RecruiterAssignmentSelector
            clientId={client.id}
            availableRecruiters={availableRecruiters}
            canAssign={canAssign}
          />
        </div>
      )}

      {/* Archive dialog */}
      {showDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-xl">
            <h2 className="mb-4 font-semibold text-gray-900">Archive Client</h2>
            <DeleteClientDialog
              client={client}
              onConfirm={handleDelete}
              onCancel={() => setShowDelete(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function DetailCard({
  label,
  icon,
  value,
}: {
  label: string;
  icon: React.ReactNode;
  value?: string | null;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-gray-100 bg-white p-3">
      <span className="mt-0.5 text-gray-400">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">{label}</p>
        <p className="mt-0.5 text-sm text-gray-900 break-words">{value || "—"}</p>
      </div>
    </div>
  );
}

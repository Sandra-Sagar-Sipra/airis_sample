"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ClientWorkspaceForm } from "@/components/clients/ClientWorkspaceForm";
import { ClientWorkspaceTable } from "@/components/clients/ClientWorkspaceTable";
import { DeleteClientDialog } from "@/components/clients/DeleteClientDialog";
import {
  createClient,
  listAllClients,
  softDeleteClient,
} from "@/lib/api/clients";
import { hasPermission } from "@/lib/rbac";
import { useAuthStore } from "@/store/auth-store";
import type { Client, ClientCreatePayload } from "@/lib/api/types";

const CLIENTS_CREATE_PERMISSION = "clients:create";
const CLIENTS_DELETE_PERMISSION = "clients:delete";
const CLIENTS_ASSIGN_PERMISSION = "clients:assign";
const CLIENTS_UPDATE_PERMISSION = "clients:update";

export default function ClientsPage() {
  const permissions = useAuthStore((s) => s.permissions);
  const canCreate = hasPermission(permissions, CLIENTS_CREATE_PERMISSION);
  const canDelete = hasPermission(permissions, CLIENTS_DELETE_PERMISSION);
  // canAssign: true for admin (clients:assign) or any user with clients:update.
  const canAssign =
    hasPermission(permissions, CLIENTS_ASSIGN_PERMISSION) ||
    hasPermission(permissions, CLIENTS_UPDATE_PERMISSION);

  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deletingClient, setDeletingClient] = useState<Client | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listAllClients();
      setClients(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load clients.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(payload: ClientCreatePayload) {
    await createClient(payload);
    setShowForm(false);
    await load();
  }

  async function handleDelete() {
    if (!deletingClient) return;
    await softDeleteClient(deletingClient.id);
    setDeletingClient(null);
    await load();
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Building2 className="h-6 w-6 text-[#FF5A1F]" />
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Client Workspaces</h1>
            <p className="text-sm text-gray-500">
              Manage your hiring clients and recruiter assignments.
            </p>
          </div>
        </div>
        {canCreate && (
          <Button
            onClick={() => setShowForm(true)}
            className="bg-[#FF5A1F] hover:bg-[#e04e1a] text-white gap-1"
          >
            <Plus className="h-4 w-4" />
            New Client
          </Button>
        )}
      </div>

      {/* Create form slide-in */}
      {showForm && (
        <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900">Create Client Workspace</h2>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <ClientWorkspaceForm
            onSubmit={handleCreate as any}
            onCancel={() => setShowForm(false)}
          />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-sm text-gray-400">
          Loading clients…
        </div>
      ) : (
        <ClientWorkspaceTable
          clients={clients}
          onArchive={canDelete ? setDeletingClient : undefined}
          canDelete={canDelete}
          canAssign={canAssign}
        />
      )}

      {/* Archive dialog */}
      {deletingClient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-xl">
            <h2 className="mb-4 font-semibold text-gray-900">Archive Client</h2>
            <DeleteClientDialog
              client={deletingClient}
              onConfirm={handleDelete}
              onCancel={() => setDeletingClient(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

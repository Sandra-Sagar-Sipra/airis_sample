"use client";

import Link from "next/link";
import { Building2, Mail, Tag, Users } from "lucide-react";
import type { Client } from "@/lib/api/types";

type Props = {
  clients: Client[];
  onArchive?: (client: Client) => void;
  canDelete?: boolean;
  /** Whether the current user can assign / remove recruiters from a client. */
  canAssign?: boolean;
};

export function ClientWorkspaceTable({ clients, onArchive, canDelete, canAssign }: Props) {
  if (clients.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-gray-200 py-16 text-center">
        <Building2 className="mb-3 h-10 w-10 text-gray-300" />
        <p className="text-sm font-medium text-gray-500">No clients found</p>
        <p className="mt-1 text-xs text-gray-400">Create your first client workspace to get started.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left font-semibold text-gray-600">Client</th>
            <th className="px-4 py-3 text-left font-semibold text-gray-600">Industry</th>
            <th className="px-4 py-3 text-left font-semibold text-gray-600">Contact Email</th>
            <th className="px-4 py-3 text-left font-semibold text-gray-600">Recruiters Assigned</th>
            <th className="px-4 py-3 text-left font-semibold text-gray-600">Status</th>
            {canDelete && <th className="px-4 py-3" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {clients.map((client) => (
            <tr key={client.id} className="hover:bg-gray-50 transition-colors">
              <td className="px-4 py-3">
                <Link
                  href={`/clients/${client.id}`}
                  className="font-medium text-gray-900 hover:text-[#FF5A1F] transition-colors"
                >
                  {client.name}
                </Link>
                {client.legal_name && (
                  <p className="text-xs text-gray-400 mt-0.5">{client.legal_name}</p>
                )}
              </td>
              <td className="px-4 py-3">
                {client.industry ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                    <Tag className="h-3 w-3" />
                    {client.industry}
                  </span>
                ) : (
                  <span className="text-gray-400">—</span>
                )}
              </td>
              <td className="px-4 py-3">
                {client.email ? (
                  <span className="inline-flex items-center gap-1 text-gray-600">
                    <Mail className="h-3 w-3 shrink-0 text-gray-400" />
                    {client.email}
                  </span>
                ) : (
                  <span className="text-gray-400">—</span>
                )}
              </td>
              <td className="px-4 py-3">
                <span className="inline-flex items-center gap-1 text-gray-600">
                  <Users className="h-3 w-3 text-gray-400" />
                  {client.assigned_recruiter_ids?.length ?? 0}
                  {canAssign && (
                    <Link
                      href={`/clients/${client.id}`}
                      className="ml-1 text-xs text-[#FF5A1F] hover:underline"
                    >
                      Manage
                    </Link>
                  )}
                </span>
              </td>
              <td className="px-4 py-3">
                {client.is_deleted ? (
                  <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600">
                    Archived
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                    Active
                  </span>
                )}
              </td>
              {canDelete && (
                <td className="px-4 py-3 text-right">
                  {!client.is_deleted && onArchive && (
                    <button
                      type="button"
                      onClick={() => onArchive(client)}
                      className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                    >
                      Archive
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

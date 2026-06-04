"use client";

/**
 * RoleTable — Roles management table with per-row 3-dot action menu.
 *
 * Dropdown design notes
 * ─────────────────────
 * The card wrapper uses `overflow-hidden` (required to clip table rows inside
 * rounded corners) and the table wrapper uses `overflow-x-auto`.  Both create
 * overflow contexts that clip any `position: absolute` child.
 *
 * Fix: the dropdown is rendered with `position: fixed` and positioned via
 * `getBoundingClientRect()` on the trigger button.  This places it relative
 * to the viewport, bypassing both overflow contexts entirely.
 *
 * A single `openMenuId` + `menuPos` state pair ensures only one dropdown is
 * open at a time.  Three effects close it on: outside mousedown, Escape key,
 * and window scroll (which would otherwise leave a stale-positioned menu).
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { deleteOrganizationRole } from "@/lib/api/roles";
import type { OrganizationRole, RoleInUseAffectedUser, RoleInUseErrorDetail } from "@/lib/api/types";
import {
  AlertTriangle,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings2,
  Shield,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RoleTableProps = {
  roles: OrganizationRole[];
  loading?: boolean;
  error?: string | null;
  onRoleDeleted?: (roleId: string) => void;
};

type MenuPosition = { top: number; right: number };

// ---------------------------------------------------------------------------
// Delete confirmation dialog (fixed-overlay, unchanged from AIR-108)
// ---------------------------------------------------------------------------

type DeleteDialogProps = {
  role: OrganizationRole;
  onConfirm: () => void;
  onCancel: () => void;
  deleting: boolean;
  deleteError: string | null;
  affectedUsers: RoleInUseAffectedUser[] | null;
};

function DeleteConfirmDialog({
  role,
  onConfirm,
  onCancel,
  deleting,
  deleteError,
  affectedUsers,
}: DeleteDialogProps) {
  const isBlocked = affectedUsers !== null && affectedUsers.length > 0;

  // Trap focus / close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deleting) onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [deleting, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-role-dialog-title"
      // Clicking the backdrop closes the dialog
      onMouseDown={(e) => { if (e.target === e.currentTarget && !deleting) onCancel(); }}
    >
      <div className="relative mx-4 w-full max-w-md rounded-2xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between p-6 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-red-100">
              <Trash2 className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <h2
                id="delete-role-dialog-title"
                className="text-base font-semibold text-gray-900"
              >
                Delete Role
              </h2>
              <p className="mt-0.5 text-sm text-gray-500">&ldquo;{role.name}&rdquo;</p>
            </div>
          </div>
          <button
            onClick={onCancel}
            disabled={deleting}
            className="ml-2 rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 pb-4 space-y-4">
          {isBlocked ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-amber-800">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                This role cannot be deleted
              </div>
              <p className="text-sm text-amber-700">
                The following{" "}
                {affectedUsers!.length === 1
                  ? "user is"
                  : `${affectedUsers!.length} users are`}{" "}
                currently assigned this role. Reassign{" "}
                {affectedUsers!.length === 1 ? "them" : "all of them"} before deleting.
              </p>
              <ul className="space-y-1 max-h-40 overflow-y-auto">
                {affectedUsers!.map((u) => (
                  <li
                    key={u.id}
                    className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-sm text-gray-700 border border-amber-100"
                  >
                    <span className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 text-xs font-medium">
                      {u.email.charAt(0).toUpperCase()}
                    </span>
                    {u.email}
                  </li>
                ))}
              </ul>
            </div>
          ) : deleteError ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              {deleteError}
            </div>
          ) : (
            <p className="text-sm text-gray-600">
              Are you sure you want to permanently delete the{" "}
              <span className="font-semibold text-gray-900">{role.name}</span> role? This will
              also remove all its permission assignments. This action cannot be undone.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 border-t border-gray-100 px-6 py-4">
          <button
            onClick={onCancel}
            disabled={deleting}
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            {isBlocked ? "Close" : "Cancel"}
          </button>
          {!isBlocked && (
            <Button
              onClick={onConfirm}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white flex items-center gap-2"
            >
              {deleting ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Deleting…
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4" />
                  Delete Role
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: extract ROLE_IN_USE detail from a 409 ApiError
// ---------------------------------------------------------------------------

function extractRoleInUseDetail(err: ApiError): RoleInUseErrorDetail | null {
  // Server returns { "detail": { "code": "ROLE_IN_USE", "affected_users": [...] } }
  const raw = err.detail as { detail?: unknown } | null | undefined;
  if (!raw) return null;
  const inner = raw.detail as Partial<RoleInUseErrorDetail> | undefined;
  if (inner?.code === "ROLE_IN_USE" && Array.isArray(inner.affected_users)) {
    return inner as RoleInUseErrorDetail;
  }
  return null;
}

// ---------------------------------------------------------------------------
// RoleTable
// ---------------------------------------------------------------------------

export function RoleTable({
  roles,
  loading = false,
  error = null,
  onRoleDeleted,
}: RoleTableProps) {
  const empty = !loading && !error && roles.length === 0;

  // ── 3-dot action menu state ───────────────────────────────────────────────
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /** Open the dropdown for a given role, positioning it below the trigger button. */
  function openMenu(roleId: string, trigger: HTMLButtonElement) {
    const rect = trigger.getBoundingClientRect();
    setMenuPos({
      top: rect.bottom + 6,
      // Align the dropdown's right edge to the button's right edge.
      right: window.innerWidth - rect.right,
    });
    setOpenMenuId(roleId);
  }

  function closeMenu() {
    setOpenMenuId(null);
    setMenuPos(null);
  }

  // Close on click outside the dropdown
  useEffect(() => {
    if (!openMenuId) return;
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [openMenuId]);

  // Close on Escape
  useEffect(() => {
    if (!openMenuId) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeMenu();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [openMenuId]);

  // Close when the page scrolls (prevents stale fixed position)
  useEffect(() => {
    if (!openMenuId) return;
    document.addEventListener("scroll", closeMenu, true);
    return () => document.removeEventListener("scroll", closeMenu, true);
  }, [openMenuId]);

  // ── Delete dialog state ───────────────────────────────────────────────────
  const [pendingDelete, setPendingDelete] = useState<OrganizationRole | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [affectedUsers, setAffectedUsers] = useState<RoleInUseAffectedUser[] | null>(null);

  function openDeleteDialog(role: OrganizationRole) {
    setDeleteError(null);
    setAffectedUsers(null);
    setPendingDelete(role);
  }

  function closeDeleteDialog() {
    if (deleting) return;
    setPendingDelete(null);
    setDeleteError(null);
    setAffectedUsers(null);
  }

  async function handleConfirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    setAffectedUsers(null);

    try {
      await deleteOrganizationRole(pendingDelete.id);
      onRoleDeleted?.(pendingDelete.id);
      setPendingDelete(null);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          const inUse = extractRoleInUseDetail(err);
          if (inUse) {
            setAffectedUsers(inUse.affected_users);
            return; // dialog stays open showing affected users
          }
        }
        setDeleteError(err.message || "Failed to delete role. Please try again.");
      } else {
        setDeleteError("An unexpected error occurred. Please try again.");
      }
    } finally {
      setDeleting(false);
    }
  }

  // ── Resolve the role object for the open menu (needed for delete dialog) ─
  const menuRole = openMenuId ? (roles.find((r) => r.id === openMenuId) ?? null) : null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Fixed-position 3-dot dropdown — outside any overflow context */}
      {openMenuId && menuPos && menuRole && (
        <div
          ref={menuRef}
          className="fixed z-40 w-44 rounded-xl bg-white shadow-lg border border-gray-200 py-1 text-sm"
          style={{ top: menuPos.top, right: menuPos.right }}
          role="menu"
        >
          <Link
            href={`/roles/${openMenuId}`}
            className="flex w-full items-center gap-2.5 px-3.5 py-2 text-gray-700 hover:bg-slate-50 transition-colors"
            role="menuitem"
            onClick={closeMenu}
          >
            <Pencil className="h-3.5 w-3.5 text-slate-400" />
            Edit permissions
          </Link>
          <div className="my-1 border-t border-gray-100" />
          <button
            className="flex w-full items-center gap-2.5 px-3.5 py-2 text-red-600 hover:bg-red-50 transition-colors"
            role="menuitem"
            onClick={() => {
              closeMenu();
              openDeleteDialog(menuRole);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete role
          </button>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {pendingDelete ? (
        <DeleteConfirmDialog
          role={pendingDelete}
          onConfirm={handleConfirmDelete}
          onCancel={closeDeleteDialog}
          deleting={deleting}
          deleteError={deleteError}
          affectedUsers={affectedUsers}
        />
      ) : null}

      {/* Card */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Shield className="w-5 h-5 text-gray-400" />
            Configured Roles
          </h2>
          <Link href="/roles/create">
            <Button className="bg-[#FF5A1F] hover:bg-[#E04D1A] text-white flex items-center gap-2">
              <Plus className="w-4 h-4" /> New Role
            </Button>
          </Link>
        </div>

        <div className="p-0">
          {error ? (
            <div className="m-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 flex items-center gap-2">
              {error}
            </div>
          ) : null}

          {!loading && !error && empty ? (
            <div className="py-12 text-center">
              <ShieldCheck className="w-12 h-12 text-slate-200 mx-auto mb-3" />
              <p className="text-sm font-medium text-slate-900">No roles found</p>
              <p className="text-sm text-slate-500 mt-1">
                Create a role to assign permissions for your organization.
              </p>
              <div className="mt-6 flex justify-center">
                <Link href="/roles/create">
                  <Button className="bg-[#FF5A1F] hover:bg-[#E04D1A] text-white">
                    Create your first role
                  </Button>
                </Link>
              </div>
            </div>
          ) : null}

          {!loading && !error && !empty ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-slate-50">
                  <tr className="border-b border-gray-200 text-slate-500 font-medium">
                    <th className="px-6 py-4">Role Name</th>
                    <th className="px-6 py-4 text-slate-400 font-normal">Users</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {roles.map((r) => {
                    let desc = 'Custom role with specific permissions';
                    const n = r.name.toLowerCase();
                    if (n === 'admin') desc = 'Full access to manage all modules and settings';
                    else if (n === 'client viewer') desc = 'View client data and limited modules';
                    else if (n === 'full access') desc = 'Access to all modules and perform all actions';
                    else if (n === 'recruiter') desc = 'Manage candidates, jobs and pipeline';
                    else if (n === 'vendor') desc = 'Access limited to vendor related actions';

                    return (
                      <tr key={r.id} className="hover:bg-[#FFF4F0] transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div>
                              <div className="font-semibold text-slate-900 text-[15px] capitalize">
                                {r.name}
                              </div>
                              <div className="text-slate-500 mt-0.5 text-[13px]">
                                {desc}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                            {r.user_count ?? 0} {(r.user_count ?? 0) === 1 ? 'User' : 'Users'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            aria-label={`Actions for ${r.name}`}
                            aria-haspopup="menu"
                            aria-expanded={openMenuId === r.id}
                            className={[
                              "inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
                              openMenuId === r.id
                                ? "bg-orange-50 text-[#FF5A1F]"
                                : "text-slate-400 hover:bg-orange-50 hover:text-[#FF5A1F]",
                            ].join(" ")}
                            onClick={(e) => {
                              if (openMenuId === r.id) {
                                closeMenu();
                              } else {
                                openMenu(r.id, e.currentTarget);
                              }
                            }}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { RoleTable } from "@/components/RoleTable";
import { getRoles, type Role } from "@/lib/api";
import { useAuthStore } from "@/store/auth-store";
import { ShieldCheck } from "lucide-react";

const ROLE_FLASH_KEY = "airis_role_flash";

function PageLoader() {
  return (
    <div className="flex min-h-[200px] items-center justify-center">
      <p className="text-sm text-slate-600">Loading...</p>
    </div>
  );
}

export default function RolesPage() {
  const role = useAuthStore((state) => state.role);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const flash = sessionStorage.getItem(ROLE_FLASH_KEY);
    if (flash === "created") {
      setSuccessMessage("Role created successfully.");
      sessionStorage.removeItem(ROLE_FLASH_KEY);
    } else if (flash === "updated") {
      setSuccessMessage("Permissions updated successfully.");
      sessionStorage.removeItem(ROLE_FLASH_KEY);
    }
  }, []);

  useEffect(() => {
    async function load() {
      if (role !== "admin") {
        setLoading(false);
        return;
      }

      setError(null);
      try {
        const roleRows = await getRoles();
        setRoles(roleRows);
      } catch (err) {
        if (err instanceof Error) {
          setError("Failed to load roles. Please try again.");
        } else {
          setError("Something went wrong. Please try again.");
        }
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [role]);

  /** Remove the deleted role from local state and show a success banner. */
  const handleRoleDeleted = useCallback((roleId: string) => {
    setRoles((prev) => prev.filter((r) => r.id !== roleId));
    setSuccessMessage("Role deleted successfully.");
  }, []);

  if (role !== "admin") {
    return <p className="text-sm text-slate-600">Only admins can manage roles.</p>;
  }

  if (loading) {
    return <PageLoader />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-[#FF5A1F]" />
            Organization Roles
          </h1>
          <p className="text-sm text-gray-500 mt-1">Manage custom roles and configure permissions</p>
        </div>
      </div>

      {successMessage ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 flex items-center gap-2 shadow-sm">
          {successMessage}
        </div>
      ) : null}

      <RoleTable roles={roles} error={error} onRoleDeleted={handleRoleDeleted} />
    </div>
  );
}

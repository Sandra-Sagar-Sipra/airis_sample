"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PermissionGroup } from "@/components/PermissionGroup";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError } from "@/lib/api/client";
import {
  assignPermissions,
  getPermissions,
  getRolePermissions,
  getRoles,
  type PermissionModuleGroup,
  type Role,
} from "@/lib/api";
import { useAuthStore } from "@/store/auth-store";

const ROLE_FLASH_KEY = "airis_role_flash";

function PageLoader() {
  return (
    <div className="flex min-h-[200px] items-center justify-center">
      <p className="text-sm text-slate-600">Loading...</p>
    </div>
  );
}

function mapLoadError(err: unknown): string {
  if (err instanceof ApiError) {
    return "Failed to load role or permissions. Please try again.";
  }
  return "Something went wrong. Please try again.";
}

function mapSaveError(err: unknown): string {
  if (err instanceof ApiError) {
    return "Failed to save permissions. Please try again.";
  }
  return "Unable to update permissions. Please try again.";
}

import { ArrowLeft } from "lucide-react";

export default function EditRolePage() {
  const params = useParams();
  const router = useRouter();
  const role = useAuthStore((state) => state.role);
  const roleId = useMemo(() => (typeof params.id === "string" ? params.id : ""), [params.id]);

  const [roleRow, setRoleRow] = useState<Role | null>(null);
  const [groups, setGroups] = useState<PermissionModuleGroup[]>([]);
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      if (role !== "admin") {
        setLoading(false);
        return;
      }
      if (!roleId) {
        setLoadError("Missing role.");
        setLoading(false);
        return;
      }

      setLoadError(null);
      try {
        const [allRoles, permissionGroups, existingCodes] = await Promise.all([
          getRoles(),
          getPermissions(),
          getRolePermissions(roleId),
        ]);
        setRoleRow(allRoles.find((r) => r.id === roleId) ?? null);
        setGroups(permissionGroups);
        setSelectedPermissions(existingCodes);
      } catch (err) {
        setLoadError(mapLoadError(err));
      } finally {
        setLoading(false);
      }
    }

    void loadData();
  }, [role, roleId]);

  function onTogglePermission(code: string, checked: boolean) {
    setSelectedPermissions((prev) => {
      if (checked) {
        return prev.includes(code) ? prev : [...prev, code];
      }
      return prev.filter((value) => value !== code);
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) {
      return;
    }

    setSaveError(null);

    if (!roleId) {
      setSaveError("Missing role.");
      return;
    }

    setSaving(true);
    try {
      await assignPermissions(roleId, selectedPermissions);
      if (typeof window !== "undefined") {
        sessionStorage.setItem(ROLE_FLASH_KEY, "updated");
      }
      router.push("/roles");
      router.refresh();
    } catch (err) {
      setSaveError(mapSaveError(err));
    } finally {
      setSaving(false);
    }
  }

  if (role !== "admin") {
    return <p className="text-sm text-slate-600">Only admins can edit roles.</p>;
  }

  return (
    <section className="space-y-4">
      <div>
        <Button variant="ghost" size="sm" onClick={() => router.push("/roles")} className="-ml-3 text-slate-500 hover:text-slate-700">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Roles
        </Button>
      </div>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-2xl font-semibold">
            {loading ? "Loading..." : roleRow ? roleRow.name : "Role"}
          </CardTitle>
          <div className="text-sm font-medium text-slate-500">Edit Role</div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <PageLoader />
          ) : loadError ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
              {loadError}
            </p>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <PermissionGroup
                groups={groups}
                selectedPermissions={selectedPermissions}
                onTogglePermission={onTogglePermission}
                disabled={saving}
              />

              {saveError ? (
                <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                  {saveError}
                </p>
              ) : null}

              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => router.push("/roles")} disabled={saving}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving..." : "Save Role"}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

import type { Permission } from "@/lib/api/types";

/**
 * Permission codes used for sidebar visibility (must match backend RBAC strings).
 * Centralized so menu config does not scatter magic strings.
 */
export const NAV_PERMISSION_CODES = {
  CANDIDATES_READ: "candidates:read",
  CANDIDATES_READ_OWN: "candidates:read_own",
  JOBS_READ: "jobs:read",
  JOBS_READ_LIMITED: "jobs:read_limited",
  PIPELINE_READ: "pipeline:read",
  USERS_INVITE: "users:invite",
  INTERVIEWS_READ: "interviews:read",
  SUBMISSIONS_READ_OWN: "submissions:read_own",
  CLIENTS_READ: "clients:read",
  CLIENTS_ASSIGN: "clients:assign",
} as const;

export type SidebarNavItem = {
  name: string;
  path: string;
  /** If set, user must hold at least one of these permissions (unless `adminMayAccess` applies). */
  anyOfPermissions?: readonly string[];
  /** When true, only organization admins see this item. */
  adminOnly?: boolean;
  /** When true, only vendors see this item. */
  vendorOnly?: boolean;
  /** When true, admins see the item even without the listed permissions (e.g. user management). */
  adminMayAccess?: boolean;
  /** When false, used only for route access checks (not shown in the sidebar). */
  showInSidebar?: boolean;
};

export const SIDEBAR_NAV_ITEMS: readonly SidebarNavItem[] = [
  { name: "Dashboard", path: "/dashboard" },
  {
    name: "Candidates",
    path: "/candidates",
    anyOfPermissions: [NAV_PERMISSION_CODES.CANDIDATES_READ, NAV_PERMISSION_CODES.CANDIDATES_READ_OWN],
  },
  {
    name: "Jobs",
    path: "/jobs",
    anyOfPermissions: [NAV_PERMISSION_CODES.JOBS_READ],
  },
  {
    name: "My Jobs",
    path: "/vendor/jobs",
    anyOfPermissions: [NAV_PERMISSION_CODES.JOBS_READ_LIMITED],
    showInSidebar: false,
  },
  {
    name: "My Submissions",
    path: "/vendor/submissions",
    anyOfPermissions: [NAV_PERMISSION_CODES.SUBMISSIONS_READ_OWN],
    vendorOnly: true,
  },
  {
    // Unified pipeline workspace (table + kanban toggle at /pipelines).
    name: "Pipeline",
    path: "/pipelines",
    anyOfPermissions: [NAV_PERMISSION_CODES.PIPELINE_READ],
  },
  {
    // Legacy /pipeline route redirects to /pipelines?view=kanban — keep RBAC entry for access guard.
    name: "Pipeline (legacy)",
    path: "/pipeline",
    anyOfPermissions: [NAV_PERMISSION_CODES.PIPELINE_READ],
    showInSidebar: false,
  },
  {
    name: "Pipeline Analytics",
    path: "/pipeline-analytics",
    anyOfPermissions: [NAV_PERMISSION_CODES.PIPELINE_READ],
    adminMayAccess: true,
  },
  {
    name: "Analytics",
    path: "/analytics",
    anyOfPermissions: [NAV_PERMISSION_CODES.JOBS_READ],
  },
  // Pipeline detail pages (/pipelines/{id}) — same RBAC as Pipeline workspace.
  {
    name: "Pipeline Detail",
    path: "/pipelines",
    anyOfPermissions: [NAV_PERMISSION_CODES.PIPELINE_READ],
    showInSidebar: false,
  },
  // ── Client Workspaces (WS-002) ────────────────────────────────────────────
  {
    name: "Clients",
    path: "/clients",
    anyOfPermissions: [NAV_PERMISSION_CODES.CLIENTS_READ],
    adminMayAccess: true,
  },
  {
    name: "Client Detail",
    path: "/clients",
    anyOfPermissions: [NAV_PERMISSION_CODES.CLIENTS_READ],
    adminMayAccess: true,
    showInSidebar: false,
  },
  {
    name: "Invites",
    path: "/invites",
    anyOfPermissions: [NAV_PERMISSION_CODES.USERS_INVITE],
    adminMayAccess: true,
  },
  {
    name: "Users",
    path: "/users",
    anyOfPermissions: [NAV_PERMISSION_CODES.USERS_INVITE],
    adminMayAccess: true,
  },
  { name: "Roles", path: "/roles", adminOnly: true },
  // ── Interview section ──────────────────────────────────────────────────
  {
    name: "Interview Queue",
    path: "/interviews/queue",
    anyOfPermissions: [NAV_PERMISSION_CODES.INTERVIEWS_READ],
    adminMayAccess: true,
  },
  {
    name: "My Interviews",
    path: "/interviews/my",
    anyOfPermissions: [NAV_PERMISSION_CODES.INTERVIEWS_READ],
    adminMayAccess: true,
  },
  // Workspace: dynamic route /interviews/[id] — access requires interviews:read
  {
    name: "Interview Workspace",
    path: "/interviews",
    anyOfPermissions: [NAV_PERMISSION_CODES.INTERVIEWS_READ],
    adminMayAccess: true,
    showInSidebar: false,
  },
  // ── AI Sourcing (AI-SOURCE-001) ────────────────────────────────────────
  {
    name: "Source Candidates",
    path: "/source",
    anyOfPermissions: [NAV_PERMISSION_CODES.CANDIDATES_READ],
    adminMayAccess: true,
  },
  // ── AI Interview section ───────────────────────────────────────────────
  {
    name: "AI Interview",
    path: "/ai-screenings",
    anyOfPermissions: [NAV_PERMISSION_CODES.CANDIDATES_READ],
    adminMayAccess: true,
  },
  // Same RBAC as above, for alternate URLs that still use DashboardShell.
  { name: "Jobs (dashboard path)", path: "/dashboard/jobs", anyOfPermissions: [NAV_PERMISSION_CODES.JOBS_READ], showInSidebar: false },
  {
    name: "Users (dashboard path)",
    path: "/dashboard/users",
    anyOfPermissions: [NAV_PERMISSION_CODES.USERS_INVITE],
    adminMayAccess: true,
    showInSidebar: false,
  },
  { name: "Roles (dashboard path)", path: "/dashboard/roles", adminOnly: true, showInSidebar: false },
  {
    name: "Invites (dashboard path)",
    path: "/dashboard/invites",
    anyOfPermissions: [NAV_PERMISSION_CODES.USERS_INVITE],
    adminMayAccess: true,
    showInSidebar: false,
  },
] as const;

function normalizeRole(role: string | null | undefined) {
  return (role ?? "").trim().toLowerCase();
}

/**
 * Returns true for any variant of the admin role key.
 * Handles "admin", "superadmin", "org_admin", "administrator", and "super_admin"
 * so that RBAC gating works regardless of how the role was originally seeded.
 */
export function isAdminRole(role: string | null | undefined) {
  const r = normalizeRole(role);
  return r === "admin" || r === "superadmin" || r === "org_admin" || r === "administrator" || r === "super_admin";
}

/** Whether the user may see this sidebar entry. */
export function matchesSidebarNavItem(
  role: string | null | undefined,
  permissions: readonly Permission[],
  item: SidebarNavItem
): boolean {
  if (item.vendorOnly && normalizeRole(role) !== "vendor") {
    return false;
  }
  if (item.adminOnly) {
    return isAdminRole(role);
  }
  if (!item.anyOfPermissions?.length) {
    return true;
  }
  if (item.adminMayAccess && isAdminRole(role)) {
    return true;
  }
  return item.anyOfPermissions.some((code) => permissions.includes(code));
}

/**
 * Resolve which nav rule applies to a pathname (longest prefix wins; "/" is exact only).
 */
export function navAccessRuleForPathname(pathname: string): SidebarNavItem | null {
  if (pathname === "/dashboard") {
    return SIDEBAR_NAV_ITEMS.find((i) => i.path === "/dashboard") ?? null;
  }
  const candidates = SIDEBAR_NAV_ITEMS.filter((i) => i.path !== "/dashboard").sort((a, b) => b.path.length - a.path.length);
  return (
    candidates.find((item) => pathname === item.path || pathname.startsWith(`${item.path}/`)) ?? null
  );
}

/** Whether the current user may access this route (same rules as sidebar, plus unknown routes allowed). */
export function canAccessPathname(
  pathname: string,
  role: string | null | undefined,
  permissions: readonly Permission[]
): boolean {
  const rule = navAccessRuleForPathname(pathname);
  if (!rule) {
    return true;
  }
  return matchesSidebarNavItem(role, permissions, rule);
}

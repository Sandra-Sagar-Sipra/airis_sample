"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Menu, Search,
  LayoutDashboard, Users, Briefcase, Filter, Mail, UserCheck,
  CalendarDays, List, Settings, Shield, Brain, Send, BarChart3,
  ChevronLeft, ChevronRight, LogOut, Sparkles
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  SIDEBAR_NAV_ITEMS,
  canAccessPathname,
  isAdminRole,
  matchesSidebarNavItem,
  navAccessRuleForPathname,
  SidebarNavItem,
} from "@/lib/dashboard-nav";
import { useAuthStore } from "@/store/auth-store";

const ICON_MAP: Record<string, LucideIcon> = {
  Dashboard: LayoutDashboard,
  Candidates: Users,
  Jobs: Briefcase,
  Pipeline: Filter,
  "My Jobs": Briefcase,
  Clients: UserCheck,
  Invites: Mail,
  Users: Users,
  Roles: Shield,
  Settings: Settings,
  Invite: Mail,
  "Interview Queue": List,
  "My Interviews": CalendarDays,
  "AI Interview Screening": Brain,
  "Source Candidates": Sparkles,
  "My Submissions": Send,
  "Pipeline Intelligence": BarChart3,
  Analytics: BarChart3,
};

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const hydrated = useAuthStore((state) => state.hydrated);
  const token = useAuthStore((state) => state.token);
  const role = useAuthStore((state) => state.role);
  const permissions = useAuthStore((state) => state.permissions);
  const hydrate = useAuthStore((state) => state.hydrate);
  const refreshPermissions = useAuthStore((state) => state.refreshPermissions);
  const clearToken = useAuthStore((state) => state.clearToken);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const filteredMenu = useMemo(
    () =>
      SIDEBAR_NAV_ITEMS.filter(
        (item) => item.showInSidebar !== false && matchesSidebarNavItem(role, permissions, item)
      ),
    [role, permissions]
  );

  const recruitingMenu = filteredMenu.filter(i => ["Dashboard", "Analytics", "Candidates", "Jobs", "Pipeline", "Pipeline Intelligence", "My Jobs", "Clients", "Invites", "Invite", "My Submissions"].includes(i.name));
  const interviewMenu = filteredMenu.filter(i => ["Interview Queue", "My Interviews"].includes(i.name));
  const aiMenu = filteredMenu.filter(i => ["AI Interview Screening", "Source Candidates"].includes(i.name));
  const managementMenu = filteredMenu.filter(i => ["Users", "Roles", "Settings"].includes(i.name));

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!token || permissions.length > 0) return;
    void refreshPermissions();
  }, [token, permissions.length, refreshPermissions]);

  useEffect(() => {
    if (!hydrated) return;
    if (token === null) router.replace("/login");
  }, [hydrated, router, token]);

  useEffect(() => {
    if (!hydrated) return;
    if (token && role === null) router.replace("/login");
  }, [hydrated, role, router, token]);

  useEffect(() => {
    if (!hydrated || token === null) return;
    const rule = navAccessRuleForPathname(pathname);
    const ready = permissions.length > 0 || isAdminRole(role) || !rule;
    if (!ready) return;
    if (!canAccessPathname(pathname, role, permissions)) {
      router.replace("/dashboard");
    }
  }, [hydrated, pathname, permissions, role, router, token]);

  function onLogout() {
    clearToken();
    router.push("/login");
  }

  const renderNavGroup = (title: string, items: SidebarNavItem[]) => {
    if (items.length === 0) return null;
    return (
      <div className="mb-6">
        {!isCollapsed && <h4 className="px-6 text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">{title}</h4>}
        <nav className="space-y-0.5 px-3">
          {items.map((item) => {
            const Icon = ICON_MAP[item.name] || LayoutDashboard;
            const isActive = pathname === item.path;
            return (
              <Link
                key={item.name}
                href={item.path}
                prefetch={true}
                title={isCollapsed ? item.name : undefined}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                  isActive
                    ? "bg-orange-50 text-orange-600"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                  isCollapsed && "justify-center px-0"
                )}
              >
                {isCollapsed && (
                  <Icon className={cn("w-4 h-4 flex-shrink-0", isActive ? "text-orange-500" : "text-slate-400")} />
                )}
                {!isCollapsed && item.name}
              </Link>
            );
          })}
        </nav>
      </div>
    );
  };

  const rule = navAccessRuleForPathname(pathname);
  const accessReady = permissions.length > 0 || isAdminRole(role) || !rule;
  const pageAllowed = canAccessPathname(pathname, role, permissions);

  return (
    <div className="flex h-screen overflow-hidden bg-[#FAFAFA]">
      {/* Mobile Sidebar Overlay */}
      {mobileNavOpen ? (
        <div
          className="fixed inset-0 z-40 bg-slate-900/20 backdrop-blur-sm md:hidden transition-opacity"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex transform flex-col border-r border-slate-200/60 bg-white shadow-[4px_0_24px_rgba(0,0,0,0.01)] transition-all duration-300 ease-out md:relative",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
          isCollapsed ? "w-[68px]" : "w-[212px]"
        )}
      >
        <div className={cn("relative flex h-20 items-center", isCollapsed ? "justify-center px-0" : "px-5")}>
          <div className="flex items-center gap-3">
            <div className="relative flex h-8 w-8 flex-shrink-0 items-center justify-center">
              <div className="absolute inset-0 rotate-45 rounded-[8px] bg-[#FF5A1F] shadow-[0_2px_4px_rgba(255,90,31,0.2)]" />
              <span className="relative text-[14px] font-extrabold tracking-tighter text-white">A</span>
            </div>
            {!isCollapsed ? (
              <span className="whitespace-nowrap text-[20px] font-extrabold tracking-tight text-slate-900">AIRIS</span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setIsCollapsed(!isCollapsed)}
            className={cn(
              "absolute top-7 w-6 h-6 bg-white hover:bg-slate-50 rounded-full flex items-center justify-center text-slate-400 transition-colors border border-slate-200 shadow-sm z-10",
              isCollapsed ? "right-[-12px]" : "right-3"
            )}
            aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
          </button>
        </div>

        <div className="scrollbar-hide flex-1 overflow-y-auto overflow-x-hidden py-2">
          {renderNavGroup("Recruiting", recruitingMenu)}
          {renderNavGroup("Interviews", interviewMenu)}
          {renderNavGroup("AI", aiMenu)}
          {renderNavGroup("Management", managementMenu)}
        </div>

        <div className="p-4 border-t border-slate-100">
          <button
            onClick={onLogout}
            className={cn(
              "flex items-center gap-3 px-3 py-2 text-sm font-medium text-slate-500 hover:text-red-600 w-full rounded-lg hover:bg-red-50 transition-colors",
              isCollapsed && "justify-center px-0"
            )}
          >
            {isCollapsed && <LogOut className="w-4 h-4 flex-shrink-0" />}
            {!isCollapsed && "Logout"}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Header */}
        <header className="h-16 bg-white border-b border-slate-200 flex flex-shrink-0 items-center justify-between px-4 sm:px-6 lg:px-8 z-10">
          <div className="flex items-center flex-1 gap-4">
            <button
              className="md:hidden -ml-2 inline-flex items-center justify-center rounded-md p-2 text-slate-600 hover:bg-slate-100 transition-colors"
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu className="w-5 h-5 text-slate-600" />
            </button>

            {/* Search Bar */}
            <div className="hidden sm:flex items-center relative max-w-md w-full">
              <Search className="w-4 h-4 absolute left-3 text-slate-400" />
              <input
                type="text"
                placeholder="Search candidates, jobs..."
                className="w-full h-9 pl-9 pr-4 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-[#FF5A1F] focus:ring-1 focus:ring-[#FF5A1F] transition-all"
              />
            </div>
          </div>

          <div className="flex items-center gap-4 pl-4">

            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-orange-100 flex items-center justify-center text-[#FF5A1F] font-bold text-sm">
                {role?.[0]?.toUpperCase() ?? "A"}
              </div>
              <div className="hidden md:flex flex-col">
                <span className="text-sm font-semibold text-slate-900 leading-tight">Admin User</span>
                <span className="text-[11px] text-slate-500 uppercase tracking-wide">{role ?? "Administrator"}</span>
              </div>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div className="max-w-7xl mx-auto w-full">
            {!accessReady ? (
              <p className="text-sm text-slate-600">Loading workspace...</p>
            ) : pageAllowed ? (
              children
            ) : (
              <p className="text-sm text-slate-500">Redirecting...</p>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

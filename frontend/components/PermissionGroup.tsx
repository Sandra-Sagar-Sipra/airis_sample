"use client";

import { useState, useMemo } from "react";
import type { PermissionModuleGroup } from "@/lib/api";
import { PermissionCheckbox } from "./PermissionCheckbox";
import { Button } from "@/components/ui/button";
import {
  Users,
  Briefcase,
  Filter,
  Building,
  Calendar,
  Sparkles,
  Settings,
  User,
  LayoutTemplate,
  Bot,
  ChevronUp,
  ChevronDown,
} from "lucide-react";

type PermissionGroupProps = {
  groups: PermissionModuleGroup[];
  selectedPermissions: string[];
  onTogglePermission: (code: string, checked: boolean) => void;
  disabled?: boolean;
};

function formatModuleLabel(module: string) {
  return module.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

const getModuleIconAndColor = (module: string) => {
  const m = module.toLowerCase();
  if (m.includes("candidate")) return { icon: User, color: "text-orange-500", bg: "bg-orange-100" };
  if (m.includes("job")) return { icon: Briefcase, color: "text-blue-500", bg: "bg-blue-100" };
  if (m.includes("pipeline") || m.includes("submission")) return { icon: Filter, color: "text-purple-500", bg: "bg-purple-100" };
  if (m.includes("client")) return { icon: Building, color: "text-emerald-500", bg: "bg-emerald-100" };
  if (m.includes("interview")) return { icon: Calendar, color: "text-indigo-500", bg: "bg-indigo-100" };
  if (m.includes("ai")) return { icon: Sparkles, color: "text-teal-500", bg: "bg-teal-100" };
  if (m.includes("org") || m.includes("admin")) return { icon: Settings, color: "text-blue-600", bg: "bg-blue-100" };
  if (m.includes("user")) return { icon: Users, color: "text-pink-500", bg: "bg-pink-100" };
  if (m.includes("ats")) return { icon: Bot, color: "text-cyan-500", bg: "bg-cyan-100" };
  return { icon: LayoutTemplate, color: "text-slate-500", bg: "bg-slate-100" };
};

const getModuleSubtext = (module: string) => {
  const m = module.toLowerCase();
  if (m.includes("candidate")) return "Manage candidates";
  if (m.includes("job")) return "Manage jobs & openings";
  if (m.includes("pipeline")) return "Manage pipeline";
  if (m.includes("client")) return "Manage clients";
  if (m.includes("interview")) return "Manage interviews";
  if (m.includes("ai")) return "AI tools & capabilities";
  if (m.includes("org")) return "Organization settings";
  if (m.includes("user")) return "Manage users";
  if (m.includes("ats")) return "ATS integrations";
  return `Manage ${formatModuleLabel(module).toLowerCase()}`;
};

export function PermissionGroup({ groups, selectedPermissions, onTogglePermission, disabled = false }: PermissionGroupProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  // Merge groups with the same formatted label to remove duplicate cards
  const mergedGroups = useMemo(() => {
    const map = new Map<string, typeof groups[0]>();
    
    for (const group of groups) {
      const label = formatModuleLabel(group.module);
      if (!map.has(label)) {
        map.set(label, { module: group.module, permissions: [] });
      }
      
      const merged = map.get(label)!;
      
      for (const perm of group.permissions) {
        if (perm.display_name.toLowerCase() === "merge") {
          continue;
        }
        if (!merged.permissions.some(p => p.code === perm.code)) {
          merged.permissions.push(perm);
        }
      }
    }
    
    return Array.from(map.values())
      .filter(g => g.permissions.length > 0)
      .map(g => ({
        ...g,
        permissions: g.permissions.sort((a, b) => a.display_name.localeCompare(b.display_name))
      }));
  }, [groups]);

  const toggleCollapse = (module: string) => {
    setCollapsedGroups(prev => ({ ...prev, [module]: !prev[module] }));
  };

  const allCollapsed = mergedGroups.length > 0 && mergedGroups.every(g => collapsedGroups[g.module]);
  
  const toggleAll = () => {
    const nextState = !allCollapsed;
    const newState: Record<string, boolean> = {};
    mergedGroups.forEach(g => {
      newState[g.module] = nextState;
    });
    setCollapsedGroups(newState);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-500">Enable or disable access to modules and actions</h2>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={toggleAll}
          type="button"
          className="text-slate-600 border-slate-200"
        >
          {allCollapsed ? "Expand All" : "Collapse All"}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {mergedGroups.map((group) => {
          const isCollapsed = collapsedGroups[group.module];

          return (
            <div key={group.module} className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden flex flex-col transition-all">
              <button 
                type="button"
                onClick={() => toggleCollapse(group.module)}
                className="flex items-center justify-between w-full p-4 border-b border-slate-100 hover:bg-slate-50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="text-left">
                    <h3 className="font-semibold text-slate-900">{formatModuleLabel(group.module)}</h3>
                    <p className="text-xs text-slate-500">{getModuleSubtext(group.module)}</p>
                  </div>
                </div>
                {isCollapsed ? (
                  <ChevronDown className="h-4 w-4 text-slate-400" />
                ) : (
                  <ChevronUp className="h-4 w-4 text-slate-400" />
                )}
              </button>
              
              {!isCollapsed && (
                <div className="p-4 flex-1 flex flex-col">
                  {group.permissions.map((permission) => (
                    <PermissionCheckbox
                      key={permission.code}
                      permission={permission}
                      checked={selectedPermissions.includes(permission.code)}
                      onToggle={onTogglePermission}
                      disabled={disabled}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

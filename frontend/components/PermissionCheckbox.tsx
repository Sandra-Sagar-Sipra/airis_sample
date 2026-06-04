"use client";

import type { PermissionItem } from "@/lib/api";

type PermissionCheckboxProps = {
  permission: PermissionItem;
  checked: boolean;
  onToggle: (code: string, checked: boolean) => void;
  disabled?: boolean;
};

export function PermissionCheckbox({
  permission,
  checked,
  onToggle,
  disabled = false,
}: PermissionCheckboxProps) {
  return (
    <label
      className={`group flex items-center justify-between py-2 transition-colors ${
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-slate-700 group-hover:text-slate-900">
          {permission.display_name}
        </span>
      </div>
      
      <div className="relative inline-flex items-center">
        <input
          type="checkbox"
          className="sr-only peer"
          checked={checked}
          onChange={(e) => onToggle(permission.code, e.target.checked)}
          disabled={disabled}
        />
        <div className={`w-9 h-5 rounded-full transition-colors peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-orange-500/40 peer-disabled:opacity-50
          ${checked ? 'bg-orange-500' : 'bg-slate-200'}`}
        ></div>
        <div className={`absolute left-0.5 top-0.5 bg-white w-4 h-4 rounded-full transition-transform
          ${checked ? 'translate-x-4' : 'translate-x-0'}`}
        ></div>
      </div>
    </label>
  );
}

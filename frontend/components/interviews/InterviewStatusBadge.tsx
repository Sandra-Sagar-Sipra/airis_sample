import { cn } from "@/lib/utils";
import type { InterviewStatus } from "@/lib/api/types";

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  scheduled:         { label: "Scheduled",         className: "bg-blue-50 text-blue-700 border-blue-200" },
  pending_panel:     { label: "Needs Panel",        className: "bg-orange-50 text-orange-700 border-orange-200" },
  panel_confirmed:   { label: "Panel Confirmed",    className: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  in_progress:       { label: "In Progress",        className: "bg-violet-50 text-violet-700 border-violet-200" },
  confirmed:         { label: "Confirmed",          className: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  completed:         { label: "Completed",          className: "bg-green-50 text-green-700 border-green-200" },
  cancelled:         { label: "Cancelled",          className: "bg-red-50 text-red-700 border-red-200" },
  no_show:           { label: "No Show",            className: "bg-orange-50 text-orange-700 border-orange-200" },
  rescheduled:       { label: "Rescheduled",        className: "bg-orange-50 text-orange-700 border-orange-200" },
  feedback_pending:  { label: "Feedback Pending",   className: "bg-purple-50 text-purple-700 border-purple-200" },
  feedback_submitted:{ label: "Feedback Submitted", className: "bg-teal-50 text-teal-700 border-teal-200" },
};

interface Props {
  status: InterviewStatus | string;
  size?: "sm" | "md";
}

export function InterviewStatusBadge({ status, size = "sm" }: Props) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, className: "bg-gray-50 text-gray-700 border-gray-200" };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border font-semibold uppercase tracking-wider",
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-xs",
        cfg.className,
      )}
    >
      {cfg.label}
    </span>
  );
}

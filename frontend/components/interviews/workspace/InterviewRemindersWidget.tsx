"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { getInterviewReminders } from "@/lib/api/interviews";
import type { InterviewReminder, ReminderStatus } from "@/lib/api/types";

// ── Status helpers ─────────────────────────────────────────────────────────

const STATUS_ICON: Record<ReminderStatus, React.ReactNode> = {
  scheduled:  <Clock className="w-3 h-3 text-blue-500" />,
  processing: <Loader2 className="w-3 h-3 text-amber-500 animate-spin" />,
  sent:       <CheckCircle2 className="w-3 h-3 text-green-500" />,
  skipped:    <BellOff className="w-3 h-3 text-gray-400" />,
  failed:     <XCircle className="w-3 h-3 text-red-500" />,
  cancelled:  <XCircle className="w-3 h-3 text-gray-400" />,
};

const STATUS_LABEL: Record<ReminderStatus, string> = {
  scheduled:  "Scheduled",
  processing: "Sending…",
  sent:       "Sent",
  skipped:    "Skipped",
  failed:     "Failed",
  cancelled:  "Cancelled",
};

function fmtDatetime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Component ──────────────────────────────────────────────────────────────

export function InterviewRemindersWidget({ interviewId }: { interviewId: string }) {
  const [reminders, setReminders] = useState<InterviewReminder[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getInterviewReminders(interviewId)
      .then((data) => { if (!cancelled) setReminders(data); })
      .catch(() => { if (!cancelled) setReminders([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [interviewId]);

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-gray-400 py-1">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading reminders…
      </div>
    );
  }

  if (!reminders || reminders.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-gray-400 py-1">
        <BellOff className="w-3.5 h-3.5" />
        No reminders scheduled
      </div>
    );
  }

  // Group by recipient_type for cleaner display
  const groups: Record<string, InterviewReminder[]> = {};
  for (const r of reminders) {
    const key = r.recipient_type;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }

  return (
    <div className="space-y-2">
      {Object.entries(groups).map(([recipientType, rows]) => (
        <div key={recipientType}>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1 capitalize">
            {recipientType}
          </p>
          <div className="space-y-1">
            {rows.map((r) => (
              <div
                key={r.id}
                className="flex items-start justify-between gap-2 text-xs"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  {STATUS_ICON[r.status]}
                  <span className="font-medium text-gray-700">
                    {r.reminder_type === "24h" ? "24 hr" : "1 hr"}
                  </span>
                  <span className="text-gray-400 truncate max-w-[90px]" title={r.recipient_email}>
                    → {r.recipient_email.split("@")[0]}…
                  </span>
                </div>
                <div className="text-right shrink-0">
                  <span
                    className={`text-[10px] font-medium ${
                      r.status === "sent" ? "text-green-600" :
                      r.status === "failed" ? "text-red-500" :
                      r.status === "cancelled" || r.status === "skipped" ? "text-gray-400" :
                      "text-blue-500"
                    }`}
                  >
                    {STATUS_LABEL[r.status]}
                  </span>
                  {r.sent_at ? (
                    <p className="text-[9px] text-gray-400">{fmtDatetime(r.sent_at)}</p>
                  ) : (
                    <p className="text-[9px] text-gray-400">{fmtDatetime(r.scheduled_for)}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

import { Loader2 } from "lucide-react";

export default function DashboardLoading() {
  return (
    <div className="flex h-full min-h-[50vh] w-full flex-col items-center justify-center gap-3">
      <Loader2 className="h-8 w-8 animate-spin text-[#FF5A1F]" />
      <p className="text-sm font-medium text-slate-500">Loading...</p>
    </div>
  );
}

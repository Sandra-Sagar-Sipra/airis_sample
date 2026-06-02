import * as React from "react";
import { cn } from "@/lib/utils";

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  variant?: "default" | "secondary" | "outline" | "destructive";
};

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
        variant === "default" && "border-transparent bg-slate-900 text-white",
        variant === "secondary" && "border-transparent bg-slate-100 text-slate-700",
        variant === "outline" && "border border-slate-300 bg-white text-slate-700",
        variant === "destructive" && "border-transparent bg-red-100 text-red-700",
        className
      )}
      {...props}
    />
  );
}

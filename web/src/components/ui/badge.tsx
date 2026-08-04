import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

const tones = {
  neutral: "bg-neutral-100 text-neutral-700",
  green: "bg-emerald-100 text-emerald-800",
  amber: "bg-amber-100 text-amber-900",
  red: "bg-red-100 text-red-700",
  blue: "bg-blue-100 text-blue-800",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: keyof typeof tones;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn("inline-flex h-6 items-center rounded-full px-2 text-xs font-medium", tones[tone], className)}>
      {children}
    </span>
  );
}

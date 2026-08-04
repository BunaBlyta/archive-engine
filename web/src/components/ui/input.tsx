import * as React from "react";
import { cn } from "../../lib/utils";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm outline-none transition-colors placeholder:text-neutral-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-neutral-100",
        className
      )}
      {...props}
    />
  );
}

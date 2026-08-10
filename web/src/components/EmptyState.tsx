import type { ReactNode } from "react";

export function EmptyState({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="grid h-full min-h-[14rem] place-items-center p-8 text-center">
      <div>
        <div className="mx-auto grid h-10 w-10 place-items-center rounded-md bg-neutral-100 text-neutral-600">{icon}</div>
        <h3 className="mt-3 text-base">{title}</h3>
        <p className="mt-1 max-w-sm text-sm text-neutral-500">{text}</p>
      </div>
    </div>
  );
}

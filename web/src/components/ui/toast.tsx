import * as ToastPrimitive from "@radix-ui/react-toast";
import { cn } from "../../lib/utils";

export const ToastProvider = ToastPrimitive.Provider;
export const ToastViewport = (props: React.ComponentProps<typeof ToastPrimitive.Viewport>) => (
  <ToastPrimitive.Viewport
    className="fixed bottom-4 right-4 z-50 flex w-[min(calc(100vw-2rem),24rem)] flex-col gap-2"
    {...props}
  />
);

export function Toast({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Root>) {
  return (
    <ToastPrimitive.Root
      className={cn("rounded-md border border-neutral-200 bg-white p-4 shadow-lg", className)}
      {...props}
    />
  );
}

export const ToastTitle = (props: React.ComponentProps<typeof ToastPrimitive.Title>) => (
  <ToastPrimitive.Title className="text-sm font-semibold text-neutral-950" {...props} />
);

export const ToastDescription = (props: React.ComponentProps<typeof ToastPrimitive.Description>) => (
  <ToastPrimitive.Description className="mt-1 text-sm text-neutral-600" {...props} />
);

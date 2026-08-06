import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-transparent px-3 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500",
  {
    variants: {
      variant: {
        default: "bg-gradient-to-b from-accent-400 to-accent-600 text-white shadow-[0_1px_2px_rgba(0,0,0,0.05),0_0_0_0_rgba(114,50,245,0)] transition-shadow hover:from-accent-400 hover:to-accent-700 hover:shadow-[0_4px_16px_-2px_rgba(114,50,245,0.5)]",
        secondary: "border-neutral-100 bg-white text-neutral-900 shadow-sm hover:bg-neutral-100",
        ghost: "text-neutral-700 hover:bg-neutral-100",
        danger: "bg-red-600 text-white hover:bg-red-700",
      },
      size: {
        default: "h-9 px-3",
        sm: "h-8 px-2.5 text-xs",
        icon: "h-9 w-9 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>
  & VariantProps<typeof buttonVariants>
  & { asChild?: boolean };

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

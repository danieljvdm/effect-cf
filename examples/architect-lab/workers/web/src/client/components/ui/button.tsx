import { Button as BaseButton } from "@base-ui-components/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex h-10 min-w-0 items-center justify-center gap-2 rounded-md px-3 text-sm font-semibold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-teal-500 disabled:pointer-events-none disabled:opacity-55",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-10 px-3",
        sm: "h-8 px-2.5 text-xs",
        icon: "size-9 px-0",
      },
      variant: {
        default: "border border-teal-800 bg-teal-700 text-white hover:bg-teal-800",
        outline: "border border-slate-300 bg-white text-slate-950 hover:bg-slate-50",
        ghost: "bg-transparent text-slate-700 hover:bg-slate-100",
      },
    },
  },
);

export type ButtonProps = React.ComponentProps<typeof BaseButton> &
  VariantProps<typeof buttonVariants>;

export const Button = ({ className, size, variant, ...props }: ButtonProps) => (
  <BaseButton className={cn(buttonVariants({ size, variant }), className)} {...props} />
);

import type * as React from "react";

import { cn } from "../../lib/utils.js";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = ({ className, ...props }: TextareaProps) => (
  <textarea
    className={cn(
      "min-h-28 w-full min-w-0 resize-y rounded-md border border-slate-300 bg-white px-3 py-2 text-sm leading-6 text-slate-950 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-teal-500",
      className,
    )}
    {...props}
  />
);

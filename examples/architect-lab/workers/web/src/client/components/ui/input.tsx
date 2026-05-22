import { Input as BaseInput } from "@base-ui-components/react/input";
import type * as React from "react";

import { cn } from "../../lib/utils";

export type InputProps = React.ComponentProps<typeof BaseInput>;

export const Input = ({ className, ...props }: InputProps) => (
  <BaseInput
    className={cn(
      "h-10 w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-950 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-teal-500",
      className,
    )}
    {...props}
  />
);

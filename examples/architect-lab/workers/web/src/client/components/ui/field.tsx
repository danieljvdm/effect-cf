import { Field } from "@base-ui-components/react/field";
import type * as React from "react";

import { cn } from "../../lib/utils.js";

export const FieldRoot = ({ className, ...props }: React.ComponentProps<typeof Field.Root>) => (
  <Field.Root className={cn("grid gap-1.5", className)} {...props} />
);

export const FieldLabel = ({ className, ...props }: React.ComponentProps<typeof Field.Label>) => (
  <Field.Label
    className={cn("text-xs font-bold uppercase tracking-wider text-slate-600", className)}
    {...props}
  />
);

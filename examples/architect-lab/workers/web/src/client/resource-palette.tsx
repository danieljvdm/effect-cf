import { Plus } from "lucide-react";

import type { ArchitectureResourceTemplate } from "@architect-lab/domain/architecture";

import { resourceColorClass } from "./lib/resource-colors";
import { cn } from "./lib/utils";

export type ResourcePaletteProps = {
  readonly disabled: boolean;
  readonly onAddResource: (template: ArchitectureResourceTemplate) => void;
  readonly templates: ReadonlyArray<ArchitectureResourceTemplate>;
};

export const ResourcePalette = ({ disabled, onAddResource, templates }: ResourcePaletteProps) => (
  <section
    aria-label="Resource palette"
    className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3"
  >
    <h2 className="text-xs font-bold uppercase tracking-wider text-slate-600">Resources</h2>
    <div className="grid min-h-0 content-start gap-2 overflow-auto pr-1">
      {templates.map((template) => (
        <button
          className="grid min-h-16 w-full grid-cols-[16px_minmax(0,1fr)_20px] items-start gap-2 rounded-md border border-slate-300 bg-white p-2.5 text-left transition-colors hover:border-slate-500 hover:bg-slate-50 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-teal-500 disabled:pointer-events-none disabled:opacity-55"
          disabled={disabled}
          key={template.kind}
          onClick={() => onAddResource(template)}
          type="button"
        >
          <span
            aria-hidden="true"
            className={cn(
              "mt-1 size-3.5 rounded-full border border-slate-950/15",
              resourceColorClass[template.color],
            )}
          />
          <span className="grid min-w-0 gap-1">
            <span className="truncate text-sm font-bold leading-tight text-slate-950">
              {template.label}
            </span>
            <span className="text-xs leading-4 text-slate-600">{template.description}</span>
          </span>
          <Plus aria-hidden="true" className="mt-0.5 size-4 text-slate-500" />
        </button>
      ))}
    </div>
  </section>
);

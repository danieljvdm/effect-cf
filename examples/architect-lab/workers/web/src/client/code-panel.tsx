import { Code2 } from "lucide-react";
import { highlight } from "sugar-high";

import type { ArchitectureReadModelInput } from "@architect-lab/domain/architecture";
import { renderEdgeSnippet, renderResourceSnippet } from "@architect-lab/domain/snippets";

import type { ArchitectureSelection } from "./lib/read-model";

export type CodePanelProps = {
  readonly readModel: ArchitectureReadModelInput;
  readonly selection: ArchitectureSelection | null;
};

export const CodePanel = ({ readModel, selection }: CodePanelProps) => {
  const snippet =
    selection === null
      ? ""
      : selection.type === "resource"
        ? renderResourceSnippet(selection.resource)
        : renderEdgeSnippet(selection.edge, readModel.resources);
  const highlightedSnippet = snippet === "" ? "" : highlight(snippet);
  const title =
    selection === null
      ? "Code"
      : selection.type === "resource"
        ? selection.resource.name
        : (selection.edge.label ?? selection.edge.kind);
  const subtitle =
    selection === null
      ? "Select a semantic resource or edge"
      : selection.type === "resource"
        ? selection.resource.bindingName
        : `${selection.edge.sourceId} -> ${selection.edge.targetId}`;

  return (
    <section
      aria-label="Generated code"
      className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3"
    >
      <div className="flex items-end justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h2 className="truncate text-base font-bold leading-tight text-slate-950">{title}</h2>
          <p className="truncate text-xs text-slate-600">{subtitle}</p>
        </div>
        <Code2 aria-hidden="true" className="size-4 shrink-0 text-slate-500" />
      </div>
      {selection === null ? (
        <div className="grid min-h-56 place-items-center rounded-md border border-dashed border-slate-300 bg-white/70 p-5 text-center text-sm leading-6 text-slate-600">
          Add or select a resource or edge to inspect its effect-cf snippet.
        </div>
      ) : (
        <pre className="m-0 min-h-0 min-w-0 overflow-auto rounded-md bg-[#101418] p-3 text-xs leading-6 text-slate-100">
          <code dangerouslySetInnerHTML={{ __html: highlightedSnippet }} />
        </pre>
      )}
    </section>
  );
};

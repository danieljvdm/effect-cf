import type { Plugin } from "rolldown";

export const bundleGraph = (): Plugin => ({
  name: "effect-cf:bundle-report-graph",
  generateBundle(_options, bundle) {
    this.emitFile({
      type: "asset",
      fileName: "graph.json",
      source: JSON.stringify({
        chunks: Object.values(bundle)
          .filter((output) => output.type === "chunk")
          .map((chunk) => ({
            file: chunk.fileName,
            entry: chunk.isEntry,
            sourceModules: Object.keys(chunk.modules),
          })),
        loadedModules: [...this.getModuleIds()],
      }),
    });
  },
});

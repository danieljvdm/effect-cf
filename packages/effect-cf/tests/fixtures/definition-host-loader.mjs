// Only the unavailable host module is substituted. Package modules use Node's
// native ESM linker unchanged, and the fixture never executes host operations.
export const resolve = (specifier, context, nextResolve) => {
  if (specifier === "cloudflare:workers") {
    return nextResolve(new URL("../cloudflare-workers.ts", import.meta.url).href, context);
  }
  if (specifier === "cloudflare:workflows") {
    return nextResolve(new URL("../cloudflare-workflows.ts", import.meta.url).href, context);
  }

  return nextResolve(specifier, context);
};

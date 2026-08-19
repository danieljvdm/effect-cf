#!/usr/bin/env bash
# Cloud Agent install for the effect-cf monorepo.
#
# Idempotent bootstrap that mirrors CI (.github/workflows/check.yml):
#   1. install the pinned Bun toolchain and expose it on PATH,
#   2. restore workspace dependencies from the committed lockfile,
#   3. run the locked Dev Kit setup (Effect source checkout + tsgo patch),
#   4. expose the Vite+ CLI (`vp`) on PATH,
#   5. build the publishable packages so examples consume their `dist` output.
#
# Safe to re-run: every step is a no-op when its result is already present.
set -euo pipefail

BUN_VERSION="1.3.14"

# Prefer sudo for the shared /usr/local/bin symlinks, but tolerate running as
# root (no sudo needed) or an image without sudo.
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

# 1. Install the pinned Bun (the repo's packageManager) if it is missing.
if ! command -v bun >/dev/null 2>&1 && [ ! -x "${HOME}/.bun/bin/bun" ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
fi
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

# Expose bun on the default PATH so non-login agent shells find it.
if [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; then
  $SUDO ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun
  $SUDO ln -sf "$BUN_INSTALL/bin/bunx" /usr/local/bin/bunx
fi

# 2. Install workspace dependencies from the lockfile. Lifecycle scripts are
#    skipped here; the Dev Kit postinstall is run explicitly in --locked mode
#    below (matching CI's `--frozen-lockfile --ignore-scripts`).
bun install --frozen-lockfile --ignore-scripts

# 3. Run the locked Dev Kit setup. Two Cloud-Agent-specific overrides:
#    - VITE_GIT_HOOKS=0: Cursor owns core.hooksPath, so skip Vite+ git hooks
#      (Dev Kit refuses to replace another hook manager and would fail here).
#    - Filtered gitconfig: Cursor rewrites github.com URLs to an authenticated
#      x-access-token form, but Dev Kit verifies the (public) Effect source
#      checkout keeps its clean upstream origin. Drop the url.insteadOf rewrites
#      for this step only; the Effect repo is public and needs no token.
if [ -f "$HOME/.gitconfig" ]; then
  GITCFG_CLEAN="$(mktemp)"
  awk '
    /^\[url /   { inurl=1; next }
    /^\[/       { inurl=0; print; next }
    inurl       { next }
                { print }
  ' "$HOME/.gitconfig" > "$GITCFG_CLEAN"
  GIT_CONFIG_GLOBAL="$GITCFG_CLEAN" VITE_GIT_HOOKS=0 \
    bun ./node_modules/@danieljvdm/dev-kit/bin/dev-kit.mjs apply --locked
  rm -f "$GITCFG_CLEAN"
else
  VITE_GIT_HOOKS=0 bun ./node_modules/@danieljvdm/dev-kit/bin/dev-kit.mjs apply --locked
fi

# 4. Expose the Vite+ CLI (`vp`), the repository's command authority, on PATH.
if [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; then
  $SUDO ln -sf "$PWD/node_modules/.bin/vp" /usr/local/bin/vp
fi

# 5. Build the publishable packages (mirrors CI's build step; warms vp cache).
vp run effect-cf#build
vp run effect-webtransport#build

#!/usr/bin/env bash
# Builds the universal release tarball (dist + assets + flat production
# node_modules). Shared by .github/workflows/release.yml and local testing:
#   bash scripts/package-release.sh
# CI sets EXPECT_TAG=<tag> so a tag/version mismatch fails before any release.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

version="$(node -p "require('./package.json').version")"

# src/cli.ts hardcodes VERSION separately from package.json; --version lies
# after a bump unless they move together.
grep -q "const VERSION = \"$version\"" src/cli.ts \
  || { echo "error: src/cli.ts VERSION != package.json version ($version)" >&2; exit 1; }
if [[ -n "${EXPECT_TAG:-}" && "$EXPECT_TAG" != "v$version" ]]; then
  echo "error: tag $EXPECT_TAG does not match package.json version v$version" >&2
  exit 1
fi

# Build from clean — a stale local dist/ would ship deleted modules.
rm -rf dist release
pnpm build

# Stage the tarball layout. assets/ must stay a sibling of dist/ (hook-install
# resolves ../assets from the compiled module) and package.json must ship (its
# "type": "module" is what makes dist/*.js load as ESM).
stage="release/stage/even-better"
mkdir -p "$stage"
cp package.json pnpm-lock.yaml LICENSE README.md SECURITY.md "$stage/"
cp -R dist assets "$stage/"

# A fresh hoisted install gives a flat, copyable node_modules that still honors
# the lockfile; the repo's own tree is pnpm's symlink farm and cannot be tarred.
# (optional=false would skip the download too, but it breaks pnpm 10's
# frozen-lockfile validation — ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY — so the
# optionals are installed and then deleted. --ignore-workspace stops pnpm from
# walking up to the repo's pnpm-workspace.yaml and installing into the repo
# root instead of the stage.)
(cd "$stage" && pnpm install --prod --frozen-lockfile --ignore-workspace \
  --config.node-linker=hoisted)
rm "$stage/pnpm-lock.yaml"
rm -rf "$stage/node_modules/.pnpm" "$stage/node_modules/.modules.yaml" \
  "$stage/node_modules/.pnpm-workspace-state.json"
chmod +x "$stage/dist/cli.js"

# The SDK's per-platform prebuilt `claude` binaries (~260MB each) never run:
# owned mode always spawns the user's PATH-resolved CLI via
# pathToClaudeCodeExecutable. Dropping them is what keeps the tarball universal.
rm -rf "$stage/node_modules/@anthropic-ai/claude-agent-sdk-"*
if compgen -G "$stage/node_modules/@anthropic-ai/claude-agent-sdk-*" > /dev/null; then
  echo "error: platform optionalDependencies leaked into the stage" >&2
  exit 1
fi
node "$stage/dist/cli.js" --help > /dev/null

tarball="even-better-v$version.tar.gz"
tar -czf "release/$tarball" -C release/stage even-better
(cd release && { sha256sum "$tarball" 2>/dev/null || shasum -a 256 "$tarball"; } > SHA256SUMS)

# Well under 50MB with optionals omitted; past it means they snuck back in.
size=$(wc -c < "release/$tarball")
if [[ "$size" -ge $((50 * 1024 * 1024)) ]]; then
  echo "error: tarball is $size bytes — platform optionals probably leaked" >&2
  exit 1
fi

echo "built release/$tarball ($(du -h "release/$tarball" | cut -f1))"

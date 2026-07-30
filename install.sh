#!/usr/bin/env bash
# even-better installer.
#   curl -fsSL https://raw.githubusercontent.com/inhesrom/even-better/main/install.sh | bash
#
# Env overrides:
#   EVEN_BETTER_VERSION      release tag to install (e.g. v0.1.0); default: latest
#   EVEN_BETTER_INSTALL_DIR  default: ~/.local/share/even-better
#   EVEN_BETTER_TARBALL      local tarball path; skips download + checksum (testing)
set -euo pipefail

REPO="inhesrom/even-better"

fail() { echo "error: $*" >&2; exit 1; }

# Everything runs from main, invoked on the last line, so a truncated
# `curl | bash` download executes nothing.
main() {
  case "$(uname -s)" in
    Linux | Darwin) ;;
    MINGW* | MSYS* | CYGWIN*) fail "Windows is not supported; use WSL and re-run there." ;;
    *) fail "unsupported platform: $(uname -s)" ;;
  esac

  [ -n "${HOME:-}" ] || fail "HOME is not set"
  command -v node > /dev/null 2>&1 \
    || fail "Node.js >= 18 is required but 'node' was not found. Install it from https://nodejs.org or your package manager, then re-run."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 18 ] || fail "Node.js >= 18 is required, found $(node -v)."
  command -v curl > /dev/null 2>&1 || fail "curl is required but was not found."

  local install_dir="${EVEN_BETTER_INSTALL_DIR:-$HOME/.local/share/even-better}"
  install_dir="${install_dir%/}"
  case "$install_dir" in
    /*) ;;
    *) fail "EVEN_BETTER_INSTALL_DIR must be an absolute path" ;;
  esac
  local bin_dir="$HOME/.local/bin"
  # Not local: the EXIT trap runs after main returns, when locals are gone
  # and set -u would abort the trap.
  tmp="$(mktemp -d)"
  staging=""
  trap 'rm -rf "$tmp" ${staging:+"$staging"}' EXIT
  local tarball

  if [ -n "${EVEN_BETTER_TARBALL:-}" ]; then
    tarball="$EVEN_BETTER_TARBALL"
    [ -f "$tarball" ] || fail "EVEN_BETTER_TARBALL not found: $tarball"
  else
    # The latest tag comes from the releases/latest redirect — no JSON API
    # (unauthenticated rate limits) and no jq. latest/download/<asset> alone
    # can't work because the asset name embeds the version. With no published
    # release the redirect lands on the /releases index (HTTP 200, no /tag/),
    # so the tag is trusted only when the URL actually contains one.
    local version="${EVEN_BETTER_VERSION:-}"
    if [ -z "$version" ]; then
      local url
      url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
        "https://github.com/$REPO/releases/latest")" \
        || fail "could not reach github.com; set EVEN_BETTER_VERSION=vX.Y.Z and re-run"
      case "$url" in
        */releases/tag/*) version="${url##*/tag/}" ;;
        *) fail "no published release found; set EVEN_BETTER_VERSION=vX.Y.Z and re-run" ;;
      esac
    fi
    case "$version" in
      v*) ;;
      *) version="v$version" ;;
    esac
    local base="https://github.com/$REPO/releases/download/$version"
    local name="even-better-$version.tar.gz"
    echo "downloading even-better $version ..."
    curl -fsSL -o "$tmp/$name" "$base/$name" \
      || fail "download failed: $base/$name — does release $version exist?"
    curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" \
      || fail "download failed: $base/SHA256SUMS"
    # Linux ships sha256sum, macOS ships shasum; a missing tool must not read
    # as a failed verification, and the checker's diagnostics stay on stderr.
    if command -v sha256sum > /dev/null 2>&1; then
      (cd "$tmp" && sha256sum -c SHA256SUMS > /dev/null) \
        || fail "checksum verification failed"
    elif command -v shasum > /dev/null 2>&1; then
      (cd "$tmp" && shasum -a 256 -c SHA256SUMS > /dev/null) \
        || fail "checksum verification failed"
    else
      fail "no sha256 tool found (install coreutils or perl)"
    fi
    tarball="$tmp/$name"
  fi

  # Extract next to the destination: /tmp is usually another filesystem, and a
  # cross-device mv is a copy that can die halfway. On the same filesystem the
  # final swap is a rename, so a failure at any point leaves the old install
  # intact — in place or at .old — never half-written.
  staging="$install_dir.new.$$"
  rm -rf "$staging"
  mkdir -p "$staging" "$bin_dir"
  tar -xzf "$tarball" -C "$staging"
  [ -f "$staging/even-better/dist/cli.js" ] || fail "unexpected tarball layout"
  chmod +x "$staging/even-better/dist/cli.js"

  rm -rf "$install_dir.old"
  if [ -e "$install_dir" ] || [ -L "$install_dir" ]; then
    mv "$install_dir" "$install_dir.old"
  fi
  mv "$staging/even-better" "$install_dir"
  rm -rf "$staging" "$install_dir.old"
  ln -sfn "$install_dir/dist/cli.js" "$bin_dir/even-better"

  echo "installed: $install_dir"
  echo "linked:    $bin_dir/even-better"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
      echo
      echo "note: $bin_dir is not on your PATH. Add this to your shell profile:"
      echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
      ;;
  esac
  "$bin_dir/even-better" --version
}

main "$@"

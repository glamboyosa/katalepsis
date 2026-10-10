#!/bin/sh

set -eu

# Everything runs inside main, so a download cut short by the network runs nothing.
main() {
  install_dir=${KATALEPSIS_INSTALL_DIR:-"$HOME/.local/bin"}
  source_dir=${KATALEPSIS_SOURCE_DIR:-"$HOME/.local/share/katalepsis"}
  repo_url=${KATALEPSIS_REPO_URL:-https://github.com/glamboyosa/katalepsis.git}
  ref=${KATALEPSIS_REF:-main}
  # The launchers embed these paths, so relative ones are made absolute.
  case "$install_dir" in /*) ;; *) install_dir="$PWD/$install_dir" ;; esac
  case "$source_dir" in /*) ;; *) source_dir="$PWD/$source_dir" ;; esac

  for command_name in git node; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      echo "katalepsis: $command_name is required" >&2
      exit 1
    fi
  done

  if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)'; then
    echo "katalepsis: Node 22.12 or newer is required (found $(node --version))" >&2
    exit 1
  fi

  # pnpm comes from PATH, or from corepack, which ships with Node 22.
  if command -v pnpm >/dev/null 2>&1; then
    pnpm_command=pnpm
  elif command -v corepack >/dev/null 2>&1; then
    pnpm_command="corepack pnpm"
  else
    echo "katalepsis: pnpm is required. Install it with: npm install -g pnpm" >&2
    exit 1
  fi

  # The launchers embed these paths in double quotes, so characters the shell would expand are refused.
  for checked_path in "$source_dir" "$install_dir" "$(command -v node)"; do
    case "$checked_path" in
      *'"'* | *'$'* | *'`'* | *\\*)
        echo "katalepsis: unsupported character in path: $checked_path" >&2
        exit 1
        ;;
    esac
  done

  if [ -d "$source_dir/.git" ]; then
    echo "Updating $source_dir"
    git -C "$source_dir" remote set-url origin "$repo_url"
    git -C "$source_dir" fetch --quiet --depth 1 origin "$ref"
    git -C "$source_dir" checkout --quiet --force FETCH_HEAD
  elif [ -e "$source_dir" ]; then
    echo "katalepsis: $source_dir exists and is not a katalepsis checkout" >&2
    exit 1
  else
    echo "Cloning $repo_url into $source_dir"
    mkdir -p "$(dirname "$source_dir")"
    git clone --quiet --depth 1 --branch "$ref" "$repo_url" "$source_dir"
  fi

  echo "Building katalepsis"
  (
    cd "$source_dir"
    # stdin is this script when it is piped from curl, so commands must not read from it.
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 $pnpm_command install --frozen-lockfile --silent </dev/null
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 $pnpm_command build </dev/null
  )

  # Launchers call this Node by full path, because MCP clients often start
  # servers without the shell's PATH (nvm, fnm and Homebrew installs).
  node_path=$(command -v node)
  mkdir -p "$install_dir"
  for name in katalepsis katalepsis-mcp; do
    case "$name" in
      katalepsis) entry="$source_dir/packages/cli/dist/main.js" ;;
      katalepsis-mcp) entry="$source_dir/packages/mcp/dist/main.js" ;;
    esac
    if [ ! -f "$entry" ]; then
      echo "katalepsis: the build did not produce $entry" >&2
      exit 1
    fi
    printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$node_path" "$entry" >"$install_dir/$name"
    chmod 0755 "$install_dir/$name"
  done

  echo "Installed katalepsis $("$install_dir/katalepsis" --version) to $install_dir"
  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
      echo "$install_dir is not on PATH. Add this line to your shell profile:"
      echo "  export PATH=\"$install_dir:\$PATH\""
      ;;
  esac
}

main "$@"

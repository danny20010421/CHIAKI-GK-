#!/usr/bin/env bash
# 離線環境用：npm registry 無法連線時，從本機既有套件建立 node_modules（以 symlink）。
# 有網路時請改用 `npm install`，此腳本即不需要。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${NPM_TOOLS_DIR:-/opt/npm-tools/node_modules}"
NM="$ROOT/node_modules"
mkdir -p "$NM/@types" "$NM/.bin"
link() { ln -sfn "$1" "$2"; }
link "$SRC/zod" "$NM/zod"
link "$SRC/typescript" "$NM/typescript"
link "$SRC/tsx" "$NM/tsx"
link "$SRC/esbuild" "$NM/esbuild"
link "$SRC/@types/node" "$NM/@types/node"
link "$SRC/undici-types" "$NM/undici-types"
link "$ROOT/vendor/postgres" "$NM/postgres"
link "../typescript/bin/tsc" "$NM/.bin/tsc"
link "../tsx/dist/cli.mjs" "$NM/.bin/tsx"
echo "offline node_modules ready: zod $(node -p "require('$SRC/zod/package.json').version"), typescript $(node -p "require('$SRC/typescript/package.json').version"), tsx $(node -p "require('$SRC/tsx/package.json').version"), postgres 3.4.7 (vendored)"

#!/usr/bin/env bash
# Build Fieldscope release artifacts into ./release:
#
#   fieldscope-<ver>.tar.gz                    — install bundle (source, no deps)
#   fieldscope-<ver>-portable-<os>-<arch>.tar.gz — portable bundle (deps baked in)
#
# The install bundle is small and platform-neutral: unpack, `./install.sh`
# (runs `npm ci --omit=dev` for the server), then `./fieldscope.sh`.
#
# The portable bundle carries the server's production node_modules already built
# for the host platform (native better-sqlite3 included), so it runs on an
# air-gapped box with only a Node runtime present — unpack and `./fieldscope.sh`,
# no install step, no network.
#
# Usage:  scripts/package-release.sh          (both bundles)
#         scripts/package-release.sh install  (install bundle only)
#         scripts/package-release.sh portable (portable bundle only)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VER="$(node -p "require('./package.json').version")"
PLATFORM="$(node -p "process.platform + '-' + process.arch")"
WHAT="${1:-all}"
OUT="$ROOT/release"
NAME="fieldscope-$VER"

log() { printf '\033[36m[release]\033[0m %s\n' "$*"; }

# ---- 1. Build the client -----------------------------------------------------
log "building client (vite)…"
(cd client && npm run build >/dev/null)

# ---- 2. Stage the common bundle layout --------------------------------------
STAGE="$OUT/.stage/$NAME"
log "staging $NAME …"
rm -rf "$OUT/.stage"
mkdir -p "$STAGE/server" "$STAGE/client"

# Server: source + manifests only — no test/, no data/, no node_modules.
cp -r server/src "$STAGE/server/src"
cp -r server/rulepacks "$STAGE/server/rulepacks"
cp server/index.js server/package.json server/package-lock.json "$STAGE/server/"

# Built client + docs + top-level files.
cp -r client/dist "$STAGE/client/dist"
cp -r docs "$STAGE/docs"
cp README.md LICENSE "$STAGE/"
printf '%s\n' "$VER" > "$STAGE/VERSION"

# Cross-platform launchers.
cat > "$STAGE/fieldscope.sh" <<'LAUNCH'
#!/usr/bin/env sh
# Start Fieldscope. Evidence persists in ./data unless FIELDSCOPE_DATA is set.
DIR=$(cd "$(dirname "$0")" && pwd)
export FIELDSCOPE_DATA="${FIELDSCOPE_DATA:-$DIR/data}"
export PORT="${PORT:-5100}"
export NODE_ENV="${NODE_ENV:-production}"
echo "Fieldscope on http://localhost:$PORT  (data: $FIELDSCOPE_DATA)"
exec node "$DIR/server/index.js" "$@"
LAUNCH
chmod +x "$STAGE/fieldscope.sh"

cat > "$STAGE/fieldscope.cmd" <<'LAUNCH'
@echo off
set DIR=%~dp0
if not defined FIELDSCOPE_DATA set FIELDSCOPE_DATA=%DIR%data
if not defined PORT set PORT=5100
if not defined NODE_ENV set NODE_ENV=production
echo Fieldscope on http://localhost:%PORT%  (data: %FIELDSCOPE_DATA%)
node "%DIR%server\index.js" %*
LAUNCH

mkdir -p "$OUT"

# ---- 3. Install bundle (no node_modules) ------------------------------------
if [ "$WHAT" = "all" ] || [ "$WHAT" = "install" ]; then
  log "packing install bundle…"
  cat > "$STAGE/install.sh" <<'INST'
#!/usr/bin/env sh
DIR=$(cd "$(dirname "$0")" && pwd)
echo "Installing Fieldscope server dependencies (production only)…"
(cd "$DIR/server" && npm ci --omit=dev)
echo "Done. Start with ./fieldscope.sh"
INST
  chmod +x "$STAGE/install.sh"
  cat > "$STAGE/install.cmd" <<'INST'
@echo off
cd /d "%~dp0server"
echo Installing Fieldscope server dependencies (production only)...
call npm ci --omit=dev
echo Done. Start with fieldscope.cmd
INST
  tar -C "$OUT/.stage" -czf "$OUT/$NAME.tar.gz" "$NAME"
  rm -f "$STAGE/install.sh" "$STAGE/install.cmd"
  log "→ release/$NAME.tar.gz"
fi

# ---- 4. Portable bundle (deps baked in for this platform) -------------------
if [ "$WHAT" = "all" ] || [ "$WHAT" = "portable" ]; then
  log "packing portable bundle ($PLATFORM)…"
  PSTAGE="$OUT/.stage-portable/$NAME"
  rm -rf "$OUT/.stage-portable"
  mkdir -p "$OUT/.stage-portable"
  cp -r "$STAGE" "$PSTAGE"
  log "installing server production deps for $PLATFORM (native better-sqlite3)…"
  (cd "$PSTAGE/server" && npm ci --omit=dev >/dev/null)
  cat > "$PSTAGE/PORTABLE.txt" <<TXT
Fieldscope $VER — portable bundle for $PLATFORM.
Dependencies (including the native SQLite module) are baked in for this platform.
Run ./fieldscope.sh (or fieldscope.cmd on Windows). Requires only a Node.js >= 20 runtime.
TXT
  tar -C "$OUT/.stage-portable" -czf "$OUT/$NAME-portable-$PLATFORM.tar.gz" "$NAME"
  log "→ release/$NAME-portable-$PLATFORM.tar.gz"
fi

rm -rf "$OUT/.stage" "$OUT/.stage-portable"
log "done. artifacts in ./release:"
ls -1sh "$OUT" | grep -E '\.tar\.gz$' || true

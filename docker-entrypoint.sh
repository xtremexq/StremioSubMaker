#!/bin/sh
set -e

# ============================================================================
# SubMaker Docker Entrypoint
#
# Handles two scenarios:
#   1. Running as root (default, no `user:` in compose):
#      Creates directories, fixes ownership to PUID:PGID, drops privileges
#      via su-exec, then execs the main command as the target user.
#
#   2. Running as non-root (via `user: PUID:PGID` in compose):
#      Best-effort directory creation and write-access checks with
#      actionable error messages if directories aren't writable.
#
# For bind mounts, Docker creates host directories as root when they
# don't exist. Scenario 1 handles this automatically. Scenario 2
# requires the user to pre-create directories with correct ownership.
# ============================================================================

TARGET_UID="${PUID:-1000}"
TARGET_GID="${PGID:-1000}"

DIRS="/app/.cache /app/data /app/logs /app/keys"
CACHE_SUBDIRS="translations translations_bypass translations_partial sync_cache"
TZ_NAME="${TZ#:}"

apply_timezone() {
  if [ -z "$TZ_NAME" ]; then
    return
  fi

  if [ -f "/usr/share/zoneinfo/$TZ_NAME" ]; then
    ln -snf "/usr/share/zoneinfo/$TZ_NAME" /etc/localtime
    printf '%s\n' "$TZ_NAME" > /etc/timezone
  fi
}

# ── ROOT PATH: fix permissions and drop privileges ──────────────────
if [ "$(id -u)" = "0" ]; then
  apply_timezone

  # Create all directories
  for dir in $DIRS; do
    mkdir -p "$dir"
  done
  for subdir in $CACHE_SUBDIRS; do
    mkdir -p "/app/.cache/$subdir"
  done

  # Fix ownership so the target user can write
  chown -R "$TARGET_UID:$TARGET_GID" /app/.cache /app/data /app/logs /app/keys

  # Drop to target user and re-exec this script (enters non-root path)
  exec su-exec "$TARGET_UID:$TARGET_GID" "$0" "$@"
fi

# ── NON-ROOT PATH: best-effort create + verify ─────────────────────
HAS_ERRORS=0

for dir in $DIRS; do
  mkdir -p "$dir" 2>/dev/null || true
done
for subdir in $CACHE_SUBDIRS; do
  mkdir -p "/app/.cache/$subdir" 2>/dev/null || true
done

for dir in $DIRS; do
  if [ -d "$dir" ]; then
    if ! touch "$dir/.write-test" 2>/dev/null; then
      HAS_ERRORS=1
      echo ""
      echo "============================================================"
      echo "  ERROR: Directory $dir is NOT writable"
      echo "  Current user: $(id)"
      echo ""
      echo "  FIX: Remove 'user:' from docker-compose and use PUID/PGID"
      echo "  environment variables instead (recommended). The entrypoint"
      echo "  will fix permissions automatically when running as root."
      echo ""
      echo "  Or run on the host:"
      echo "    chown -R $(id -u):$(id -g) <host-path-for-$dir>"
      echo "============================================================"
      echo ""
    else
      rm -f "$dir/.write-test" 2>/dev/null || true
    fi
  else
    HAS_ERRORS=1
    echo "WARNING: Directory $dir does not exist and could not be created."
    echo "Current user: $(id)"
  fi
done

if [ "$HAS_ERRORS" = "1" ]; then
  echo ""
  echo "SubMaker: Permission errors detected. The addon may not work correctly."
  echo "See messages above for details on how to fix."
  echo ""
fi

exec "$@"

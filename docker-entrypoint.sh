#!/bin/sh
set -e

# ============================================================================
# SubMaker Docker Entrypoint
# Ensures required directories exist and are writable before starting the app.
# This handles the common case where bind-mounted volumes have incorrect
# ownership (e.g., when using `user: ${PUID}:${PGID}` in docker-compose).
# ============================================================================

DIRS="/app/.cache /app/data /app/logs /app/keys"
CACHE_SUBDIRS="translations translations_bypass translations_partial sync_cache"

HAS_ERRORS=0

# Create top-level directories
for dir in $DIRS; do
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir" 2>/dev/null || true
  fi
done

# Create cache subdirectories (without isolation prefix — the app will create
# isolation-prefixed subdirs at runtime, but these are needed for legacy compat)
for subdir in $CACHE_SUBDIRS; do
  target="/app/.cache/$subdir"
  if [ ! -d "$target" ]; then
    mkdir -p "$target" 2>/dev/null || true
  fi
done

# Test write access to each critical directory
for dir in $DIRS; do
  if [ -d "$dir" ]; then
    if ! touch "$dir/.write-test" 2>/dev/null; then
      HAS_ERRORS=1
      echo ""
      echo "============================================================"
      echo "  ERROR: Directory $dir is NOT writable"
      echo "  Current user: $(id)"
      echo ""
      echo "  If using 'user: PUID:PGID' in docker-compose, run this"
      echo "  on the HOST to fix permissions:"
      echo ""
      echo "    chown -R \$(id -u):\$(id -g) <host-path-for-$dir>"
      echo ""
      echo "  Or remove the 'user:' directive to use the default"
      echo "  'node' user (UID 1000)."
      echo "============================================================"
      echo ""
    else
      rm -f "$dir/.write-test" 2>/dev/null || true
    fi
  else
    HAS_ERRORS=1
    echo ""
    echo "WARNING: Directory $dir does not exist and could not be created."
    echo "Current user: $(id)"
    echo ""
  fi
done

if [ "$HAS_ERRORS" = "1" ]; then
  echo ""
  echo "SubMaker: Permission errors detected. The addon may not work correctly."
  echo "See messages above for details on how to fix."
  echo ""
fi

# Hand off to the main command
exec "$@"

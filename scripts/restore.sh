#!/usr/bin/env bash
# Restore a backup:
#   DATABASE_URL="postgresql://..." ./scripts/restore.sh backup_YYYYmmdd_HHMMSS.sql.gz
# or (local):  PGDATABASE=turnidsp ./scripts/restore.sh file.sql.gz
set -euo pipefail
FILE="$1"
if [ -n "${DATABASE_URL:-}" ]; then
  echo "Restoring $FILE via DATABASE_URL ..."
  gunzip -c "$FILE" | psql "$DATABASE_URL"
else
  DB="${PGDATABASE:-turnidsp}"
  echo "Restoring $FILE into $DB ..."
  gunzip -c "$FILE" | psql "$DB"
fi
echo "Done."

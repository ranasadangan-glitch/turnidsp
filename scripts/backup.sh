#!/usr/bin/env bash
# Automatic PostgreSQL backup for TurniDSP.
# Works with either DATABASE_URL (Render/Railway/Heroku) or discrete PG* vars.
#
# Cron example (daily 02:00, keep 30 days):
#   0 2 * * * DATABASE_URL="postgresql://..." BACKUP_DIR=/var/backups/turnidsp \
#     /path/TurniDSP-Platform/scripts/backup.sh >> /var/log/turnidsp-backup.log 2>&1
set -euo pipefail

DIR="${BACKUP_DIR:-/var/backups/turnidsp}"
KEEP_DAYS="${KEEP_DAYS:-30}"
mkdir -p "$DIR"
TS=$(date +%Y%m%d_%H%M%S)

if [ -n "${DATABASE_URL:-}" ]; then
  NAME="turnidsp"
  FILE="$DIR/${NAME}_${TS}.sql.gz"
  echo "[$(date)] Backing up via DATABASE_URL -> $FILE"
  pg_dump "$DATABASE_URL" | gzip > "$FILE"
else
  DB="${PGDATABASE:-turnidsp}"
  FILE="$DIR/${DB}_${TS}.sql.gz"
  echo "[$(date)] Backing up $DB -> $FILE"
  pg_dump "$DB" | gzip > "$FILE"
fi

# also back up uploaded PDFs if present
UPLOADS="${UPLOAD_DIR:-./server/uploads}"
if [ -d "$UPLOADS" ]; then
  tar czf "$DIR/uploads_${TS}.tar.gz" -C "$(dirname "$UPLOADS")" "$(basename "$UPLOADS")"
fi

# retention
find "$DIR" -name "*.gz" -mtime +"$KEEP_DAYS" -delete
echo "[$(date)] Backup complete. Old backups (> ${KEEP_DAYS}d) purged."

#!/usr/bin/env bash
# archive_option_snapshots.sh — Archive old option_snapshots partitions (> 90 days)
#
# Detaches monthly partitions whose data range is entirely older than 90 days,
# exports them via pg_dump / COPY, then optionally drops the detached table.
#
# Usage:
#   ./scripts/archive_option_snapshots.sh [--dry-run] [--drop-after-export]
#
# Prerequisites:
#   - PGHOST, PGPORT, PGDATABASE, PGUSER env vars or ~/.pgpass
#   - Partitions follow naming: option_snapshots_yYYYYmMM
#
# This is a TEMPLATE — review and adapt before running in production.
set -euo pipefail

DRY_RUN=false
DROP_AFTER=false
ARCHIVE_DIR="${ARCHIVE_DIR:-/tmp/option_snapshots_archive}"
RETENTION_DAYS="${RETENTION_DAYS:-90}"

for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --drop-after-export) DROP_AFTER=true ;;
  esac
done

cutoff=$(date -d "-${RETENTION_DAYS} days" +%Y-%m-01 2>/dev/null || date -v-${RETENTION_DAYS}d +%Y-%m-01)
echo "Cutoff date (partitions ending before this are eligible): $cutoff"

mkdir -p "$ARCHIVE_DIR"

partitions=$(psql -Atc "
  SELECT inhrelid::regclass::text
  FROM pg_inherits
  WHERE inhparent = 'option_snapshots'::regclass
  ORDER BY 1
" 2>/dev/null || true)

for part in $partitions; do
  # Extract year and month from partition name: option_snapshots_y2026m01
  if [[ "$part" =~ option_snapshots_y([0-9]{4})m([0-9]{2}) ]]; then
    y="${BASH_REMATCH[1]}"
    m="${BASH_REMATCH[2]}"
    part_end="${y}-${m}-01"
    # Partition covers [start, start+1month); eligible if end <= cutoff
    part_end_next=$(date -d "${part_end} +1 month" +%Y-%m-%d 2>/dev/null || date -j -v+1m -f "%Y-%m-%d" "$part_end" +%Y-%m-%d)

    if [[ "$part_end_next" < "$cutoff" || "$part_end_next" == "$cutoff" ]]; then
      echo "Eligible: $part (range ends $part_end_next, before cutoff $cutoff)"
      if $DRY_RUN; then
        echo "  [DRY RUN] Would detach, export, and optionally drop $part"
      else
        echo "  Detaching..."
        psql -c "ALTER TABLE option_snapshots DETACH PARTITION $part;"
        echo "  Exporting to $ARCHIVE_DIR/${part}.sql.gz ..."
        pg_dump -t "$part" --data-only | gzip > "$ARCHIVE_DIR/${part}.sql.gz"
        if $DROP_AFTER; then
          echo "  Dropping detached table $part ..."
          psql -c "DROP TABLE IF EXISTS $part;"
        else
          echo "  Kept detached table $part (use --drop-after-export to remove)"
        fi
      fi
    fi
  fi
done

echo "Done."

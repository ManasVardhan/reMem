#!/usr/bin/env bash
# Copy the reMem provider into a MemoryBench checkout and register it.
# Usage: bash eval/memorybench/apply.sh /path/to/memorybench
set -euo pipefail

MB="${1:-}"
if [ -z "$MB" ] || [ ! -f "$MB/package.json" ]; then
  echo "usage: bash eval/memorybench/apply.sh /path/to/memorybench" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$MB/src/providers/remem"
cp "$HERE/provider/index.ts"      "$MB/src/providers/remem/index.ts"
cp "$HERE/provider/index.test.ts" "$MB/src/providers/remem/index.test.ts"
echo "copied provider into $MB/src/providers/remem/"

for p in "$HERE"/provider/*.patch; do
  target="$MB/$(basename "$p" .patch | tr '_' '/')"
  if patch -p0 --forward --silent "$target" < "$p" 2>/dev/null; then
    echo "patched $target"
  else
    echo "SKIPPED $target (already applied, or the upstream file changed)" >&2
  fi
done

echo
echo "done. verify with:  cd $MB && bun test"

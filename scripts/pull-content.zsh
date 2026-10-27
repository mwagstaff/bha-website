#!/usr/bin/env zsh
# Copies the content edited on the website (the events and page text) into
# content/<site>/events.txt and pages.json and commits it, so edits made in the
# editor end up in git. It runs scripts/export-content.js on the server, which
# reads them from wherever the site keeps them (files or Mongo); if that script
# isn't deployed there yet, the files are copied instead.
#
#   scripts/pull-content.zsh [live|preview] [--no-commit]
#
# Defaults to the live site. Where the forms are sent (private page-text
# settings) is left out, because the repository is public. Only the copied
# files are committed; anything else staged is left as it is.
set -euo pipefail

site=live
commit=1
for arg in "$@"; do
  case "$arg" in
    live) site=live ;;
    preview) site=preview ;;
    --no-commit) commit=0 ;;
    *) echo "Usage: $0 [live|preview] [--no-commit]" >&2; exit 2 ;;
  esac
done

case "$site" in
  live) host=sky; node_bin='~/.local/share/bha-website/runtime/node24/bin/node' ;;
  preview) host=mini; node_bin=/opt/homebrew/bin/node ;;
esac
remote_dir='~/.local/share/bha-website'
app_dir='~/dev/bha-website'

repo=${0:A:h:h}
dest="$repo/content/$site"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$repo"

echo "==> Copying content from the $site site ($host)..."
# The site's own environment (data folder, storage, Mongo address), as its service gets it.
remote="cd $app_dir && test -f scripts/export-content.js || exit 3; set -a; for f in .static-config-*.env.sh .bw-secrets.env.sh; do [ -f \"\$f\" ] && . \"./\$f\"; done; set +a; $node_bin scripts/export-content.js"
set +e
ssh -o ConnectTimeout=10 "$host" "$remote" >"$tmp/export.json" 2>"$tmp/export.err"
exit_code=$?
set -e
if (( exit_code == 0 )); then
  node --input-type=module -e '
    import fs from "node:fs";
    const [dir] = process.argv.slice(1);
    const { storage, events, pages } = JSON.parse(fs.readFileSync(`${dir}/export.json`, "utf8"));
    if (!events) { console.error("Error: the site returned no events."); process.exit(1); }
    fs.writeFileSync(`${dir}/events.txt`, events);
    if (pages) fs.writeFileSync(`${dir}/pages.json`, pages);
    console.log(`    (read from ${storage === "mongo" ? "Mongo" : "files"})`);
  ' "$tmp"
elif (( exit_code == 3 )); then
  # Not deployed there yet: copy the files.
  if ! rsync -a --timeout=20 "$host:$remote_dir/events.txt" "$tmp/" 2>"$tmp/rsync.err"; then
    echo "Error: couldn't copy events.txt from $host:" >&2
    cat "$tmp/rsync.err" >&2
    exit 1
  fi
  # pages.json only exists once someone has saved page text.
  rsync -a --timeout=20 "$host:$remote_dir/pages.json" "$tmp/" 2>/dev/null || true
else
  echo "Error: couldn't read the content on $host:" >&2
  cat "$tmp/export.err" >&2
  exit 1
fi

mkdir -p "$dest"
cp "$tmp/events.txt" "$dest/events.txt"
if [[ -f "$tmp/pages.json" ]]; then
  node --input-type=module -e '
    import fs from "node:fs";
    import { parseFileText, withoutPrivate, toFileText } from "./lib/pages.js";
    const [from, to] = process.argv.slice(1);
    const saved = parseFileText(fs.readFileSync(from, "utf8"));
    if (!saved) { console.error(`Error: ${from} could not be understood; not copied.`); process.exit(1); }
    fs.writeFileSync(to, toFileText(withoutPrivate(saved)));
  ' "$tmp/pages.json" "$dest/pages.json" 2>&1 || exit 1
fi

paths=("content/$site")
git add -- "${paths[@]}"
if git diff --cached --quiet -- "${paths[@]}"; then
  echo "==> No content changes on the $site site since the last pull."
  exit 0
fi

echo "==> Content changed on the $site site:"
git --no-pager diff --cached --stat -- "${paths[@]}"
if (( ! commit )); then
  echo "==> Not committed (--no-commit); see: git diff --cached -- content/$site"
  exit 0
fi
git commit --quiet -m "Content from the $site site, $(date '+%Y-%m-%d %H:%M')" -- "${paths[@]}"
echo "==> Committed: $(git log -1 --format='%h %s')"

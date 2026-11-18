#!/bin/bash
# Auto-deploy for Commander Life. Run by a cPanel cron job every few minutes.
# 1) looks for a new commit on GitHub  2) if there is one, copies commander/ into the live folder
# 3) purges the Cloudflare cache for the app files (only if /home/alpacaqr/.commander-cf exists)
export PATH=/usr/local/bin:/usr/bin:/bin
REPO=/home/alpacaqr/repositories/commander-life
LIVE=/home/alpacaqr/public_html/commander
LOG=/home/alpacaqr/deploy-commander.log
cd "$REPO" || exit 1

# Only one run at a time: if a previous run is still going (say GitHub is slow), this one just skips.
if command -v flock >/dev/null 2>&1; then exec 9>/home/alpacaqr/.deploy-commander.lock; flock -n 9 || exit 0; fi
# Never let a check hang: give up on GitHub after 60 seconds and try again on the next run.
T=""; command -v timeout >/dev/null 2>&1 && T="timeout 60"

$T git fetch -q origin main 2>>"$LOG" || { echo "$(date '+%F %T') fetch failed" >> "$LOG"; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0   # nothing new

git reset -q --hard origin/main && /bin/mkdir -p "$LIVE" && /bin/cp -Rf commander/. "$LIVE"/ \
  && echo "$(date '+%F %T') deployed $(git rev-parse --short HEAD): $(git log -1 --format=%s)" >> "$LOG"

# Cloudflare purge (the token only has permission to purge cache; it lives only on this server)
if [ -f /home/alpacaqr/.commander-cf ]; then
  . /home/alpacaqr/.commander-cf    # defines CF_ZONE and CF_TOKEN
  curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE/purge_cache" \
    -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
    --data '{"files":["https://alpacaqr.com/commander/","https://alpacaqr.com/commander/index.html","https://alpacaqr.com/commander/sw.js","https://alpacaqr.com/commander/manifest.json"]}' \
    | grep -q '"success":true' && echo "$(date '+%F %T') cloudflare purged" >> "$LOG" || echo "$(date '+%F %T') cloudflare purge FAILED" >> "$LOG"
fi

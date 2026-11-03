#!/usr/bin/env bash
# Runs INSIDE the container that tools/docker/pw.sh starts; not meant to be run on the host.
#
# 1. As root (the image's default user): give the host user ownership of the fresh, root-owned node_modules volume, then
#    continue as the host's uid:gid, so that files written into the mounted repository (docs/results, .cache) belong to the
#    host user and not to root. setpriv needs no passwd entry for the uid.
# 2. As that user: install the dependencies with `npm ci` into the volume when the volume is empty or stale (the stamp is
#    the lockfile's hash plus the image's Node version and architecture), then exec the command.
set -euo pipefail

export HOME=/work/.cache/docker-home
host_uid="${PB_HOST_UID:-0}"
host_gid="${PB_HOST_GID:-$host_uid}"

if [ "$(id -u)" = "0" ] && [ "$host_uid" != "0" ]; then
  [ "$(stat -c %u /work/node_modules)" = "$host_uid" ] || chown "$host_uid:$host_gid" /work/node_modules
  exec setpriv --reuid="$host_uid" --regid="$host_gid" --clear-groups -- bash "$0" "$@"
fi

mkdir -p "$HOME"
cd /work

# Serialise installs: two first runs at once must not both run npm ci into the same volume. The lock lives outside
# node_modules because npm ci empties that directory. The subshell closes the lock's descriptor before the command starts.
(
  flock 9
  stamp="$(sha256sum package-lock.json | cut -d' ' -f1) $(node -v) $(uname -m)"
  if [ "$(cat node_modules/.pb-docker-stamp 2>/dev/null || true)" != "$stamp" ]; then
    echo "[docker:pw] the node_modules volume is empty or stale: running npm ci (once per lockfile change)" >&2
    npm ci --no-audit --no-fund
    printf '%s' "$stamp" >node_modules/.pb-docker-stamp
  fi
) 9>"$HOME/.pb-install.lock"

exec "$@"

#!/usr/bin/env bash
# docker:pw - run a command inside the Playwright Linux image with this repository mounted at /work.
#
#   npm run docker:pw -- [--cpus N] [--dry-run] [--clean] <command> [args...]
#   npm run docker:pw -- npm run codec-matrix -- --browsers chromium,firefox,webkit
#
# Why: Playwright's Firefox does not start on the macOS development host, and CI is Linux. This is how Firefox runs
# locally and how the Linux environment is reproduced. Details and trade-offs: docs/decisions/codecs.md (ADR-036).
#
#   --cpus N     CPU limit of the container (default 4, or $PB_DOCKER_CPUS)
#   --dry-run    print the docker commands instead of running them
#   --clean      remove this checkout's node_modules volume (the next run reinstalls) and exit
#
# Environment passed into the container when set on the host: PB_ENV_ID, PB_PORT, PB_ORIGIN, PB_WORKERS, CI, and the names
# listed in $PB_DOCKER_ENV (space separated). The container sees PB_DOCKER_PW=1.
# Exit codes: the command's own; 2 usage; 3 image/package.json mismatch or missing tool.
set -euo pipefail

# Must equal the @playwright/test version pinned in package.json: the browsers in the image are the ones that version drives.
# Checked on every run below and by tests/unit/probe/docker-pw.test.ts.
PW_IMAGE="mcr.microsoft.com/playwright:v1.64.1-noble"

die() {
  local code="$1"
  shift
  echo "docker:pw: $*" >&2
  exit "$code"
}

usage() {
  # The header comment of this file is the help text.
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

cpus="${PB_DOCKER_CPUS:-4}"
dry_run=0
clean=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cpus)
      [ $# -ge 2 ] || die 2 "--cpus needs a value"
      cpus="$2"
      shift 2
      ;;
    --cpus=*)
      cpus="${1#--cpus=}"
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --clean)
      clean=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*) die 2 "unknown option: $1 (put -- before a command that starts with a dash)" ;;
    *) break ;;
  esac
done

[[ "$cpus" =~ ^[0-9]+([.][0-9]+)?$ ]] && awk "BEGIN { exit !($cpus > 0) }" || die 2 "--cpus must be a positive number, got '$cpus'"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

command -v node >/dev/null 2>&1 || die 3 "node is needed on the host to check the pinned Playwright version"
pinned="$(node -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String((p.devDependencies || {})["@playwright/test"] || ""))' "$root/package.json")"
image_tag="${PW_IMAGE##*:}"
image_version="${image_tag#v}"
image_version="${image_version%%-*}"
if [ "$pinned" != "$image_version" ]; then
  die 3 "the image tag ($PW_IMAGE) does not match the pinned @playwright/test ('$pinned'). Update PW_IMAGE in tools/docker/pw.sh together with package.json."
fi

# One node_modules volume per checkout (a worktree is a different path, so it gets its own): the container's Linux
# dependencies never overwrite the host's, and two checkouts never share an install.
slug="$(printf '%s' "${root##*/}" | tr -c 'A-Za-z0-9_.-' '-' | cut -c1-30)"
digest="$( (printf '%s' "$root" | shasum -a 256 2>/dev/null || printf '%s' "$root" | sha256sum) | cut -c1-10)"
volume="pb-nm-${slug}-${digest}"

if [ "$clean" = 1 ]; then
  if [ "$dry_run" = 1 ]; then
    printf 'docker volume rm -f %q\n' "$volume"
  else
    docker volume rm -f "$volume"
  fi
  exit 0
fi

[ $# -gt 0 ] || {
  usage >&2
  die 2 "no command given"
}

host_uid="$(id -u)"
host_gid="$(id -g)"
name="pb-pw-$$-$(date +%s)"

args=(run --rm --init --name "$name" --ipc=host "--cpus=$cpus" -w /work
  -v "$root:/work" -v "$volume:/work/node_modules"
  -e "PB_HOST_UID=$host_uid" -e "PB_HOST_GID=$host_gid" -e PB_DOCKER_PW=1 -e "PB_DOCKER_CPUS=$cpus")
extra_env=()
read -r -a extra_env <<<"${PB_DOCKER_ENV:-}" || true
for var in PB_ENV_ID PB_PORT PB_ORIGIN PB_WORKERS CI ${extra_env[@]+"${extra_env[@]}"}; do
  args+=(-e "$var") # without a value docker copies it from the host, and only when it is set there
done
# A worktree's git directory lives outside the mounted checkout, so the container cannot ask git itself: the host answers.
# Same exclusions as src/lab/probe/host-info.ts: generated results do not make the tree "dirty".
if git_commit="$(git -C "$root" rev-parse --short HEAD 2>/dev/null)" && [ -n "$git_commit" ]; then
  git_dirty=0
  if [ -n "$(git -C "$root" status --porcelain -- . ':(exclude)docs/results' ':(exclude)docs/CODEC_MATRIX.md' 2>/dev/null)" ]; then
    git_dirty=1
  fi
  args+=(-e "PB_GIT_COMMIT=$git_commit" -e "PB_GIT_DIRTY=$git_dirty")
fi
[ -t 0 ] && [ -t 1 ] && args+=(-i -t)
args+=("$PW_IMAGE" bash /work/tools/docker/pw-entry.sh "$@")

if [ "$dry_run" = 1 ]; then
  printf 'docker volume create %q\n' "$volume"
  printf 'docker'
  printf ' %q' "${args[@]}"
  printf '\n'
  exit 0
fi

command -v docker >/dev/null 2>&1 || die 3 "docker is not installed or not on the PATH"
docker info >/dev/null 2>&1 || die 3 "the docker daemon is not reachable (is Docker Desktop running?)"

# The mount point must exist and belong to the host user (docker would create it as root on a Linux host).
mkdir -p "$root/node_modules"
docker volume create "$volume" >/dev/null

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

if [ -t 0 ] && [ -t 1 ]; then
  docker "${args[@]}"
else
  # Not interactive: run in the background and wait, so that a TERM sent to this script removes the container at once
  # (a foreground child would delay the trap until it exits).
  docker "${args[@]}" </dev/null &
  child=$!
  set +e
  wait "$child"
  status=$?
  set -e
  exit "$status"
fi

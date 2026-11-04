#!/usr/bin/env bash
# Puts the first mirror of the apt mirror list that is fast in front, when the first one is not.
#
# On 4 Nov 2026 the default mirror of the hosted runners (azure.archive.ubuntu.com) served packages at about 50 kB/s for a quarter of an hour
# (usually 50 MB/s): the 48.8 MB of an ffmpeg install, or of a browser's system libraries, took the whole 15 minutes of a job's timeout. Apt
# was not stalled, it was slow, so none of its timeouts (they act on silence) applies, and a kill from outside cannot be made clean (ADR-180).
# One real package of the mirror is fetched for at most 15 s, and the speed it came at decides.
#
# Variables (the defaults are the hosted runner's): PB_APT_MIRRORS_FILE, PB_APT_MIN_BYTES_PER_S, PB_APT_PROBE_SECONDS, PB_APT_SUDO.

set -u

mirrors_file=${PB_APT_MIRRORS_FILE:-/etc/apt/apt-mirrors.txt}
min_speed=${PB_APT_MIN_BYTES_PER_S:-1000000}
probe_seconds=${PB_APT_PROBE_SECONDS:-15}
sudo_cmd=${PB_APT_SUDO-sudo}
# 7.4 MB, in the release pocket of noble, which an LTS no longer changes; only its first 4 MiB are asked for.
probe_path=pool/universe/f/fonts-wqy-zenhei/fonts-wqy-zenhei_0.9.45-8_all.deb

# measure <mirror url, ending in a slash>: "<http status> <bytes per second>"; the status is 000 when nothing answered.
measure() {
  local out status speed
  out=$(curl -sS -r 0-4194303 --connect-timeout 5 --max-time "$probe_seconds" -o /dev/null -w '%{http_code} %{speed_download}' "$1$probe_path" 2> /dev/null || true)
  status=${out%% *}
  speed=${out#* }
  speed=${speed%%.*}
  printf '%s %s\n' "${status:-000}" "${speed:-0}"
}

if [ ! -r "$mirrors_file" ]; then
  echo "apt mirror: no mirror list at $mirrors_file; nothing to choose from"
  exit 0
fi

mirrors=()
while IFS=$'\t' read -r url _ || [ -n "$url" ]; do
  [ -n "$url" ] && mirrors+=("$url")
done < "$mirrors_file"
if [ "${#mirrors[@]}" -lt 2 ]; then
  echo "apt mirror: ${#mirrors[@]} mirror in the list; nothing to choose between"
  exit 0
fi

read -r status speed <<< "$(measure "${mirrors[0]}")"
case "$status" in
  200 | 206 | 000) ;;
  *)
    echo "apt mirror: ${mirrors[0]} answered the probe with HTTP $status, which says nothing about its speed; the list is kept"
    exit 0
    ;;
esac
if [ "$status" != 000 ] && [ "$speed" -ge "$min_speed" ]; then
  echo "apt mirror: ${mirrors[0]} served the probe at $speed B/s (the limit is $min_speed); the list is kept"
  exit 0
fi
echo "::warning::apt mirror: ${mirrors[0]} served the probe at $speed B/s (HTTP $status; the limit is $min_speed B/s)"

chosen=''
for candidate in "${mirrors[@]:1}"; do
  read -r status speed <<< "$(measure "$candidate")"
  echo "apt mirror: $candidate served the probe at $speed B/s (HTTP $status)"
  if { [ "$status" = 200 ] || [ "$status" = 206 ]; } && [ "$speed" -ge "$min_speed" ]; then
    chosen=$candidate
    break
  fi
done
if [ -z "$chosen" ]; then
  echo "::warning::apt mirror: no other mirror of the list was fast either; the list is kept"
  exit 0
fi

{
  printf '%s\tpriority:1\n' "$chosen"
  n=1
  for url in "${mirrors[@]}"; do
    [ "$url" = "$chosen" ] && continue
    n=$((n + 1))
    printf '%s\tpriority:%s\n' "$url" "$n"
  done
} | $sudo_cmd tee "$mirrors_file" > /dev/null
echo "apt mirror: $chosen is now the first mirror of $mirrors_file"

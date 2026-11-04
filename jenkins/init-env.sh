#!/usr/bin/env bash
# Creates .env (git-ignored) from .env.example, with a random admin password for the Jenkins controller.
#
#   bash jenkins/init-env.sh
#
# Never overwrites an existing .env, and never prints the password: it is in the file (mode 600) and nowhere else.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"

if [ -e .env ]; then
  echo "init-env: .env exists and was left as it is"
  exit 0
fi
command -v openssl >/dev/null 2>&1 || {
  echo "init-env: openssl is needed to generate the password" >&2
  exit 1
}

umask 077
password="$(openssl rand -hex 16)"
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    JENKINS_ADMIN_PASSWORD=*) printf 'JENKINS_ADMIN_PASSWORD=%s\n' "$password" ;;
    *) printf '%s\n' "$line" ;;
  esac
done <.env.example >.env
echo "init-env: wrote .env with a random admin password (mode 600); the password is in that file only"

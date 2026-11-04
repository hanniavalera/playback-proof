#!/usr/bin/env bash
# The entry point of the agent container (ADR-116, ADR-117): waits for the controller, takes the connection secret the controller
# left in the shared volume, downloads agent.jar from the controller (so that the two always run the same version of the
# remoting protocol) and connects over WebSocket, on the port of the UI: no extra port is open anywhere.
#
#   JENKINS_URL         the controller, for example http://jenkins:8080/
#   JENKINS_AGENT_NAME  the node this agent is, as defined in jenkins/controller/casc.yaml
#   JENKINS_SECRET_FILE the secret (default /run/agent-secrets/<name>); it is passed to the agent as @file and never printed
set -euo pipefail

: "${JENKINS_URL:?JENKINS_URL is not set}"
: "${JENKINS_AGENT_NAME:?JENKINS_AGENT_NAME is not set}"
url="${JENKINS_URL%/}"
secret_file="${JENKINS_SECRET_FILE:-/run/agent-secrets/$JENKINS_AGENT_NAME}"
work_dir="${JENKINS_AGENT_WORKDIR:-/home/jenkins/agent}"
jar=/home/jenkins/agent.jar

log() { printf '[agent] %s\n' "$*"; }

# /login answers 200 to everyone once Jenkins has finished starting, and 503 while it starts.
until curl -fsS -o /dev/null "$url/login" 2>/dev/null; do
  log "waiting for the controller at $url"
  sleep 3
done
until [ -s "$secret_file" ]; do
  log "waiting for the controller to write the connection secret"
  sleep 2
done
curl -fsS -o "$jar" "$url/jnlpJars/agent.jar"

log "connecting as $JENKINS_AGENT_NAME to $url over WebSocket"
exec java -Xmx256m -jar "$jar" -url "$url" -name "$JENKINS_AGENT_NAME" -secret "@$secret_file" -webSocket -workDir "$work_dir"

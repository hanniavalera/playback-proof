# The Linux agent of the merge-gate lab (ADR-116): the Playwright image of the version package.json pins (it carries Chromium,
# Firefox and WebKit and the libraries they need) plus a Java runtime for the Jenkins agent and the ffmpeg of Ubuntu, which the
# media pipeline is verified against (docs/decisions/media.md). Node and npm are the image's. Built by docker-compose.yml.
# The tag must equal @playwright/test in package.json: tests/unit/jenkins checks it.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-21-jre-headless ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# The user is uid 1000, like the controller's: the connection secret the controller writes into the shared volume (mode 0600)
# is readable here. The image's own uid 1000 user ("ubuntu") makes room. /cache/streams is the mount point of the stream
# cache volume (ADR-118): a new volume takes the owner of the directory the image has there.
RUN userdel --remove ubuntu \
    && useradd --uid 1000 --user-group --create-home --shell /bin/bash jenkins \
    && mkdir -p /home/jenkins/agent /home/jenkins/.npm /cache/streams /run/agent-secrets \
    && chown -R jenkins:jenkins /home/jenkins /cache /run/agent-secrets \
    # The repository is mounted read-only and belongs to the host's user: git would refuse it as "dubious ownership".
    && git config --system --add safe.directory /repo

ENV NPM_CONFIG_UPDATE_NOTIFIER=false

COPY --chmod=0755 entrypoint.sh /usr/local/bin/agent-entrypoint

USER jenkins
WORKDIR /home/jenkins/agent
ENTRYPOINT ["/usr/local/bin/agent-entrypoint"]

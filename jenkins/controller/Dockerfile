# The Jenkins controller of the merge-gate lab (ADR-116, ADR-117): the LTS core with the pinned plugins, and the
# configuration as code that defines everything else. Built by docker-compose.yml; see jenkins/README.md.
FROM jenkins/jenkins:2.580.2-lts-jdk21

# No setup wizard: the security realm, the agent and the job come from casc.yaml. The git plugin refuses a file:// repository
# unless it is told otherwise; the one repository the job reads is mounted read-only at /repo (the job is defined in casc.yaml).
ENV JAVA_OPTS="-Djenkins.install.runSetupWizard=false -Dhudson.plugins.git.GitSCM.ALLOW_LOCAL_CHECKOUT=true"
ENV CASC_JENKINS_CONFIG=/usr/share/jenkins/casc.yaml

USER root
# The mounted repository belongs to the host's user, not to jenkins: git would refuse it as "dubious ownership".
# /run/agent-secrets is where the controller leaves the agent's connection secret (volume shared with the agent).
RUN git config --system --add safe.directory /repo \
    && mkdir -p /run/agent-secrets \
    && chown jenkins:jenkins /run/agent-secrets
USER jenkins

COPY --chown=jenkins:jenkins plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt

COPY --chown=jenkins:jenkins casc.yaml /usr/share/jenkins/casc.yaml
# Copied into JENKINS_HOME at every start (the .override suffix makes the image's copy win over an older one in the volume).
COPY --chown=jenkins:jenkins init.groovy.d/ /usr/share/jenkins/ref/init.groovy.d/

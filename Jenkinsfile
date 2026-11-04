// The merge gate of Playback Proof as a Jenkins pipeline. It runs the same `npm run gate:*` scripts as
// .github/workflows/ci.yml and adds no logic of its own: what a stage checks is defined in package.json, so the two CI
// systems cannot drift apart (ADR-115 in docs/decisions/ci-jenkins.md). To run it on a laptop: jenkins/README.md.
//
// Shape (ADR-116): the controller has no executors, so every build runs on an inbound agent that carries the label
// `playwright` (the Playwright image plus Java, ffmpeg and the Jenkins agent). `agent none` at the top, so that no
// executor sits idle while the engines wait for theirs. Install, Static, Unit and Streams are nested in one stage and
// share one workspace; each engine of the merge gate takes its own executor, with its own workspace (`dist/`,
// `reports/` and `test-results/` cannot clobber each other) and its own service port (the agent's executors share one
// network namespace).
//
// A later gate (perf, flake, triage) is one more block in `stages` with its own `sh 'npm run gate:<name>'` line.
// None exists here until its script does.

// Keeps what the engine runs produced (the failure attachments of docs/CONTRACTS.md 7.2 live in test-results/), then
// frees the workspace: the next build starts from a clean checkout. The JUnit step is a no-op until a JUnit report exists.
def collectResults() {
    archiveArtifacts artifacts: 'reports/**, test-results/**', allowEmptyArchive: true
    junit allowEmptyResults: true, testResults: 'reports/**/junit*.xml'
    cleanWs()
}

pipeline {
    agent none

    options {
        timestamps()
        ansiColor('xterm')
        timeout(time: 40, unit: 'MINUTES')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '15', artifactNumToKeepStr: '5'))
        // Every stage that has an agent checks out explicitly, so that the log says where the sources came from.
        skipDefaultCheckout(true)
    }

    environment {
        // retries: 1, workers: 2 and no reused server in playwright.config.ts; the same variable GitHub Actions sets.
        CI = 'true'
        // The one stream cache of the agent, a volume that outlives builds (ADR-118). The service reads it from this
        // variable; the generator takes the same directory as an argument (it does not read the variable).
        PB_CACHE_DIR = '/cache/streams'
    }

    stages {
        stage('Checks') {
            agent { label 'playwright' }
            stages {
                stage('Install') {
                    steps {
                        checkout scm
                        sh 'npm ci --no-audit --no-fund'
                        // The tools this agent really has: labelled lines, so that the evidence of a build reads them from its log.
                        sh '''
                            set +x
                            echo "tool-version node $(node --version)"
                            echo "tool-version npm $(npm --version)"
                            echo "tool-version ffmpeg $(ffmpeg -version | head -n 1)"
                            echo "tool-version java $(java -version 2>&1 | head -n 1)"
                            echo "tool-version playwright $(npx playwright --version)"
                        '''
                    }
                }
                stage('Static') {
                    steps {
                        sh 'npm run gate:static'
                    }
                }
                stage('Unit') {
                    // The repository's own limit (4 workers, vitest.config.ts) is sized for runners with more cores than this agent's
                    // quota of 3 CPUs: with it the media determinism test failed once under load (ADR-116, build 2 of the evidence).
                    environment {
                        VITEST_MAX_WORKERS = '2'
                    }
                    steps {
                        sh 'npm run gate:unit'
                    }
                }
                stage('Streams') {
                    steps {
                        // Idempotent: a complete cache is a no-op, so only the first build on a volume pays for ffmpeg.
                        sh 'npm run generate:streams -- --cache-dir "$PB_CACHE_DIR"'
                    }
                }
            }
            post {
                always {
                    script { collectResults() }
                }
            }
        }

        stage('Merge gate') {
            // Every engine reports, even when another one fails: a red build must say which engines are red.
            failFast false
            parallel {
                stage('chromium') {
                    agent { label 'playwright' }
                    environment {
                        PB_PORT = '4601'
                        PLAYWRIGHT_JSON_OUTPUT_FILE = 'reports/chromium/playwright.json'
                        PLAYWRIGHT_HTML_OUTPUT_DIR = 'reports/chromium/html'
                    }
                    steps {
                        checkout scm
                        sh 'npm ci --no-audit --no-fund'
                        sh 'npm run gate:merge -- --project=chromium'
                    }
                    post {
                        always {
                            script { collectResults() }
                        }
                    }
                }
                stage('firefox') {
                    agent { label 'playwright' }
                    environment {
                        PB_PORT = '4602'
                        PLAYWRIGHT_JSON_OUTPUT_FILE = 'reports/firefox/playwright.json'
                        PLAYWRIGHT_HTML_OUTPUT_DIR = 'reports/firefox/html'
                    }
                    steps {
                        checkout scm
                        sh 'npm ci --no-audit --no-fund'
                        sh 'npm run gate:merge -- --project=firefox'
                    }
                    post {
                        always {
                            script { collectResults() }
                        }
                    }
                }
                stage('chromium-cpu4x') {
                    agent { label 'playwright' }
                    environment {
                        PB_PORT = '4603'
                        PLAYWRIGHT_JSON_OUTPUT_FILE = 'reports/chromium-cpu4x/playwright.json'
                        PLAYWRIGHT_HTML_OUTPUT_DIR = 'reports/chromium-cpu4x/html'
                    }
                    steps {
                        checkout scm
                        sh 'npm ci --no-audit --no-fund'
                        sh 'npm run gate:merge -- --project=chromium-cpu4x'
                    }
                    post {
                        always {
                            script { collectResults() }
                        }
                    }
                }
                // Linux WebKit, an experimental engine (docs/CONTRACTS.md 7.3): it runs the specs and its tests carry the
                // `experimental-engine` annotation. It gates like the others; the macOS WebKit job of GitHub Actions has
                // no local equivalent (README of this setup).
                stage('webkit') {
                    agent { label 'playwright' }
                    environment {
                        PB_PORT = '4604'
                        PLAYWRIGHT_JSON_OUTPUT_FILE = 'reports/webkit/playwright.json'
                        PLAYWRIGHT_HTML_OUTPUT_DIR = 'reports/webkit/html'
                    }
                    steps {
                        checkout scm
                        sh 'npm ci --no-audit --no-fund'
                        sh 'npm run gate:merge -- --project=webkit'
                    }
                    post {
                        always {
                            script { collectResults() }
                        }
                    }
                }
            }
        }
    }
}

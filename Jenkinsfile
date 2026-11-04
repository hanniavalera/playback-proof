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
// `Perf` (gate:perf) measures the head against a control on the same agent, alone after the engines (ADR-179). `Flake` (gate:flake)
// judges the run files the engines stashed against the history on the `flake-history` volume, and records the build when it is a
// build of main (ADR-174 in docs/decisions/ci-flake.md). `Triage` (gate:triage) is the last stage and runs only when the build is
// not green: it explains the red, it never decides it.

// Keeps what the engine runs produced (the failure attachments of docs/CONTRACTS.md 7.2 live in test-results/), then
// frees the workspace: the next build starts from a clean checkout. The JUnit step is a no-op until a JUnit report exists.
// An engine of the merge gate also names the stash for its flake run files (reports/flake/run*.json): its workspace is its
// own and is wiped here, and the Flake stage reads the files of every engine from another one.
def collectResults(String flakeStash = '') {
    archiveArtifacts artifacts: 'reports/**, test-results/**', allowEmptyArchive: true
    junit allowEmptyResults: true, testResults: 'reports/**/junit*.xml'
    if (flakeStash != '') {
        stash name: flakeStash, includes: 'reports/flake/run*.json', allowEmpty: true
        // The Triage stage reads the Playwright report of every engine, with the flake run file beside it for the environment id.
        stash name: flakeStash.replace('flake-', 'triage-'), includes: 'reports/**/playwright*.json, reports/flake/run*.json', allowEmpty: true
    }
    cleanWs()
}

// A build of the main branch. The git plugin says `origin/main`, and `refs/heads/main` or `main` for other ways of defining a job:
// all of them are main. Only such a build is recorded in the flake history.
def isMainBranch(String branch) {
    return (branch ?: '') ==~ '(refs/heads/|refs/remotes/origin/|origin/)?main'
}

pipeline {
    agent none

    options {
        timestamps()
        ansiColor('xterm')
        timeout(time: 60, unit: 'MINUTES')
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
                        // A red engine does not skip the Flake stage: a build that failed is still judged (and recorded).
                        catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                            sh 'npm run gate:merge -- --project=chromium'
                        }
                    }
                    post {
                        always {
                            script { collectResults('flake-chromium') }
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
                        catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                            sh 'npm run gate:merge -- --project=firefox'
                        }
                    }
                    post {
                        always {
                            script { collectResults('flake-firefox') }
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
                        catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                            sh 'npm run gate:merge -- --project=chromium-cpu4x'
                        }
                    }
                    post {
                        always {
                            script { collectResults('flake-chromium-cpu4x') }
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
                        catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                            sh 'npm run gate:merge -- --project=webkit'
                        }
                    }
                    post {
                        always {
                            script { collectResults('flake-webkit') }
                        }
                    }
                }
            }
        }

        // The performance gate (docs/PERF.md, ADR-179): the head against a control measured on this same agent minutes earlier, so it
        // runs alone, after the engines and not beside them (a measurement beside another browser measures the neighbour). The
        // control is the first parent of the commit on main, and the commit itself on any other branch (an A/A: there is nothing
        // to compare with yet). A red gate does not skip the stages after it: the Flake and Triage stages still run.
        stage('Perf') {
            agent { label 'playwright' }
            environment {
                PB_PORT = '4605'
            }
            steps {
                script {
                    def scmVars = checkout scm
                    sh 'npm ci --no-audit --no-fund'
                    sh 'npm run build:player'
                    def control = isMainBranch(scmVars.GIT_BRANCH) ? 'HEAD^1' : 'HEAD'
                    catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                        withEnv(["CONTROL_REF=${control}"]) {
                            sh 'npm run gate:perf -- --paired --control-ref "$CONTROL_REF" --profile chromium,chromium-cpu4x'
                        }
                    }
                }
            }
            post {
                always {
                    script { collectResults() }
                }
            }
        }

        // The flake gate (docs/FLAKE.md, ADR-174): this build's runs, judged against the history of this environment, a file on the
        // `flake-history` volume. The engines above ran in workspaces of their own and stashed their run files; this stage lays them
        // side by side (the layout of GitHub's download step) and runs the script of the `flake` job. A build of main is recorded,
        // whatever its verdict, as the gate does by design (a history of the good builds only would understate the rate); a build of
        // any other branch is judged and forgotten, as a pull request is on GitHub.
        stage('Flake') {
            agent { label 'playwright' }
            environment {
                // The volume that outlives builds; the gate reads the directory from this variable (--store file).
                PB_FLAKE_HISTORY_DIR = '/history'
            }
            steps {
                script {
                    def scmVars = checkout scm
                    sh 'npm ci --no-audit --no-fund'
                    for (engine in ['chromium', 'firefox', 'chromium-cpu4x', 'webkit']) {
                        dir("reports/flake/${engine}") {
                            unstash "flake-${engine}"
                        }
                    }
                    // A red flake gate does not skip the Triage stage that follows: it is the one that explains a red build.
                    catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                        if (isMainBranch(scmVars.GIT_BRANCH)) {
                            sh 'npm run gate:flake -- --store file --runs reports/flake --record'
                        } else {
                            sh 'npm run gate:flake -- --store file --runs reports/flake'
                        }
                    }
                }
            }
            post {
                always {
                    script { collectResults() }
                }
            }
        }

        // Failure triage (docs/TRIAGE.md, ADR-160 to ADR-169), for a red build: it groups the failures of every engine by cause and
        // never decides anything: it is not a gate, it exits 0 whatever it finds. The engines above stashed their Playwright reports;
        // this stage lays them side by side (the layout of GitHub's download step) and runs the script of the `triage` job.
        stage('Triage') {
            when { expression { currentBuild.currentResult != 'SUCCESS' } }
            agent { label 'playwright' }
            steps {
                checkout scm
                sh 'npm ci --no-audit --no-fund'
                script {
                    for (engine in ['chromium', 'firefox', 'chromium-cpu4x', 'webkit']) {
                        dir("artifacts/${engine}") {
                            unstash "triage-${engine}"
                        }
                    }
                }
                sh 'npm run gate:triage -- --from artifacts --out reports/triage'
            }
            post {
                always {
                    script { collectResults() }
                }
            }
        }
    }
}

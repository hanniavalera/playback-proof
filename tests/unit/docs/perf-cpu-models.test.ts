import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The pages that tell how many CPU models GitHub's runners handed out in the A/A measurements are written by hand. The count comes from
// the machine record of each job (the `cpu:` line of docs/results/perf/<set>/raw/<job>/machine.txt) and the exit code of each pass
// (pass-<k>.json). This test counts both and fails when a page states another number, so a count cannot drift from the records again:
// it was once "six models" where the records of the 13 jobs name five (the sixth, the Xeon 8370C, is the machine the `chromium` baseline
// was recorded on, and no job of that set ran on it).

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
/** A page with its line breaks and runs of spaces folded, so that a sentence is found whatever its wrapping. */
const squashed = (path: string): string => read(path).replace(/\s+/g, ' ');

const WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
};
const numberOf = (word: string | undefined): number => WORDS[(word ?? '').toLowerCase()] ?? Number(word);

interface Job {
  name: string;
  /** `cpu:` line of the machine record, normalised: one name for one model, however the vendor spells it. */
  model: string;
  passes: number;
  regressions: number;
}

const modelOf = (cpu: string): string =>
  cpu
    .replace(/\(R\)/gi, '')
    .replace(/ CPU @ .*$/i, '')
    .replace(/ \d+-Core Processor$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

function jobsOf(set: string): Job[] {
  const raw = `docs/results/perf/${set}/raw`;
  return readdirSync(join(ROOT, raw), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name): Job => {
      const cpu = /^cpu: (.+)$/m.exec(read(`${raw}/${name}/machine.txt`))?.[1];
      if (cpu === undefined) throw new Error(`${raw}/${name}/machine.txt has no "cpu:" line`);
      const passes = readdirSync(join(ROOT, raw, name)).filter((file) => /^pass-\d+\.json$/.test(file));
      const exitCodes = passes.map(
        (file) => (JSON.parse(read(`${raw}/${name}/${file}`)) as { exitCode: number }).exitCode,
      );
      return {
        name,
        model: modelOf(cpu),
        passes: passes.length,
        regressions: exitCodes.filter((c) => c === 1).length,
      };
    });
}

/** The groups of the sentence the page must hold. A page that was reworded fails here, and the message says which sentence to find. */
function stated(page: string, file: string, pattern: RegExp): string[] {
  const match = pattern.exec(page);
  if (match === null) {
    throw new Error(
      `${file} has no sentence that matches ${pattern}: it was reworded; check its numbers against the machine records and update this test`,
    );
  }
  return match.slice(1);
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const distinct = (jobs: Job[]): string[] => [...new Set(jobs.map((job) => job.model))];

describe('the CPU models that the A/A pages count, from the machine records', () => {
  const crossVm = jobsOf('gha-cross-vm');
  const paired = jobsOf('paired-aa');
  const withRegressions = crossVm.filter((job) => job.regressions > 0);
  /** The one model that every regression of the committed-baseline set ran on. */
  const slow = withRegressions[0]?.model ?? '';
  const onSlow = crossVm.filter((job) => job.model === slow);
  const others = crossVm.filter((job) => job.model !== slow);

  it('reads 13 jobs of 3 passes on five models, and 12 paired jobs, none of the first set on the Xeon 8370C', () => {
    expect(crossVm).toHaveLength(13);
    expect(sum(crossVm.map((job) => job.passes))).toBe(39);
    expect(distinct(crossVm)).toHaveLength(5);
    expect(crossVm.some((job) => job.model.includes('8370c'))).toBe(false);
    expect(paired).toHaveLength(12);
    expect(sum(paired.map((job) => job.passes))).toBe(36);
    expect(distinct(paired)).toHaveLength(5);
  });

  it('finds every regression of the committed-baseline set on one model: the EPYC 7763', () => {
    expect(slow).toContain('7763');
    expect(sum(crossVm.map((job) => job.regressions))).toBe(8);
    expect(sum(onSlow.map((job) => job.regressions))).toBe(8);
    expect(sum(onSlow.map((job) => job.passes))).toBe(12);
    expect(sum(others.map((job) => job.passes))).toBe(27);
    expect(distinct(others)).toHaveLength(4);
  });

  it('gha-cross-vm.md says 13 jobs landed on five models, how many jobs each, and none ran on the 8370C', () => {
    const file = 'docs/results/perf/gha-cross-vm.md';
    const page = squashed(file);
    const [jobs, models] = stated(page, file, /the (\d+) jobs landed on (\w+) CPU models/);
    expect(Number(jobs)).toBe(crossVm.length);
    expect(numberOf(models)).toBe(distinct(crossVm).length);
    const [many, middle, one] = stated(
      page,
      file,
      /AMD EPYC 7763 and 9V74, (\d+) jobs each; AMD EPYC 9V45, (\d+) jobs; Intel Xeon 8573C and 6975P-C, (\d+) job each/,
    );
    const count = (key: string): number => crossVm.filter((job) => job.model.includes(key)).length;
    expect([count('7763'), count('9v74')]).toStrictEqual([Number(many), Number(many)]);
    expect(count('9v45')).toBe(Number(middle));
    expect([count('8573c'), count('6975p-c')]).toStrictEqual([Number(one), Number(one)]);
    expect(page).toContain(`none of the ${crossVm.length} jobs ran on it`);
    const [regressed, ofPasses, rest, otherModels] = stated(
      page,
      file,
      /(\d+) of the (\d+) passes on that model failed, none of the (\d+) passes on the other (\w+) models/,
    );
    expect(Number(regressed)).toBe(sum(onSlow.map((job) => job.regressions)));
    expect(Number(ofPasses)).toBe(sum(onSlow.map((job) => job.passes)));
    expect(Number(rest)).toBe(sum(others.map((job) => job.passes)));
    expect(numberOf(otherModels)).toBe(distinct(others).length);
  });

  it('ADR-178 and ADR-179 (perf-paired.md) say the same: 13 jobs, five models, the other four', () => {
    const file = 'docs/decisions/perf-paired.md';
    const page = squashed(file);
    const [models, jobs] = stated(page, file, /landed on (\w+) CPU models \([^)]*?: (\d+) jobs, counted/);
    expect(numberOf(models)).toBe(distinct(crossVm).length);
    expect(Number(jobs)).toBe(crossVm.length);
    expect(page).toContain(`none of the ${crossVm.length} jobs ran on`);
    const [rest, otherModels] = stated(page, file, /none of the (\d+) passes on the other (\w+) models did/);
    expect(Number(rest)).toBe(sum(others.map((job) => job.passes)));
    expect(numberOf(otherModels)).toBe(distinct(others).length);
    const [vms, failed, passes] = stated(
      page,
      file,
      /on (\d+) GitHub-hosted VMs three times each[^*]*\*\*(\d+) of the (\d+) passes failed with a reproduced regression/,
    );
    expect([Number(vms), Number(failed), Number(passes)]).toStrictEqual([13, 8, 39]);
  });

  it('PERF.md says the same, in its own words', () => {
    const file = 'docs/PERF.md';
    const page = squashed(file);
    const [vms, failed, passes] = stated(
      page,
      file,
      /on (\d+) different VMs, \*\*failed (\d+) of (\d+) passes/,
    );
    expect([Number(vms), Number(failed), Number(passes)]).toStrictEqual([13, 8, 39]);
    const [jobs, models] = stated(page, file, /The (\d+) jobs landed on (\w+) CPU models/);
    expect(Number(jobs)).toBe(crossVm.length);
    expect(numberOf(models)).toBe(distinct(crossVm).length);
  });

  it('paired-aa/README.md says how many of its twelve jobs ran on the EPYC 7763, and its passes', () => {
    const file = 'docs/results/perf/paired-aa/README.md';
    const page = squashed(file);
    expect(page).toContain(`on ${[...'twelve'].join('')} GitHub-hosted runners`);
    const [jobsOn, jobs, passesOn, passes] = stated(
      page,
      file,
      /\((\w+) of the (\w+) jobs ran on the AMD EPYC 7763: (\d+) of the (\d+) passes above\)/,
    );
    const onSlowPaired = paired.filter((job) => job.model.includes('7763'));
    expect(numberOf(jobsOn)).toBe(onSlowPaired.length);
    expect(numberOf(jobs)).toBe(paired.length);
    expect(Number(passesOn)).toBe(sum(onSlowPaired.map((job) => job.passes)));
    expect(Number(passes)).toBe(sum(paired.map((job) => job.passes)));
  });

  it('README.md says the same (Findings): 13 jobs, five models, a sixth that no job ran on, the other four', () => {
    const file = 'README.md';
    const page = squashed(file);
    const [jobs, models] = stated(page, file, /the (\d+) jobs of one A\/A landed on (\w+) CPU models/);
    expect(Number(jobs)).toBe(crossVm.length);
    expect(numberOf(models)).toBe(distinct(crossVm).length);
    expect(page).toContain('recorded on a sixth, the Intel Xeon 8370C, which none of them ran on');
    const [regressed, ofPasses, rest, otherModels] = stated(
      page,
      file,
      /(\d+) of its (\d+) passes; none of the (\d+) passes on the other (\w+)\)/,
    );
    expect(Number(regressed)).toBe(sum(onSlow.map((job) => job.regressions)));
    expect(Number(ofPasses)).toBe(sum(onSlow.map((job) => job.passes)));
    expect(Number(rest)).toBe(sum(others.map((job) => job.passes)));
    expect(numberOf(otherModels)).toBe(distinct(others).length);
  });
});

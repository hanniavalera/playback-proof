import type { TestInfo } from '@playwright/test';

/**
 * The numbers a run measured, kept as a `measured` annotation of its result (JSON, one object): a green run keeps its evidence in the
 * report, so the distribution of a live number over many runs (latency at the join, the cadence of the refreshes) is read from the
 * reports and not remembered. Annotations are attached to passed and failed results alike.
 */
export function recordMeasured(
  testInfo: Pick<TestInfo, 'annotations'>,
  values: Record<string, number | string | boolean | null | readonly (number | null)[]>,
): void {
  testInfo.annotations.push({ type: 'measured', description: JSON.stringify(values) });
}

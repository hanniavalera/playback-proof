// `npx tsx live/cdp-heap-probe.ts`: what Chromium answers to the DevTools calls that the soak's heap reading depends on, observed and not
// remembered (docs/decisions/readiness.md, ADR-157). One browser, one blank page, a few seconds.
//
//   1. Does `Performance.getMetrics` answer before `Performance.enable`?
//   2. Does `HeapProfiler.collectGarbage` work without `HeapProfiler.enable`, and does it lower `JSHeapUsedSize`?
//   3. Is `Performance.enable` per DevTools session, and is the collection the isolate's, whichever session asks for it?
//
// It prints what it saw, one line per observation. It decides nothing and writes no file.

import { chromium } from '@playwright/test';

interface Metric {
  name: string;
  value: number;
}

const MB = 1_048_576;

const heapOf = (answer: unknown): number | null => {
  const metrics = (answer as { metrics?: Metric[] }).metrics ?? [];
  const used = metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value;
  return used === undefined ? null : Math.round((used / MB) * 10) / 10;
};

const say = (what: string, value: unknown): void => {
  console.log(`${what.padEnd(78)} ${JSON.stringify(value)}`);
};

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('about:blank');
  const garbage = (): Promise<void> =>
    page.evaluate(() => {
      // 60 MB of arrays that nothing refers to afterwards: what a collection can free.
      for (let i = 0; i < 60; i++) new Array(1_000_000).fill(i).length;
    });
  say('browser', browser.version());

  const first = await context.newCDPSession(page);
  const before = (await first.send('Performance.getMetrics')) as { metrics: Metric[] };
  say('1. getMetrics before Performance.enable: metrics returned', before.metrics.length);
  say('1. getMetrics before Performance.enable: JSHeapUsedSize (MB)', heapOf(before));

  await first.send('Performance.enable');
  await garbage();
  const enabled = (await first.send('Performance.getMetrics')) as { metrics: Metric[] };
  say('1. getMetrics after Performance.enable: metrics returned', enabled.metrics.length);
  say(
    '1. getMetrics after Performance.enable: names',
    enabled.metrics.map((metric) => metric.name).slice(0, 40),
  );
  say('2. JSHeapUsedSize after making garbage, no collection yet (MB)', heapOf(enabled));

  await first.send('HeapProfiler.collectGarbage'); // no HeapProfiler.enable
  say(
    '2. JSHeapUsedSize after HeapProfiler.collectGarbage without HeapProfiler.enable (MB)',
    heapOf(await first.send('Performance.getMetrics')),
  );

  await garbage();
  const second = await context.newCDPSession(page);
  const other = (await second.send('Performance.getMetrics')) as { metrics: Metric[] };
  say('3. a second session, Performance not enabled on it: metrics returned', other.metrics.length);
  say(
    '3. the first session, after more garbage and before any collection (MB)',
    heapOf(await first.send('Performance.getMetrics')),
  );
  await second.send('HeapProfiler.collectGarbage');
  say(
    '3. the first session after the SECOND session collected (MB)',
    heapOf(await first.send('Performance.getMetrics')),
  );
  await second.send('Performance.enable');
  say(
    '3. the second session after its own Performance.enable (MB)',
    heapOf(await second.send('Performance.getMetrics')),
  );

  // The order the soak uses, read twice in a row with garbage made between: a reading after a collection is flat, one without is not.
  const readings: Array<number | null> = [];
  for (let i = 0; i < 3; i++) {
    await garbage();
    await first.send('HeapProfiler.collectGarbage');
    readings.push(heapOf(await first.send('Performance.getMetrics')));
  }
  say('4. collect then getMetrics, after fresh garbage each time (MB)', readings);
  const unsorted: Array<number | null> = [];
  for (let i = 0; i < 3; i++) {
    await garbage();
    unsorted.push(heapOf(await first.send('Performance.getMetrics')));
    await first.send('HeapProfiler.collectGarbage');
  }
  say('4. getMetrics then collect, after fresh garbage each time (MB)', unsorted);
} finally {
  await browser.close();
}

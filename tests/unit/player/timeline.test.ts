import { describe, expect, it } from 'vitest';
import type { QAEvent, QAEventName } from '../../../src/shared/qa.ts';
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  EVENT_NAMES,
  RECENT_EVENTS_IN_MESSAGES,
  Timeline,
  isEventName,
  toJsonSafe,
} from '../../../src/player/timeline.ts';
import { FakeClock } from './fake-clock.ts';

function setup() {
  const clock = new FakeClock();
  const listenerErrors: unknown[] = [];
  const timeline = new Timeline({
    now: clock.now,
    mediaTime: clock.mediaTime,
    timers: clock.timerApi,
    onListenerError: (error) => listenerErrors.push(error),
  });
  return { clock, timeline, listenerErrors };
}

interface Tracked<T> {
  state: 'pending' | 'resolved' | 'rejected';
  value?: T;
  error?: Error;
}

/** Follows a promise without awaiting it, so a test can assert that it is still pending. */
function track<T>(promise: Promise<T>): Tracked<T> {
  const box: Tracked<T> = { state: 'pending' };
  promise.then(
    (value) => {
      box.state = 'resolved';
      box.value = value;
    },
    (error: Error) => {
      box.state = 'rejected';
      box.error = error;
    },
  );
  return box;
}

/** Lets the promise callbacks that are already queued run. It is not time: no clock moves. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('recording', () => {
  it('numbers events from 0 and stamps the page clock and the media clock of that moment', () => {
    const { clock, timeline } = setup();
    clock.media = 1.5;
    const first = timeline.record('playing');
    clock.advance(250);
    clock.media = 2;
    const second = timeline.record('paused', { by: 'test' });
    expect(first).toEqual({ index: 0, t: 1000, name: 'playing', mediaTime: 1.5 });
    expect(second).toEqual({ index: 1, t: 1250, name: 'paused', mediaTime: 2, detail: { by: 'test' } });
  });

  it('cursor() is the index the next event will get', () => {
    const { timeline } = setup();
    expect(timeline.cursor()).toBe(0);
    timeline.record('load-requested');
    timeline.record('loaded');
    expect(timeline.cursor()).toBe(2);
    expect(timeline.record('playing').index).toBe(timeline.cursor() - 1);
  });

  it('events() is a copy, and the events and their details cannot be changed afterwards', () => {
    const { timeline } = setup();
    const event = timeline.record('variant-changed', { to: 2 });
    const copy = timeline.events();
    copy.length = 0;
    copy.push({ index: 99, t: 0, name: 'ended', mediaTime: 0 });
    expect(timeline.events()).toEqual([event]);
    expect(() => {
      (event as { name: string }).name = 'ended';
    }).toThrow(TypeError);
    expect(() => {
      (event.detail as Record<string, unknown>).to = 3;
    }).toThrow(TypeError);
  });

  it('keeps a snapshot of the detail: changing the original afterwards does not change the event', () => {
    const { timeline } = setup();
    const detail: Record<string, unknown> = { rung: 360, tags: ['a'] };
    const event = timeline.record('variant-changed', detail);
    detail.rung = 720;
    (detail.tags as string[]).push('b');
    expect(event.detail).toEqual({ rung: 360, tags: ['a'] });
  });

  it('makes the detail JSON-safe so it always crosses the Playwright boundary', () => {
    const { timeline } = setup();
    const loop: Record<string, unknown> = { name: 'loop' };
    loop.self = loop;
    const event = timeline.record('error', {
      nan: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      missing: undefined,
      callback: () => 1,
      big: 12n,
      failure: new TypeError('boom'),
      list: [1, undefined, Number.NaN],
      loop,
      long: 'x'.repeat(2000),
    });
    const detail = event.detail as Record<string, unknown>;
    expect(JSON.parse(JSON.stringify(detail))).toEqual(detail);
    expect(detail).toMatchObject({
      nan: null,
      infinite: null,
      big: '12',
      failure: { name: 'TypeError', message: 'boom' },
      list: [1, null, null],
      loop: { name: 'loop', self: '[circular]' },
    });
    expect(detail).not.toHaveProperty('missing');
    expect(detail).not.toHaveProperty('callback');
    expect((detail.long as string).length).toBeLessThan(600);
  });

  it('cuts structures that nest too deeply instead of recursing without end', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 50; i++) deep = { next: deep };
    expect(JSON.stringify(toJsonSafe(deep))).toContain('[too deep]');
  });

  it('knows every event name of the contract and nothing else', () => {
    expect(EVENT_NAMES).toContain('buffering-start');
    expect(EVENT_NAMES).toHaveLength(15);
    expect(isEventName('seeked')).toBe(true);
    expect(isEventName('seekd')).toBe(false);
    expect(isEventName('toString')).toBe(false);
    expect(isEventName('__proto__')).toBe(false);
    expect(isEventName(undefined)).toBe(false);
  });
});

describe('waitFor', () => {
  it('resolves at once with an event that already happened: there is no window in which it can be missed', async () => {
    const { timeline } = setup();
    const seeked = timeline.record('seeked');
    await expect(timeline.waitFor('seeked')).resolves.toBe(seeked);
  });

  it('resolves with the first match in the history, not the latest', async () => {
    const { timeline } = setup();
    const first = timeline.record('playing');
    timeline.record('paused');
    timeline.record('playing');
    await expect(timeline.waitFor('playing')).resolves.toBe(first);
  });

  it('waits for an event that has not happened yet and ignores other names', async () => {
    const { timeline } = setup();
    const wait = track(timeline.waitFor('seeked'));
    timeline.record('seeking');
    timeline.record('playing');
    await settle();
    expect(wait.state).toBe('pending');
    const seeked = timeline.record('seeked');
    await settle();
    expect(wait.state).toBe('resolved');
    expect(wait.value).toBe(seeked);
  });

  it('since: a cursor taken before an action waits for the NEW event only', async () => {
    const { timeline } = setup();
    timeline.record('seeked'); // an old seek that must not satisfy the next wait
    const cursor = timeline.cursor();
    const wait = track(timeline.waitFor('seeked', { since: cursor }));
    await settle();
    expect(wait.state).toBe('pending');
    const fresh = timeline.record('seeked');
    await settle();
    expect(wait.value).toBe(fresh);
    expect(fresh.index).toBeGreaterThanOrEqual(cursor);
  });

  it('since: an event recorded between taking the cursor and calling waitFor still counts', async () => {
    const { timeline } = setup();
    const cursor = timeline.cursor();
    const fast = timeline.record('seeked'); // the action completed before the wait was registered
    await expect(timeline.waitFor('seeked', { since: cursor })).resolves.toBe(fast);
  });

  it('since beyond the end of the history ignores everything recorded before it', async () => {
    const { timeline } = setup();
    timeline.record('playing');
    timeline.record('playing');
    const wait = track(timeline.waitFor('playing', { since: 3 }));
    const stillOld = timeline.record('playing'); // index 2 < 3
    await settle();
    expect(wait.state).toBe('pending');
    expect(stillOld.index).toBe(2);
    const arrived = timeline.record('playing'); // index 3
    await settle();
    expect(wait.value).toBe(arrived);
  });

  it('applies the predicate to the history and to events that arrive later', async () => {
    const { timeline } = setup();
    timeline.record('variant-changed', { height: 240 });
    const fromHistory = timeline.record('variant-changed', { height: 720 });
    await expect(
      timeline.waitFor('variant-changed', { predicate: (event) => event.detail?.height === 720 }),
    ).resolves.toBe(fromHistory);

    const wait = track(
      timeline.waitFor('variant-changed', { since: 2, predicate: (event) => event.detail?.height === 360 }),
    );
    timeline.record('variant-changed', { height: 240 });
    await settle();
    expect(wait.state).toBe('pending');
    const wanted = timeline.record('variant-changed', { height: 360 });
    await settle();
    expect(wait.value).toBe(wanted);
  });

  it('a throwing predicate fails that wait with the reason, and nothing else', async () => {
    const { timeline } = setup();
    const explode = (): boolean => {
      throw new Error('bad predicate');
    };
    const broken = track(timeline.waitFor('ended', { predicate: explode }));
    const healthy = track(timeline.waitFor('ended'));
    const ended = timeline.record('ended');
    await settle();
    expect(broken.state).toBe('rejected');
    expect(broken.error?.message).toContain('the predicate threw: bad predicate');
    expect(healthy.value).toBe(ended);
    expect(timeline.events()).toEqual([ended]);
    await expect(timeline.waitFor('ended', { predicate: explode })).rejects.toThrow(/predicate threw/);
  });

  it('times out with the last 15 events (name, t, media time) in the message, not the older ones', async () => {
    const { clock, timeline } = setup();
    for (let i = 0; i < 20; i++) {
      clock.advance(100);
      clock.media = i / 4;
      timeline.record(i % 2 === 0 ? 'playing' : 'paused');
    }
    const wait = track(timeline.waitFor('seeked', { timeoutMs: 500, since: 3 }));
    clock.advance(499);
    await settle();
    expect(wait.state).toBe('pending');
    clock.advance(1);
    await settle();
    expect(wait.state).toBe('rejected');
    const message = wait.error?.message ?? '';
    expect(message).toContain("qa.waitFor('seeked') timed out after 500 ms (looking from index 3)");
    expect(message).toContain(`20 events so far, the last ${RECENT_EVENTS_IN_MESSAGES}`);
    expect(message).toContain('#19 t=3000.0 media=4.750 paused');
    expect(message).toContain('#5 t=1600.0 media=1.250 paused');
    expect(message).not.toMatch(/#4 /);
    expect(message.split('\n').filter((line) => line.startsWith('  #'))).toHaveLength(15);
  });

  it('a timeout with an empty timeline says so', async () => {
    const { clock, timeline } = setup();
    const wait = track(timeline.waitFor('loaded', { timeoutMs: 10 }));
    clock.advance(10);
    await settle();
    expect(wait.error?.message).toContain('No events were recorded.');
  });

  it('the default timeout is 20 s', async () => {
    const { clock, timeline } = setup();
    const wait = track(timeline.waitFor('loaded'));
    clock.advance(DEFAULT_WAIT_TIMEOUT_MS - 1);
    await settle();
    expect(wait.state).toBe('pending');
    clock.advance(1);
    await settle();
    expect(wait.state).toBe('rejected');
  });

  it('leaves no timer behind when it resolves or times out', async () => {
    const { clock, timeline } = setup();
    const resolved = timeline.waitFor('playing');
    expect(clock.pendingTimers).toBe(1);
    timeline.record('playing');
    await resolved;
    expect(clock.pendingTimers).toBe(0);

    const late = track(timeline.waitFor('ended', { timeoutMs: 5 }));
    clock.advance(5);
    await settle();
    expect(late.state).toBe('rejected');
    expect(clock.pendingTimers).toBe(0);
  });

  it('a typo in the event name fails at once and lists the known names, not after 20 s', async () => {
    const { clock, timeline } = setup();
    const wait = track(timeline.waitFor('seekd' as QAEventName));
    await settle();
    expect(wait.state).toBe('rejected');
    expect(wait.error?.message).toContain('unknown event name');
    expect(wait.error?.message).toContain('buffering-start');
    expect(clock.pendingTimers).toBe(0);
    await expect(timeline.waitFor('constructor' as QAEventName)).rejects.toThrow(/unknown event name/);
  });

  it('refuses a timeout or a cursor that would misbehave', async () => {
    const { timeline } = setup();
    for (const timeoutMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(timeline.waitFor('playing', { timeoutMs })).rejects.toThrow(
        /timeoutMs must be a finite number > 0/,
      );
    }
    for (const since of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(timeline.waitFor('playing', { since })).rejects.toThrow(/since must be a cursor >= 0/);
    }
  });

  it('serves several waiters on one event, each honouring its own since', async () => {
    const { timeline } = setup();
    timeline.record('seeked');
    const old = track(timeline.waitFor('seeked', { since: 0 })); // satisfied by the history
    const fresh = track(timeline.waitFor('seeked', { since: 1 }));
    const second = track(timeline.waitFor('seeked', { since: 1 }));
    const arrived = timeline.record('seeked');
    await settle();
    expect(old.value?.index).toBe(0);
    expect(fresh.value).toBe(arrived);
    expect(second.value).toBe(arrived);
  });

  it('close() fails the pending waits with the timeline, still answers from the history, and refuses new waits at once', async () => {
    const { clock, timeline } = setup();
    const recorded = timeline.record('loaded');
    const eventWait = track(timeline.waitFor('ended'));
    const timeWait = track(timeline.waitForMediaTime(30));
    timeline.close('destroyed');
    await settle();
    expect(eventWait.state).toBe('rejected');
    expect(eventWait.error?.message).toContain('aborted, the player page was destroyed');
    expect(eventWait.error?.message).toContain('#0');
    expect(timeWait.state).toBe('rejected');
    expect(clock.pendingTimers).toBe(0);
    await expect(timeline.waitFor('loaded')).resolves.toBe(recorded);
    await expect(timeline.waitFor('ended')).rejects.toThrow(/cannot wait, the player page was destroyed/);
    await expect(timeline.waitForMediaTime(31)).rejects.toThrow(/cannot wait/);
    // Recording stays possible: the history of a destroyed page is what a failing test reads.
    expect(timeline.record('unloaded').index).toBe(1);
  });
});

describe('listeners', () => {
  it('deliver events in index order even when a listener records another event while it runs', () => {
    const { timeline } = setup();
    const seenByFirst: number[] = [];
    const seenBySecond: number[] = [];
    timeline.subscribe((event) => {
      seenByFirst.push(event.index);
      if (event.name === 'seeking') timeline.record('buffering-start');
    });
    timeline.subscribe((event) => seenBySecond.push(event.index));
    timeline.record('seeking');
    timeline.record('seeked');
    expect(seenByFirst).toEqual([0, 1, 2]);
    expect(seenBySecond).toEqual([0, 1, 2]);
    expect(timeline.events().map((event) => event.name)).toEqual(['seeking', 'buffering-start', 'seeked']);
  });

  it('a waiter that a re-entrant record() satisfies still gets the right event', async () => {
    const { timeline } = setup();
    timeline.subscribe((event) => {
      if (event.name === 'seeking') timeline.record('seeked');
    });
    const wait = timeline.waitFor('seeked', { since: timeline.cursor() });
    timeline.record('seeking');
    await expect(wait).resolves.toMatchObject({ index: 1, name: 'seeked' });
  });

  it('a throwing listener neither stops the delivery nor loses the event', async () => {
    const { timeline, listenerErrors } = setup();
    const received: QAEvent[] = [];
    timeline.subscribe(() => {
      throw new Error('listener failed');
    });
    timeline.subscribe((event) => received.push(event));
    const wait = timeline.waitFor('error');
    const event = timeline.record('error', { code: 1001 });
    expect(received).toEqual([event]);
    await expect(wait).resolves.toBe(event);
    expect(listenerErrors).toHaveLength(1);
    expect((listenerErrors[0] as Error).message).toBe('listener failed');
  });

  it('stops delivering after unsubscribe', () => {
    const { timeline } = setup();
    const seen: number[] = [];
    const unsubscribe = timeline.subscribe((event) => seen.push(event.index));
    timeline.record('playing');
    unsubscribe();
    timeline.record('paused');
    expect(seen).toEqual([0]);
  });
});

describe('waitForMediaTime', () => {
  it('resolves at once when the media clock is already there, with the time it is at', async () => {
    const { clock, timeline } = setup();
    clock.media = 5.25;
    await expect(timeline.waitForMediaTime(3)).resolves.toBe(5.25);
    await expect(timeline.waitForMediaTime(5.25)).resolves.toBe(5.25);
    await expect(timeline.waitForMediaTime(-1)).resolves.toBe(5.25);
  });

  it('is driven by the notifications of the page, not by a timer: it resolves with the time reached', async () => {
    const { clock, timeline } = setup();
    const wait = track(timeline.waitForMediaTime(3));
    timeline.notifyMediaTime(1);
    timeline.notifyMediaTime(2.99);
    await settle();
    expect(wait.state).toBe('pending');
    timeline.notifyMediaTime(3.04);
    await settle();
    expect(wait.state).toBe('resolved');
    expect(wait.value).toBe(3.04);
    expect(clock.pendingTimers).toBe(0);
  });

  it('resolves several waiters independently as the media clock passes their targets', async () => {
    const { timeline } = setup();
    const at2 = track(timeline.waitForMediaTime(2));
    const at5 = track(timeline.waitForMediaTime(5));
    const at9 = track(timeline.waitForMediaTime(9));
    timeline.notifyMediaTime(2.1);
    timeline.notifyMediaTime(5.2);
    await settle();
    expect([at2.state, at5.state, at9.state]).toEqual(['resolved', 'resolved', 'pending']);
    expect(at2.value).toBe(2.1);
    expect(at5.value).toBe(5.2);
  });

  it('a media clock that never gets there is a failure with the timeline, never a pass', async () => {
    const { clock, timeline } = setup();
    clock.media = 1.5;
    timeline.record('playing');
    const wait = track(timeline.waitForMediaTime(10, { timeoutMs: 3000 }));
    timeline.notifyMediaTime(1.5);
    clock.advance(3000);
    await settle();
    expect(wait.state).toBe('rejected');
    expect(wait.error?.message).toContain('qa.waitForMediaTime(10) timed out after 3000 ms');
    expect(wait.error?.message).toContain('media clock is at 1.500 s');
    expect(wait.error?.message).toContain('#0 t=1000.0 media=1.500 playing');
  });

  it('rejects a target that is not a number, and ignores a notification that is not finite', async () => {
    const { timeline } = setup();
    await expect(timeline.waitForMediaTime(Number.NaN)).rejects.toThrow(/seconds must be a number/);
    await expect(timeline.waitForMediaTime('3' as unknown as number)).rejects.toThrow(
      /seconds must be a number/,
    );
    await expect(timeline.waitForMediaTime(3, { timeoutMs: 0 })).rejects.toThrow(/timeoutMs/);
    const wait = track(timeline.waitForMediaTime(3));
    timeline.notifyMediaTime(Number.NaN);
    timeline.notifyMediaTime(Number.POSITIVE_INFINITY);
    await settle();
    expect(wait.state).toBe('pending');
  });
});

describe('describeRecent', () => {
  it('prints a short detail after the event and cuts a long one', () => {
    const { timeline } = setup();
    timeline.record('error', { code: 1001, uri: 'http://x/seg/1.m4s' });
    timeline.record('error', { text: 'y'.repeat(400) });
    const lines = timeline.describeRecent().split('\n');
    expect(lines[1]).toBe('  #0 t=1000.0 media=0.000 error {"code":1001,"uri":"http://x/seg/1.m4s"}');
    expect(lines[2]?.endsWith('…')).toBe(true);
  });
});

# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e/abr.spec.ts >> PB-ABR-002 downshifts when bandwidth drops mid-playback (bandwidth-drop): at most one rebuffer, settles on a rung the network can carry
- Location: tests/e2e/abr.spec.ts:133:1

# Error details

```
Error: rung changes in the 12 s after the step down to 240p (qa.events()): none. Shaka also leaves a rung, whatever the link, when 15 % of the frames of a 2 s window are dropped (it disables that variant for 30 s); dropped frames in this load: 17 of 1204 (1.4 %). Changes that came sooner than the 8 s the adaptation waits between decisions were not decisions about the link, they were forced (a ban): 360p at media time 33.91 s, 6.0 s after the change before it

expect(received).toBe(expected) // Object.is equality

Expected: "none"
Received: "360p abr at 33.91 s"
```

# Page snapshot

```yaml
- main [ref=e2]
```

# Test source

```ts
  79  |       `media time of the climb to ${ladder.top.height}p (qa.events()): within the switch interval and one segment`,
  80  |     ).toBeLessThanOrEqual(climbBound);
  81  | 
  82  |     // Stays: nothing can change before the switch interval has elapsed, so watch past it and past the next segment decisions.
  83  |     const window = settleWindowSeconds(stream.segmentDurationSec);
  84  |     await qa.waitForMediaTime(top.mediaTime + window, { timeoutMs: WAIT_MS });
  85  | 
  86  |     const events = await qa.events();
  87  |     const changes = variantChanges(events);
  88  |     const metrics = await qa.metrics();
  89  |     testInfo.annotations.push({
  90  |       type: 'measured',
  91  |       description: `rungs: ${describeVariantChanges(changes)}; dropped frames ${metrics.frames.dropped} of ${metrics.frames.decoded}`,
  92  |     });
  93  |     // The hook's declared bandwidths against the catalog's: the numbers a regression of the estimate would be read against.
  94  |     expect(
  95  |       changes.map((change) => ({ height: change.height, bandwidth: change.bandwidth })),
  96  |       'bandwidth declared by each variant the hook reported (qa.events()), against the ladder of the catalog',
  97  |     ).toEqual(
  98  |       changes.map((change) => ({
  99  |         height: change.height,
  100 |         bandwidth: rungOf(ladder, { height: change.height }).variantBandwidth,
  101 |       })),
  102 |     );
  103 |     expect(
  104 |       describeVariantChanges(variantChanges(await qa.events(top.index + 1))),
  105 |       `rung changes in the ${window} s after reaching ${ladder.top.height}p (qa.events()): none. ${banNote(metrics.frames, changes)}`,
  106 |     ).toBe('none');
  107 |     expect(metrics.bitrate.current?.height, 'active rung (metrics.bitrate.current) at the end').toBe(
  108 |       ladder.top.height,
  109 |     );
  110 |     expectHealthyPlayback(metrics);
  111 | 
  112 |     // The origin's account: the top rung was asked for, and from its first segment on nothing else; it is what was delivered last.
  113 |     const log = await session.service.log(session.id);
  114 |     const video = videoSegmentRequests(log);
  115 |     expect(
  116 |       video.some((entry) => entry.rep === ladder.top.rep),
  117 |       `${ladder.top.rep} segments in the request log: the top rung must be fetched, not only announced: ${describeSegments(video)}`,
  118 |     ).toBe(true);
  119 |     expect(
  120 |       fromFirstOf(video, ladder.top.rep)
  121 |         .filter((entry) => entry.rep !== ladder.top.rep)
  122 |         .map((entry) => `${entry.rep} #${entry.number}`),
  123 |       `video segments requested after the first ${ladder.top.rep} one (request log): ${describeSegments(video)}`,
  124 |     ).toEqual([]);
  125 |     const delivered = videoSegmentRequests(requestsFor(log, { status: 'ok' }));
  126 |     expect(
  127 |       delivered.slice(-3).map((entry) => entry.rep),
  128 |       `rungs of the last three video segments the origin delivered (request log): ${describeSegments(delivered)}`,
  129 |     ).toEqual([ladder.top.rep, ladder.top.rep, ladder.top.rep]);
  130 |   },
  131 | );
  132 | 
  133 | test(
  134 |   'PB-ABR-002 downshifts when bandwidth drops mid-playback (bandwidth-drop): at most one rebuffer, settles on a rung the network can carry',
  135 |   { tag: ['@merge', '@dash'] },
  136 |   async ({ newSession, streamFor, player }, testInfo) => {
  137 |     test.setTimeout(ABR_TEST_TIMEOUT_MS);
  138 |     const rules = profile('bandwidth-drop');
  139 |     const session = await newSession({ stream: streamFor('vod', 'dash'), protocol: 'dash', faults: rules });
  140 |     const stream = await streamInfoOf(session);
  141 |     const ladder = ladderOf(stream);
  142 |     // The rung the arithmetic of the profile says the link can carry (600 kbps: 240p and its audio, 364 kbps; 360p needs 764).
  143 |     const throttle = throttleOf(rules);
  144 |     const settle = bestRungCarriedBy(ladder, throttle.kbps);
  145 |     expect(settle.rep, 'the ladder has a rung above the one the link carries to step down from').not.toBe(
  146 |       ladder.top.rep,
  147 |     );
  148 | 
  149 |     const qa = await player(session).open();
  150 |     await qa.waitFor('firstframe');
  151 | 
  152 |     // The start rung is Shaka's choice and differs per engine (720p in Chromium, 360p in the others): the test only needs the player to
  153 |     // end up on the rung the link carries. The link weakens 8 s after the first media request. Shaka decides at most every 8 s on a
  154 |     // segment download, and it may need two decisions (720p to 360p to 240p, seen in about half of the runs in Chromium) because its
  155 |     // estimate still holds the fast samples of the first 8 s at the first decision. The segment in flight when the link weakens takes
  156 |     // about 6 s at 600 kbps. So the step to 240p comes between 10 and 26 s into the playback in the runs measured; the wait is a
  157 |     // bound for a failure (8 s + two decisions 8 s apart + one 6 s segment + margin), never the pace of the test.
  158 |     const down = await orExplain(
  159 |       qa.waitFor('variant-changed', {
  160 |         detail: { reason: 'abr', height: settle.height },
  161 |         timeoutMs: DOWNSHIFT_WAIT_MS,
  162 |       }),
  163 |       `the player did not step down to ${settle.height}p, the rung a ${throttle.kbps} kbps link carries, within ${DOWNSHIFT_WAIT_MS / 1000} s of the start (the link weakens 8 s in): members on a weakening connection get stall after stall instead of lower quality.`,
  164 |     );
  165 |     expect(down.detail?.bandwidth, 'bandwidth declared by the variant the player stepped down to').toBe(
  166 |       settle.variantBandwidth,
  167 |     );
  168 | 
  169 |     // Settled: nothing can change before the switch interval has elapsed, so watch past it, and past the next segment decisions.
  170 |     const window = settleWindowSeconds(stream.segmentDurationSec);
  171 |     await qa.waitForMediaTime(down.mediaTime + window, { timeoutMs: WAIT_MS });
  172 | 
  173 |     const metrics = await qa.metrics();
  174 |     const changes = variantChanges(await qa.events());
  175 |     const afterDown = await qa.events(down.index + 1);
  176 |     expect(
  177 |       describeVariantChanges(variantChanges(afterDown)),
  178 |       `rung changes in the ${window} s after the step down to ${settle.height}p (qa.events()): none. ${banNote(metrics.frames, changes)}`,
> 179 |     ).toBe('none');
      |       ^ Error: rung changes in the 12 s after the step down to 240p (qa.events()): none. Shaka also leaves a rung, whatever the link, when 15 % of the frames of a 2 s window are dropped (it disables that variant for 30 s); dropped frames in this load: 17 of 1204 (1.4 %). Changes that came sooner than the 8 s the adaptation waits between decisions were not decisions about the link, they were forced (a ban): 360p at media time 33.91 s, 6.0 s after the change before it
  180 |     testInfo.annotations.push({
  181 |       type: 'measured',
  182 |       description: `rungs: ${describeVariantChanges(changes)}; rebuffers ${metrics.rebuffer.count}`,
  183 |     });
  184 |     expect(metrics.bitrate.current?.height, 'active rung (metrics.bitrate.current) at the end').toBe(
  185 |       settle.height,
  186 |     );
  187 |     withExplanation(
  188 |       () => expectAtMostRebuffers(metrics, 1),
  189 |       `rung changes of the load (qa.events()): ${describeVariantChanges(changes)}. Each segment of a rung that the ${throttle.kbps} kbps link does not carry takes longer to arrive than it plays, so whether the player stalls depends on how early it left the rung it was on when the link weakened (ADR-097). ${banNote(metrics.frames, changes)}`,
  190 |     );
  191 |     expectHealthyPlayback(metrics);
  192 | 
  193 |     // The origin's account: from the first segment of the settled rung on, nothing else is requested, and the last segments it
  194 |     // delivered are of that rung.
  195 |     const log = await session.service.log(session.id);
  196 |     const video = videoSegmentRequests(log);
  197 |     expect(
  198 |       video.some((entry) => entry.rep === settle.rep),
  199 |       `${settle.rep} segments in the request log: ${describeSegments(video)}`,
  200 |     ).toBe(true);
  201 |     expect(
  202 |       fromFirstOf(video, settle.rep)
  203 |         .filter((entry) => entry.rep !== settle.rep)
  204 |         .map((entry) => `${entry.rep} #${entry.number}`),
  205 |       `video segments requested after the first ${settle.rep} one (request log): ${describeSegments(video)}`,
  206 |     ).toEqual([]);
  207 |     const delivered = videoSegmentRequests(requestsFor(log, { status: 'ok' }));
  208 |     expect(
  209 |       delivered.slice(-3).map((entry) => entry.rep),
  210 |       `rungs of the last three video segments the origin delivered (request log): ${describeSegments(delivered)}`,
  211 |     ).toEqual([settle.rep, settle.rep, settle.rep]);
  212 |   },
  213 | );
  214 | 
  215 | test(
  216 |   'PB-ABR-003 upshifts after the bandwidth recovers (the throttle is lifted once the downshift has happened)',
  217 |   { tag: ['@release', '@dash'] },
  218 |   async ({ newSession, streamFor, player }, testInfo) => {
  219 |     test.setTimeout(ABR_TEST_TIMEOUT_MS);
  220 |     const rules = profile('bandwidth-drop');
  221 |     const session = await newSession({ stream: streamFor('vod', 'dash'), protocol: 'dash', faults: rules });
  222 |     const stream = await streamInfoOf(session);
  223 |     const ladder = ladderOf(stream);
  224 |     const settle = bestRungCarriedBy(ladder, throttleOf(rules).kbps);
  225 |     expect(
  226 |       bestRungCarriedBy(ladder, RECOVERED_LINK_KBPS).rep,
  227 |       `the recovered link (${RECOVERED_LINK_KBPS} kbps) must carry the whole ladder (the ladder)`,
  228 |     ).toBe(ladder.top.rep);
  229 | 
  230 |     const qa = await player(session).open();
  231 |     await qa.waitFor('firstframe');
  232 |     // The downshift first (PB-ABR-002 has the arithmetic of this wait): the recovery is the end of the drop the player answered.
  233 |     await orExplain(
  234 |       qa.waitFor('variant-changed', {
  235 |         detail: { reason: 'abr', height: settle.height },
  236 |         timeoutMs: DOWNSHIFT_WAIT_MS,
  237 |       }),
  238 |       `the player did not step down to ${settle.height}p within ${DOWNSHIFT_WAIT_MS / 1000} s of the start, so there is no drop for it to recover from (PB-ABR-002 is the test of the drop).`,
  239 |     );
  240 | 
  241 |     // The link recovers to a link of its own: the rule is replaced, in one call, by a finite one. Removing the rule would leave the
  242 |     // player a link on which a segment arrives in under a millisecond, and Shaka (`abr.cacheLoadThreshold`, 5 ms) takes a download
  243 |     // that fast for a cache hit and does not count it: its estimate never hears of the recovery, and Chromium stays on the rung it
  244 |     // stepped down to for as long as the title lasts (28 s measured). A finite link is also what a recovered connection is.
  245 |     const eventsSince = await qa.cursor();
  246 |     const logSince = await requestLogCursor(session);
  247 |     const recoveredAt = (await qa.metrics()).playback.currentTime;
  248 |     await session.service.setFaults(session.id, [{ type: 'throttle', kbps: RECOVERED_LINK_KBPS }]);
  249 | 
  250 |     const [up] = variantChanges([
  251 |       await orExplain(
  252 |         qa.waitFor('variant-changed', {
  253 |           since: eventsSince,
  254 |           timeoutMs: upshiftWaitMs(stream.segmentDurationSec),
  255 |         }),
  256 |         `the player stayed on ${settle.height}p for ${upshiftWaitMs(stream.segmentDurationSec) / 1000} s after the link recovered to ${RECOVERED_LINK_KBPS} kbps, which carries every rung: members stay at low quality after the network recovers.`,
  257 |         async () => banNote((await qa.metrics()).frames, variantChanges(await qa.events())),
  258 |       ),
  259 |     ]);
  260 |     if (!up) throw new Error('the hook recorded no variant change');
  261 |     const elapsed = up.mediaTime - recoveredAt;
  262 | 
  263 |     // The bound depends on whether a ban can have held a rung (abr/bans.ts, ADR-095). Shaka bans the rung that is playing for 30 s when
  264 |     // 15 % of the frames of a 2 s window were dropped, outside the switch interval, so after a recovery the rungs above can be out of
  265 |     // reach for up to 31 s whatever the link does. On a GitHub macOS runner (WebKit, 3 CPUs, one worker) the page dropped 37 and 40 of
  266 |     // about 1,200 frames and the first step up came 21.9 s (the first ban ended 30.1 s after it began) and 16.4 s (the rung above was
  267 |     // banned, and the estimate had to reach the top rung's own threshold) after the recovery, while on the same run Chromium, Firefox and
  268 |     // Linux WebKit dropped no frame and stepped up 8.2 to 9.8 s after it (nightly 41793007785; 7.8 to 9.9 s on the machine of the
  269 |     // author). Where no frame was dropped and no change came sooner than the interval allows, no ban can have been in force and the
  270 |     // bound is the link's, 14 s. Otherwise it is the ban's, 33 s. A player that does not climb, or climbs after a minute, fails in both.
  271 |     const metrics = await qa.metrics();
  272 |     const bound = upshiftBound(
  273 |       stream.segmentDurationSec,
  274 |       banEvidence({
  275 |         frames: metrics.frames,
  276 |         changesBeforeRecovery: variantChanges(await qa.events()).filter(
  277 |           (change) => change.index < eventsSince,
  278 |         ),
  279 |       }),
```
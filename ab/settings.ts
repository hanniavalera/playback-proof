import { B_KNOBS, flattenPatch } from '../src/player/configs.ts';

// B IS SEVERAL SETTINGS TOGETHER. Configuration B overrides `abr.useNetworkInformation`, `abr.defaultBandwidthEstimate`,
// `abr.switchInterval` and `streaming.bufferingGoal` at once (src/player/configs.ts, ADR-064), and the experiments compare the two
// configurations as they are shipped: arms of A plus one setting are not run. So no sentence of a plan or of a report may attribute an
// effect to one setting. The plan is checked here, before the data; the report states the bundle in one sentence of its own and the tests
// of the report check that a single setting is named nowhere else (ADR-149).

/** The names under which one setting of configuration B can be spoken of: its path, its last key, and the id of its knob in `B_KNOBS`. */
export function settingNames(): string[] {
  const names = new Set<string>();
  for (const knob of B_KNOBS) {
    names.add(knob.id);
    for (const { path } of flattenPatch(knob.patch)) {
      names.add(path);
      names.add(path.split('.').at(-1) as string);
    }
  }
  return [...names].sort();
}

/** The settings of B that a text names, whatever the case. */
export function mentionedSettings(text: string): string[] {
  const lower = text.toLowerCase();
  return settingNames().filter((name) => lower.includes(name.toLowerCase()));
}

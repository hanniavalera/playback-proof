// `npm run bench:server`: what the service adds to an unthrottled response, and whether its memory stays flat.
//
// 2000 requests for a 450 kB segment, 20 at a time, over keep-alive connections on loopback, against (1) a bare node:http server that
// answers every request with the same bytes and (2) the real service (sessions, the request pipeline, the fault plan, deliver) with the
// in-memory fake store. The two servers run in their own processes and are driven by the same client in this one, so the difference
// between them is what the service adds. Not a gate: it needs a quiet machine, so run it alone.
//
//   npm run bench:server -- [--requests 2000] [--concurrency 20] [--bytes 450000]

import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { Agent, createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { arch, cpus, loadavg, platform, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ServiceClient } from '../src/lab/service-client.ts';
import { startServer } from '../src/server/index.ts';
import { segmentPath } from '../src/shared/urls.ts';
import { createFakeMedia } from '../tests/unit/server/fake-media.ts';

const SELF = fileURLToPath(import.meta.url);
const HEADERS = {
  'Content-Type': 'video/mp4',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

// ------------------------------------------------------------------------------------------------------------------------------
// The two servers, each in a child process (so that its memory is its own)
// ------------------------------------------------------------------------------------------------------------------------------

interface Memory {
  rss: number;
  heapUsed: number;
  external: number;
}

async function runChild(role: string, bytes: number): Promise<void> {
  let port: number;
  if (role === 'service') {
    const server = await startServer({ media: createFakeMedia({ segmentBytes: bytes }), port: 0 });
    port = server.port;
  } else {
    const body = Buffer.alloc(bytes, 0x5a);
    const server = createServer((_req, res) => {
      res.writeHead(200, { ...HEADERS, 'Content-Length': body.length });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  }
  process.on('message', (message: { type: string }) => {
    if (message.type === 'gc') globalThis.gc?.();
    const { rss, heapUsed, external } = process.memoryUsage();
    process.send?.({ type: 'memory', rss, heapUsed, external } satisfies Memory & { type: string });
  });
  process.send?.({ type: 'ready', port });
}

interface Target {
  child: ChildProcess;
  port: number;
  memory(gc?: boolean): Promise<Memory>;
  stop(): Promise<void>;
}

function startTarget(role: 'baseline' | 'service', bytes: number): Promise<Target> {
  const child = fork(SELF, ['--child', role, '--bytes', String(bytes)], {
    execArgv: ['--import', 'tsx', '--expose-gc'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`the ${role} server exited with ${code} before it was ready`)),
    );
    child.on('message', (message: { type: string; port?: number }) => {
      if (message.type !== 'ready') return;
      child.removeAllListeners('exit');
      resolve({
        child,
        port: message.port as number,
        memory: (gc = false) =>
          new Promise<Memory>((done) => {
            child.once('message', (reply: Memory & { type: string }) => done(reply));
            child.send({ type: gc ? 'gc' : 'memory' });
          }),
        stop: () =>
          new Promise<void>((done) => {
            child.once('exit', () => done());
            child.kill('SIGTERM');
          }),
      });
    });
  });
}

// ------------------------------------------------------------------------------------------------------------------------------
// The client
// ------------------------------------------------------------------------------------------------------------------------------

interface Run {
  totalMs: number[];
  ttfbMs: number[];
  wallMs: number;
  bytes: number;
}

async function load(
  port: number,
  paths: string[],
  count: number,
  concurrency: number,
  bytes: number,
): Promise<Run> {
  const agent = new Agent({ keepAlive: true, maxSockets: concurrency, maxFreeSockets: concurrency });
  const totalMs: number[] = [];
  const ttfbMs: number[] = [];
  let next = 0;
  let received = 0;
  const one = (path: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const t0 = performance.now();
      let first = 0;
      const req = request({ host: '127.0.0.1', port, path, agent }, (res) => {
        first = performance.now() - t0;
        let n = 0;
        res.on('data', (data: Buffer) => (n += data.length));
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode !== 200 || n !== bytes)
            return reject(new Error(`${path}: status ${res.statusCode}, ${n} of ${bytes} bytes`));
          totalMs.push(performance.now() - t0);
          ttfbMs.push(first);
          received += n;
          resolve();
        });
      });
      req.on('error', reject);
      req.end();
    });
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < count) await one(paths[next++ % paths.length] as string);
    }),
  );
  const wallMs = performance.now() - started;
  agent.destroy();
  return { totalMs, ttfbMs, wallMs, bytes: received };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const ms = (value: number): string => `${value.toFixed(2)} ms`;

// ------------------------------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      requests: { type: 'string', default: '2000' },
      concurrency: { type: 'string', default: '20' },
      bytes: { type: 'string', default: '450000' },
      child: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const bytes = Number(values.bytes);
  if (values.child) return runChild(values.child, bytes);
  if (values.help) {
    console.log('usage: npm run bench:server -- [--requests 2000] [--concurrency 20] [--bytes 450000]');
    return;
  }
  const count = Number(values.requests);
  const concurrency = Number(values.concurrency);
  const warmup = Math.min(300, count);

  console.log(
    `${count} requests of ${bytes} B, ${concurrency} at a time, keep-alive, loopback. ${platform()} ${release()} ${arch()}, ${cpus()[0]?.model}, ${cpus().length} cores, node ${process.version}, load average before: ${loadavg()[0]?.toFixed(2)}`,
  );

  const measured: Array<{ name: string; run: Run; before?: Memory; after?: Memory; collected?: Memory }> = [];

  for (const role of ['baseline', 'service'] as const) {
    const target = await startTarget(role, bytes);
    try {
      let paths = ['/segment'];
      if (role === 'service') {
        const client = new ServiceClient(`http://127.0.0.1:${target.port}`);
        const session = await client.createSession({ stream: 'vod-cmaf-short', label: 'bench' });
        paths = [1, 2, 3, 4, 5, 6].map((n) => segmentPath(session.id, session.stream, 'v360', n, 'm4s'));
      }
      await load(target.port, paths, warmup, concurrency, bytes);
      const before = await target.memory(true);
      const run = await load(target.port, paths, count, concurrency, bytes);
      const after = await target.memory();
      const collected = await target.memory(true);
      measured.push({
        name: role === 'service' ? 'the service' : 'bare node:http',
        run,
        before,
        after,
        collected,
      });
    } finally {
      await target.stop();
    }
  }

  const rows = [['', 'median', 'p95', 'p99', 'ttfb median', 'requests/s', 'throughput']];
  for (const { name, run } of measured) {
    rows.push([
      name,
      ms(percentile(run.totalMs, 50)),
      ms(percentile(run.totalMs, 95)),
      ms(percentile(run.totalMs, 99)),
      ms(percentile(run.ttfbMs, 50)),
      (run.totalMs.length / (run.wallMs / 1000)).toFixed(0),
      `${(run.bytes / 1024 / 1024 / (run.wallMs / 1000)).toFixed(0)} MiB/s`,
    ]);
  }
  const [bare, service] = measured;
  if (bare && service) {
    rows.push([
      'the service adds',
      ms(percentile(service.run.totalMs, 50) - percentile(bare.run.totalMs, 50)),
      ms(percentile(service.run.totalMs, 95) - percentile(bare.run.totalMs, 95)),
      ms(percentile(service.run.totalMs, 99) - percentile(bare.run.totalMs, 99)),
      ms(percentile(service.run.ttfbMs, 50) - percentile(bare.run.ttfbMs, 50)),
      '',
      '',
    ]);
  }
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length))) ?? [];
  console.log(
    rows
      .map((r) =>
        r
          .map((cell, c) => (c === 0 ? cell.padEnd(widths[c] ?? 0) : cell.padStart(widths[c] ?? 0)))
          .join('  '),
      )
      .join('\n'),
  );
  if (service?.before && service.after && service.collected) {
    const change = service.after.rss - service.before.rss;
    console.log(
      `service RSS: ${mib(service.before.rss)} before (after ${warmup} warm-up requests), ${mib(service.after.rss)} after ${count} requests ` +
        `(${change >= 0 ? '+' : '-'}${mib(Math.abs(change))}), ${mib(service.collected.rss)} after a garbage collection; ` +
        `heap ${mib(service.before.heapUsed)} -> ${mib(service.collected.heapUsed)}, external ${mib(service.before.external)} -> ${mib(service.collected.external)}`,
    );
  }
}

await main();

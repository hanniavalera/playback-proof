import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import type { AppOptions } from './app.ts';

// The only place that listens. `startServer` is what the CLI (tools/serve.ts), the harnesses and the tests use.

export interface ServerOptions extends AppOptions {
  /** Default 127.0.0.1: the service has no authentication, so it must not be on the network by accident. */
  host?: string;
  /** Default 0: the OS picks a free port (`port` of the result says which). */
  port?: number;
}

export interface RunningServer {
  /** `http://<host>:<port>`, ready to be resolved against. A wildcard host (0.0.0.0, ::) is reported as loopback. */
  origin: string;
  port: number;
  /** Stops accepting, destroys every open connection and resolves when the server is gone. Safe to call twice. */
  close(): Promise<void>;
}

function originOf(host: string, port: number): string {
  const shown = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${shown.includes(':') ? `[${shown}]` : shown}:${port}`;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const app = createApp(options);
  const server = createServer((req, res) => {
    void app.handle(req, res);
  });
  server.on('error', (err) => app.report('server', err));
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    const failed = (err: Error): void => reject(err);
    server.once('error', failed);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', failed);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;
  return {
    origin: originOf(host, port),
    port,
    close() {
      // Open connections (keep-alive ones, a throttled download) would keep `close` waiting for as long as they last.
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

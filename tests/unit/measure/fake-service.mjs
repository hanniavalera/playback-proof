// A stand-in for tools/serve.ts in the unit tests of src/lab/measure/service.ts: it answers GET /health the way the real service does,
// on PB_PORT, and misbehaves on request (FAKE_MODE), so that the harness's handling of a child process can be tested without generated
// streams. It is not the service and tests nothing about it.
import { createServer } from 'node:http';

const mode = process.env.FAKE_MODE ?? 'ok';
const port = Number(process.env.PB_PORT);

if (mode === 'crash') {
  console.error(`listen EADDRINUSE: address already in use 127.0.0.1:${port}`);
  process.exit(1);
}

if (mode === 'silent') {
  // Alive but never answers: the harness has to give up on its own, and stop this process.
  setInterval(() => {}, 1000);
} else {
  const server = createServer((request, response) => {
    if (request.url !== '/health') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        status: 'ok',
        version: 'fake',
        ffmpeg: 'fake',
        streams: {},
        player: mode === 'no-player' ? 'missing' : 'built',
        uptimeSec: 0,
      }),
    );
  });
  server.listen(port, '127.0.0.1', () => console.log(`fake service listening on ${port}`));
  // A process that ignores SIGTERM is what `stop()` has to escalate against.
  if (mode === 'stubborn') process.on('SIGTERM', () => {});
  else process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

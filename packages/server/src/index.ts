import { createApp } from './app';

const port = Number(process.env.PORT ?? 2567);
// Dev-only: simulate network latency (round-trip ms) to test prediction feel
// locally, e.g. SIMULATE_LATENCY_MS=50 make server. Never set in production.
const simulateLatencyMs = Number(process.env.SIMULATE_LATENCY_MS ?? 0);

const { gameServer } = createApp();
if (simulateLatencyMs > 0) gameServer.simulateLatency(simulateLatencyMs);
void gameServer.listen(port).then(() => {
  console.log(`bomberman server listening on :${port}`);
});

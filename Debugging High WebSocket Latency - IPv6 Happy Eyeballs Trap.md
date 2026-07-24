---
id: Debugging High WebSocket Latency - IPv6 Happy Eyeballs Trap
aliases:
tags:
  - computer_network
  - devops
note_type: concept
created at: 2026-07-24 23:59
---
# Debugging High WebSocket Latency - IPv6 Happy Eyeballs Trap

## Summary

- Browser game client showed 369ms ping to a Fly.io server (Singapore) while a headless Node probe over the same WebSocket protocol measured 50ms — same machine, same network, same server.
- Root cause: the browser preferred IPv6 via [[Happy Eyeballs]] (RFC 8305), and the ISP's IPv6 international route was ~360ms vs ~50ms over IPv4. Node defaults to IPv4, which is why the two measurements disagreed.
- Fix: `fly ips release <v6-addr>` removed the AAAA record from the app's DNS, forcing all browsers onto the healthy IPv4 path. In-game ping dropped 369ms → ~55ms instantly. Rollback is `fly ips allocate-v6`.

## Key Points

- **Measure RTT through the real protocol first.** HTTP fetch benchmarks (new TCP+TLS handshake per request) inflate numbers; a ping/pong echo over the persistent game WebSocket measures what players actually feel.
- **Happy Eyeballs commits to IPv6 if it merely connects** — it does not compare path quality. A working-but-slow v6 route (195ms TCP connect) beats a fast v4 route (57ms) in the race because browsers give v6 a head start. Slow ≠ fallback.
- **Different runtimes pick different address families.** Browser → v6, Node → v4. Any latency debugging that mixes tools across runtimes must pin the stack (`node --dns-result-order=ipv6first`, `curl -4/-6`) before comparing numbers.
- **VPN "fixing" latency is a routing clue, not a fix.** The VPN tunnel was IPv4-only, which silently disabled v6 — that's why ping improved. If a VPN helps, suspect path/address-family, not server capacity.
- **Eliminate layers with evidence before scaling.** Server under real match load (bots + 20Hz tick on shared-cpu-1x) added only ~10ms to RTT; CPU scaling would have cost money and fixed nothing.
- Diagnostic ladder that worked: idle WS probe → WS probe under real game load → `curl -4` vs `curl -6` → WS probe forced to v6 (359ms = smoking gun matching the 369ms HUD reading).
- Fly.io specifics: apps get a shared [[Anycast]] IPv4 + dedicated IPv6 by default; releasing the v6 removes the AAAA record from `<app>.fly.dev` while the shared v4 keeps serving TLS+WebSocket via SNI.
- Related failure mode kept in mind but not the culprit here: [[Bufferbloat]] — sustained state-patch streams filling a congested link's queue inflate RTT for light packets sharing the path.

## References

1. RFC 8305 — Happy Eyeballs Version 2: Better Connectivity Using Concurrency
2. https://fly.io/docs/networking/services/

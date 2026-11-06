# emu-lab

Android emulator testing with isolated device leases and structured results.

emu-lab is planned as a TypeScript library, CLI, and thin MCP server. It will run instrumentation tests, Maestro flows, and release smoke tests and return logs, screenshots, and evidence-backed failure classifications.

Part of [android-kit](https://github.com/fridaysundaymood/android-kit), a toolkit combining five tools for end-to-end Android development. Works on its own; no other kit tool required.

## Status

> **Planning stage: there is no code to install yet.** This repo holds the design in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). The first milestone covers device leasing, host resource budgets, emulator profiles, boot health checks, and crash recovery.

## Who it's for

- Developers and agents using any MCP client or the standalone CLI in CI.
- Developers who run several emulators at once and lose time to overloaded hosts, leftover app state, or flaky failures.

## What it will do

| Capability | Details |
|---|---|
| Device leasing | Exclusive emulators with heartbeats and timeouts; respects a RAM/CPU budget; never touches emulators you started yourself |
| Device profiles | YAML profiles for system image, API level, RAM, GPU, locale, density; boot health checks with automatic retry |
| Build cache | Isolated Gradle builds keyed by source tree; the same build is reused, never rebuilt in parallel |
| Clean app state | Resets data, permissions, locale, font scale, density, dark mode, and network before every run |
| Test runners | Instrumentation (JUnit XML), Maestro flows (with one isolated rerun to detect flakiness), release smoke tests |
| Failure triage | Versioned, data-driven `app` / `test` / `environment` rules, with evidence and artifacts; isolated rerun passes are `flaky` |
| Multi-device | Lease groups of devices for scenarios that need several phones |

## Out of scope

Cloud device farms, iOS, and provisioning physical devices (beyond adb passthrough).

## Contributing

The design is open for feedback. Open an issue to question scope, suggest a feature, or discuss an approach before sending a pull request. Use synthetic examples only: no private app code, production data, or credentials.

## License

[MIT](LICENSE)

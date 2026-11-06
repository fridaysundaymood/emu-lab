# emu-lab

**Safe, parallel Android emulator testing for AI coding agents.**

emu-lab is an MCP server. An agent asks it for a device, runs instrumentation tests, Maestro flows, or a release smoke test, and gets back structured results with logs, screenshots, and a verdict on whether a failure is the app's fault, the test's fault, or the environment's. The agent never runs raw `adb` or `emulator` commands.

Part of [android-kit](https://github.com/fridaysundaymood/android-kit), a toolkit combining five tools for end-to-end Android development. Works on its own; no other kit tool required.

## Status

> **Planning stage: there is no code to install yet.** This repo holds the design in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Star or watch it to follow progress. First milestone: device leasing, host resource budget, emulator creation from profiles, and boot health checks.

## Who it's for

- Teams using AI agents (Claude Code, Cursor, or any MCP client) to write and test Android apps.
- Developers who run several emulators at once and lose time to overloaded hosts, leftover app state, or flaky failures.

## What it will do

| Capability | Details |
|---|---|
| Device leasing | Exclusive emulators with timeouts; respects a RAM/CPU budget; never touches emulators you started yourself |
| Device profiles | YAML profiles for system image, API level, RAM, GPU, locale, density; boot health checks with automatic retry |
| Build cache | Isolated Gradle builds keyed by source tree; the same build is reused, never rebuilt in parallel |
| Clean app state | Resets data, permissions, locale, font scale, density, dark mode, and network before every run |
| Test runners | Instrumentation (JUnit XML), Maestro flows (with one isolated rerun to detect flakiness), release smoke tests |
| Failure triage | Rule-based `app` / `test` / `environment` classification, with the evidence lines and artifacts behind it |
| Multi-device | Lease groups of devices for scenarios that need several phones |

## Out of scope

Cloud device farms, iOS, and provisioning physical devices (beyond adb passthrough).

## Contributing

The design is open for feedback. Open an issue to question scope, suggest a feature, or discuss an approach before sending a pull request. Use synthetic examples only: no private app code, production data, or credentials.

## License

[MIT](LICENSE)

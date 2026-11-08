# Changelog

## 0.1.0

- Harden MCP configuration, device shell arguments and emulator diagnostics; prepare the package for public npm distribution.

- Reclaim quarantined AVDs after their recorded emulator has exited, only when ownership and vacant ports are confirmed.
- Add a TypeScript library, CLI and tools-only MCP adapter for emulator leases, cached builds, device runners and evidence classification.
- Fix CLI and MCP startup when loading the public tool definitions.
- Detach leased emulators from the CLI and discover Maestro installations automatically.
- Stream instrumentation progress and report timed-out runs with partial output and logcat evidence.

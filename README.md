# emu-lab

Android emulator testing with leased devices, cached builds, device-state controls and evidence-based failure classification. The package provides a Node 24 TypeScript library, CLI and tools-only MCP server. See [the implementation plan](IMPLEMENTATION_PLAN.md) for the full intended behavior and [the API guide](docs/api.md) for in-process use.

## Install from source

Clone `android-kit` and `emu-lab` as sibling directories. In `android-kit`, run `npm install && npm run build`. In `emu-lab`, run `npm install && npm run build`. Android SDK tools, a compatible system image, JDK 21, hardware virtualization and Maestro 2.12.x are required for device workflows. `JAVA_HOME` must select JDK 21 for builds that target Java 21.

```sh
npx emu-lab doctor --json
npx emu-lab lab-status --json
npx emu-lab lease-device --profile software --json
npx emu-lab release-device --lease-id LEASE_ID --json
```

Options accept kebab-case flags; JSON objects and arrays can be passed as JSON strings. Each command returns the shared result envelope. Exit codes are 0 for pass, 1 for fail or flaky, and 2 for blocked, unsupported or error. Artifacts are stored below `.android-kit/runs/<run-id>/emu-lab/`. No telemetry is collected.

A generic MCP client can start the stdio server with an entry such as:

```json
{
  "mcpServers": {
    "emu-lab": {
      "command": "node",
      "args": ["/path/to/emu-lab/dist/mcp/index.js"]
    }
  }
}
```

Optional project configuration is read from `android-kit.yaml`:

```yaml
emuLab:
  budget: 1
  denySerials: []
  allowInstall: false
```

Never use a lease to control an independently owned emulator. Host GPU support varies with drivers and headless environments; select the software profile explicitly if host GPU is unavailable. Linux requires accessible KVM, Windows requires supported WHPX/AEHD virtualization, and macOS requires HVF. Emulator console authentication must remain enabled. Use synthetic data only.

The Windows default uses the API 36 Google Play x86-64 image, 2 GiB RAM, four cores and automatic GPU selection. The `software` profile explicitly requests SwiftShader. Set `headless: false` and select a profile with `gpu: host` to compare windowed host rendering; headless and host GPU performance depends on drivers and other host load. No renderer performance comparison is claimed until both modes complete on a quiet host. Before each boot the scheduler samples CPU utilization and blocks above `maxCpuLoad` (default `0.85`), reporting an environment result rather than booting into an overloaded host.

## License

[MIT](LICENSE)

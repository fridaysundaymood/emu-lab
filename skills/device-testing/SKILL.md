---

name: device-testing
description: Run Android tests on leased emu-lab devices.
---

1. Check prerequisites: CLI `emu-lab doctor --json`; MCP `emu_lab_doctor`.
2. Acquire a device: CLI `emu-lab lease-device --profile software --json`; MCP `emu_lab_lease_device` with `profile`.
3. Build: CLI `emu-lab build --variant cleanDebug --json`; MCP `emu_lab_build` with `variant`.
4. Run tests: CLI `emu-lab run-instrumentation --lease-id ID --package-name PACKAGE --runner RUNNER --json`; MCP `emu_lab_run_instrumentation` with corresponding arguments.
5. Run flows: CLI `emu-lab run-maestro --lease-id ID --package-name PACKAGE --flows '["flow.yaml"]' --json`; MCP `emu_lab_run_maestro`.
6. Release the device: CLI `emu-lab release-device --lease-id ID --json`; MCP `emu_lab_release_device`.

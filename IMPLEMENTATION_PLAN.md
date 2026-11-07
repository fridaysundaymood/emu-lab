# emu-lab: implementation plan

## Status

Milestone exit scenarios have been exercised with synthetic unit tests and a Windows emulator: shared-budget and expiry safety, debug/test/release cache reuse, zero-test and flaky runners, classifier golden cases, crash recovery, snapshots, and synthetic-signed release smoke. Linux and macOS emulator integration remains unverified locally; cross-platform unit checks are configured in CI. Synthetic release signing does not verify production signing.

## Problem and goal

Concurrent Android testing can overload a host, leak device state between runs, and make application failures difficult to distinguish from test or infrastructure failures. Provide exclusive access to healthy, isolated devices, predictable builds and state, and structured evidence without requiring callers to manage emulator commands.

Support a single host. Cloud device farms, iOS, and provisioning physical devices beyond adb passthrough are out of scope.

## Success criteria

- A CLI or MCP client can lease a device, run instrumentation and Maestro suites, and retrieve structured results without raw adb or emulator commands.
- Each test operation starts from its declared state; state does not leak between runs.
- The scheduler respects the configured host budget. Lease-scoped operations reject foreign serials, and user-owned emulators remain untouched, including after a crash.
- Failures include supporting evidence and an applicable `app`, `test`, `environment`, or `config` classification.
- An unattended representative campaign covering instrumentation, Maestro, and release smoke completes within a configurable time target.

## Architecture and interfaces

Implement a TypeScript core library on Node.js LTS, distributed as an npm package. Bun is optional. The CLI calls the library, and a thin MCP adapter exposes the same operations over stdio using tools only. Neither layer depends on client-specific features; optional MCP progress or elicitation must degrade gracefully. Everything exposed over MCP is available through the CLI and can run without an agent or MCP.

Every CLI command accepts `--json` and emits one result envelope conforming to the published JSON Schema package `kit-schema` (v1):

```json
{
  "schema_version": "1",
  "tool": "emu-lab",
  "operation": "lab_status",
  "run_id": "<run-id>",
  "status": "pass",
  "summary": "Lab status retrieved",
  "evidence": [],
  "artifacts": [],
  "started_at": "<timestamp>",
  "duration_ms": 0
}
```

The schema also allows optional `classification` with `app`, `test`, `environment`, or `config`. Status is `pass`, `fail`, `flaky`, `blocked`, `unsupported`, or `error`: `fail` means the thing under test failed, `error` means the tool itself failed, `blocked` means a precondition or policy refused the operation, and `unsupported` means a capability is unavailable, never silently skipped. `flaky` identifies a failure that passes its isolated rerun. CLI exit codes are 0 for `pass`, 1 for `fail`, and 2 for `error` or `blocked`; document `flaky` as 1 and `unsupported` as 2 so automation cannot mistake either for a clean pass. The envelope carries operation-specific data as defined by the shared schema; do not invent extra top-level fields if the schema forbids them.

Store leases, owned-device identities, builds, runs, and artifact indexes in SQLite. Place artifacts under `.android-kit/runs/<run-id>/emu-lab/` and return paths in the envelope. Invoke the Android emulator, adb, Gradle wrapper, and Maestro from the core.

## Components

### Host budget and lease scheduler

- Compute the initial emulator budget as `min(floor(free_RAM_GB / 4), floor(cores / 3))`, with a configuration override. Limit builds separately, defaulting to one release and two debug builds.
- `emu_lab_lease_device` returns a lease ID and serial and queues when the budget is full. Persist lease expiry and heartbeat deadlines; renewals must be atomic with expiry decisions. Reclaim and wipe on expiry only after the heartbeat is also missed. Provide `emu_lab_heartbeat` for long-running work and `emu_lab_release_device` for explicit release.
- Require a valid active lease ID for every device-scoped operation, including observation and group operations. Resolve the serial from that lease, or verify any supplied serial belongs to it; reject foreign serials before any adb, console, or destructive action. Group operations verify membership for every serial.
- Operate only on lab-created devices with persisted ownership identity and honor a configurable serial deny-list. Never touch a user-owned emulator. Release or expiry wipes only a verified lab-owned device after active work is stopped; an unverified or ambiguous device is quarantined for operator review rather than terminated or wiped.
- On startup, recover SQLite transactions, reconcile persisted leases and owned process identities against live emulators, and restore valid leases and budget reservations. Mark interrupted runs, resume safe cleanup idempotently, and reconcile or quarantine orphaned lab devices without acting on ambiguous ownership. Never infer ownership from a serial alone. Heartbeat and expiry rules still apply after restart.

### Device profiles and provisioning

- Define YAML profiles for system image, API, RAM, cores, GPU mode, root requirement, locale, and density. Provide a default-image host-GPU profile and a software-GPU fallback.
- Create AVDs from profile `.ini` and `config.ini` files when `avdmanager` is unavailable. Verify the pinned image is installed; install missing images via `sdkmanager` only when available and explicitly permitted.
- Check `sys.boot_completed`, package-manager responsiveness, absence of a System UI ANR window, and an unlocked screen. Retry once with a cold boot and `-wipe-data`, then report the lease as blocked with environment evidence.
- Optionally maintain a clean-booted quick-boot snapshot per profile. Verify ownership before deleting or replacing snapshots.
- For emulator console operations, read the local console auth token from its platform-defined location, authenticate before issuing commands, and restrict access to the local console. Never log, return, or persist the token in artifacts. Missing or unreadable authentication blocks console operations with a fix; never disable authentication as a fallback.

### Build cache

- `emu_lab_build` builds a commit or worktree and variants in an isolated Gradle build directory and separate `--project-cache-dir`, returning APK/AAB paths, signing digest, and version code.
- Key cached builds by tree hash and variant; concurrent requests for the same key share one build. Serialize release builds globally.

### App-state control

- `emu_lab_reset_app` clears app data, revokes runtime permissions, removes notification-listener grants, and restores font scale, display size and density, locale, automatic time, and unlocked rotation.
- `emu_lab_install` handles debug/release signing conflicts by uninstalling when needed, then verifies the installed version and signer.
- `emu_lab_set_device_state` controls locale, font scale, display size, clock where root is available, dark mode, battery saver, network conditions, and rotation.
- Every runner resets the app and applies the declared state first. Return `unsupported` when a requested capability is unavailable.

### Runners

- `emu_lab_run_instrumentation` runs the APK and test APK with an optional filter, records JUnit XML, fails if zero tests run, and captures relevant logcat on process crashes.
- `emu_lab_run_maestro` invokes the Maestro CLI using a declared supported version range checked by `doctor`. It returns per-flow results, failure screenshots, and hierarchies; rerun each failed flow once in isolation and report `flaky` if it passes on rerun.
- `emu_lab_smoke_release` launches the app, checks `FLAG_SECURE` via window state, and scans app-UID logcat for relevant missing-class or method and component-registration failures.
- `emu_lab_screen` returns hierarchy text, using retries and an accessibility-dump fallback, and a screenshot annotated when secure-window protection causes a blackout.

### Failure classifier

Use deterministic rules without an LLM. Store the rule set in a versioned, validated data file with explicit precedence and evidence matchers; record its version with each verdict. Golden tests cover matching, precedence, ambiguous evidence, and rule changes using synthetic logs and hierarchies. Every verdict includes evidence lines and artifact paths; leave classification absent when evidence is insufficient rather than guessing.

Initial rules cover `environment` for device offline, System UI ANR, incomplete boot, install failure, emulator process death, or excessive host load; `test` for a missing selector where the hierarchy shows the expected screen with changed copy, a pass on isolated rerun, or an assertion on state that reset should have established; and `app` for an app crash with app stack frames, an assertion failure on the expected screen, or an app-package ANR. A pass on rerun has status `flaky`, not `fail` or `pass`.

### Multi-device scenarios

Provide `emu_lab_lease_group` under the same host budget, plus lease-scoped adb reverse helpers and local-backend routing through the emulator host mapping. Group allocation is atomic: if all members cannot be allocated, release any partial reservations without touching unowned devices.

## CLI and MCP tool surface

Each row maps the CLI command `emu-lab <command> --json` to its equivalent MCP tool. Device-scoped commands require the lease ID; group-scoped commands require the group lease and relevant members.

| CLI command           | MCP tool                      | Purpose                                    |
| --------------------- | ----------------------------- | ------------------------------------------ |
| `doctor`              | `emu_lab_doctor`              | Check prerequisites and fixes              |
| `lab-status`          | `emu_lab_lab_status`          | Budget, leases, queued requests, host load |
| `lease-device`        | `emu_lab_lease_device`        | Lease a device with TTL                    |
| `heartbeat`           | `emu_lab_heartbeat`           | Renew a lease heartbeat                    |
| `release-device`      | `emu_lab_release_device`      | Release a device or group                  |
| `lease-group`         | `emu_lab_lease_group`         | Atomically lease a device group            |
| `build`               | `emu_lab_build`               | Cached, isolated variant builds            |
| `install`             | `emu_lab_install`             | Install an artifact                        |
| `reset-app`           | `emu_lab_reset_app`           | Reset app and device state                 |
| `set-device-state`    | `emu_lab_set_device_state`    | Apply declared device state                |
| `run-instrumentation` | `emu_lab_run_instrumentation` | Run instrumentation tests                  |
| `run-maestro`         | `emu_lab_run_maestro`         | Run Maestro flows                          |
| `smoke-release`       | `emu_lab_smoke_release`       | Run release smoke checks                   |
| `screen`              | `emu_lab_screen`              | Capture hierarchy and screenshot           |
| `logcat`              | `emu_lab_logcat`              | Collect device logs                        |
| `pull-artifact`       | `emu_lab_pull_artifact`       | Retrieve a run artifact                    |
| `reverse`             | `emu_lab_reverse`             | Configure lease-scoped adb reverse routing |
| `classify-failure`    | `emu_lab_classify_failure`    | Re-run triage on a stored failure          |

Ship plain Markdown skills in `SKILL.md` frontmatter format and an `AGENTS.md` snippet. Every skill step names both its CLI command and MCP equivalent from this table; instructions must work with any agent or with plain CI and never rely on a particular client.

## Configuration

Use only the `emuLab` section of `android-kit.yaml`; no other tool's section is required. Publish a JSON Schema for this section, reject unknown keys, and validate profiles, budgets, timeouts, tool versions, and artifact settings before acting. Support standalone use with this same section and defaults. Pin Android SDK platform-tools, emulator, command-line tools, and system-image package revisions in configuration or the released defaults; declare the supported Gradle wrapper and Maestro CLI version ranges. The doctor reports detected and required versions, missing or incompatible tools, and actionable fixes without silently installing them.

## Production readiness

Support Windows, macOS, and Linux. For CI and headless runs use `-no-window` and verify hardware acceleration: KVM access on Linux, WHPX or AEHD where supported on Windows, and HVF on macOS. Availability depends on host virtualization and runner permissions; doctor reports actionable prerequisites. Host GPU support varies by OS, driver, and headless environment; document platform-specific host-GPU limitations and use an explicit software-GPU profile when host rendering is unavailable, rather than silently changing the requested profile.

Declare and check external versions as described above. Publish with semver and maintain a CHANGELOG. CI runs unit tests on all three OSes and integration tests wherever emulator acceleration is feasible; other environments report an explicit reason for omission. Use structured logs with run and lease IDs, redact credentials and console tokens, and collect no telemetry. SQLite recovery, ownership reconciliation, interrupted-run marking, and idempotent re-runs are required from M1, not deferred hardening. Plan `SECURITY.md` and `CONTRIBUTING.md` for M1.

## Milestones

1. **Lease, profiles, and health:** library, CLI and stdio MCP adapter, shared envelope and schema validation, doctor, scheduler, persisted ownership, crash recovery, deny-list, profile-based AVD creation, boot checks, and status. Include security and contribution guidance. Exit: concurrent clients remain within budget, missed-heartbeat expiry is safe, and restarts leave user-owned emulators untouched.
2. **Build cache, install, and reset:** isolated Gradle builds, artifact cache, signature-aware installation, and state reset. Exit: synthetic fixture app debug, test, and release artifacts are built once and reused across runs.
3. **Runners:** instrumentation, Maestro CLI, and release smoke with artifacts and isolated reruns. Exit: synthetic suites return structured results including `flaky`, and zero-test runs are detected.
4. **Classifier and multi-device:** versioned data-driven rules, golden cases, and atomic group leases. Exit: synthetic stale-selector, leftover-state, System UI ANR, and app-crash fixtures are classified correctly.
5. **Hardening:** optional snapshots, expanded platform integration coverage, and documentation.

## Testing

- Use fake adb and emulator binaries for scheduler, lease authorization, recovery, and classifier unit tests. Cover heartbeat-versus-expiry races, foreign serials, orphan reconciliation, and ambiguous ownership.
- Run integration tests against a real emulator in a controlled local or CI environment where feasible. Exercise headless boot, interruption and restart, cleanup, and concurrent leases.
- Build a synthetic fixture app and synthetic logs and hierarchies for reproducible runner tests and classifier golden cases; do not use private app data or recordings.
- Test CLI and MCP parity, envelope schema and exit codes, unknown configuration keys, version checks, and token redaction.

## Kit compatibility

This tool is also a component of [android-kit](https://github.com/fridaysundaymood/android-kit/blob/main/IMPLEMENTATION_PLAN.md). The kit may compose the TypeScript library in-process; standalone CLI and MCP use must remain independent of other kit tools. Use the shared `kit-schema` envelope and synthetic `kit-fixture-app` from the first milestone.

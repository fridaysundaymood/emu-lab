# Library API

The package exports `Scheduler`, device runners, `build`, `classifyFailure`, and `dispatch`. Node 24 is required. Use one project-local SQLite database for all clients on a host.

The package root also exports `toolDefinitions({ projectRoot?, configPath?, dispatcher? })`, whose entries provide MCP names, descriptions, JSON input schemas, and asynchronous handlers returning the shared result envelope. Input can override the default project root or configuration path; the optional dispatcher supports embedding and testing. `doctor(args?)` returns the same envelope as the `emu_lab_doctor` handler. `configSection` is `emuLab`, `configSectionSchema` describes that configuration section, and `supportedSchemaMajors` lists the supported schema major versions. Importing the package does not start the MCP server; use the `emu-lab-mcp` executable for stdio.

```ts
import { Scheduler, runMaestro } from '@android-kit/emu-lab';

const lab = new Scheduler({
  databasePath: '.android-kit/emu-lab.sqlite',
  budget: 1,
});
const lease = await lab.lease({
  profile: 'software',
  ttlMs: 600000,
  heartbeatMs: 60000,
});
try {
  const result = await runMaestro(lab, {
    leaseId: lease.leaseId,
    packageName: 'dev.androidkit.fixture',
    flows: ['e2e/maestro/01-launch.yaml'],
    artifactDir: '.android-kit/runs/example/emu-lab',
  });
  console.log(result);
} finally {
  await lab.release(lease.leaseId);
  lab.close();
}
```

Use `heartbeat(leaseId)` during long operations. `leaseGroup({profiles: [...]})` allocates a group, and `authorize(leaseId, serial)` verifies its members. The runners accept a lease ID and optional serial; callers must not substitute an independently discovered serial. `dispatch(command, args)` returns the shared result envelope and is the common CLI/MCP entry point. Use `build({projectRoot, runId, variant})` for cached builds and `classifyFailure` for deterministic evidence-based triage. Consult the exported TypeScript declarations for complete option and result types.

The `emuLab.build` configuration accepts `variant` and `testVariant` defaults for the build operation. Explicit build arguments take precedence. `testVariant` selects the Android test assemble task and defaults to the selected `variant`; release builds do not assemble Android tests. Instrumentation and Maestro runs use the supplied APK paths and flows, not build variants.

Snapshots belong to the leased AVD and are removed on release. Call `lab.snapshot(leaseId, undefined, 'save', 'clean')`, then use `list`, `load`, or `delete` with the same lease; the CLI command `snapshot` and MCP tool `emu_lab_snapshot` accept `leaseId`, `action`, and `name`. Console authentication is required.

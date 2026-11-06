# Library API

The package exports `Scheduler`, device runners, `build`, `classifyFailure`, and `dispatch`. Node 24 is required. Use one project-local SQLite database for all clients on a host.

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
    flows: ['e2e/maestro/clean.yaml'],
    artifactDir: '.android-kit/runs/example/emu-lab',
  });
  console.log(result);
} finally {
  await lab.release(lease.leaseId);
  lab.close();
}
```

Use `heartbeat(leaseId)` during long operations. `leaseGroup({profiles: [...]})` allocates a group, and `authorize(leaseId, serial)` verifies its members. The runners accept a lease ID and optional serial; callers must not substitute an independently discovered serial. `dispatch(command, args)` returns the shared result envelope and is the common CLI/MCP entry point. Use `build({projectRoot, runId, variant})` for cached builds and `classifyFailure` for deterministic evidence-based triage. Consult the exported TypeScript declarations for complete option and result types.

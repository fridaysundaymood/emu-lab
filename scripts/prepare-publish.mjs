import { cp, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = await mkdtemp(join(tmpdir(), 'emu-lab-publish-'));
await cp(root, output, {
  recursive: true,
  filter: (source) =>
    !['.git', 'node_modules', '.android-kit'].includes(
      source.slice(root.length + 1).split(/[\\/]/)[0],
    ),
});
const manifestPath = join(output, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
for (const section of [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
]) {
  for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
    if (name.startsWith('@budaknyenyel/') && spec.startsWith('file:')) {
      const target = JSON.parse(
        await readFile(resolve(root, spec.slice(5), 'package.json'), 'utf8'),
      );
      manifest[section][name] = `^${target.version}`;
    }
  }
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await symlink(
  join(root, 'node_modules'),
  join(output, 'node_modules'),
  process.platform === 'win32' ? 'junction' : 'dir',
);
console.log(output);

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: npm run android:release -- --apk <independent-arm64.apk> --acceptance <verified-acceptance.json> --out <new-release.apk>');
  process.exit(0);
}
if (process.platform !== 'win32') throw new Error('This local signing adapter requires Windows DPAPI');
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  if (!['--apk', '--acceptance', '--out'].includes(name) || !args[index + 1] || options.has(name)) {
    throw new Error('Expected unique --apk, --acceptance and --out path arguments');
  }
  options.set(name, args[index + 1]);
}
if (options.size !== 3) throw new Error('The independent APK, matching full acceptance evidence and a new output path are required');
const script = fileURLToPath(new URL('./android-release.ps1', import.meta.url));
const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
  '-Apk', options.get('--apk'), '-Acceptance', options.get('--acceptance'), '-Out', options.get('--out')], { stdio: 'inherit' });
process.exit(result.status ?? 1);

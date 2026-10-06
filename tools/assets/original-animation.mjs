import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
let python = 'python';
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--python') continue;
  if (!args[i + 1] || args[i + 1].startsWith('--')) {
    throw new Error('--python requires an executable path (Pillow in that isolated environment)');
  }
  python = args[i + 1];
  args.splice(i, 2);
  i--;
}
const child = spawn(python, [path.join(root, 'tools/assets/original-animation.py'), ...args], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});
child.on('error', (error) => {
  console.error(`Could not start the selected Python: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) console.error(`Animation bake stopped by ${signal}`);
  process.exitCode = code ?? 1;
});

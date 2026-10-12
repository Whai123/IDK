import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children = [
  spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'], { cwd, stdio: 'inherit', env: process.env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { cwd, stdio: 'inherit', env: process.env }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach(child => child.kill('SIGTERM'));
  const deadline = setTimeout(() => {
    children.forEach(child => child.kill('SIGKILL'));
    process.exit(code);
  }, 3000);
  deadline.unref();
  Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolveExit => child.once('exit', resolveExit))))
    .then(() => process.exit(code));
}

for (const child of children) {
  child.once('error', error => {
    console.error(error.message);
    stop(1);
  });
  child.once('exit', (code, signal) => {
    if (!stopping) stop(signal ? 1 : (code || 0));
  });
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());

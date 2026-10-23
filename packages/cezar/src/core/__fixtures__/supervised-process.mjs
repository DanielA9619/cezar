import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(import.meta.url);
if (process.argv[2] === 'grandchild') {
  setInterval(() => {}, 1000);
} else if (process.argv[2] === 'child') {
  const grandchild = spawn(process.execPath, [file, 'grandchild'], { stdio: 'ignore', windowsHide: true });
  process.send({ child: process.pid, grandchild: grandchild.pid });
  setInterval(() => {}, 1000);
} else {
  const child = spawn(process.execPath, [file, 'child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  child.on('message', value => console.log(JSON.stringify({ ready: true, argv: process.argv[3], ...value })));
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    if (line === 'exit') process.exit(0);
    console.log(JSON.stringify({ echo: line }));
  });
  lines.on('close', () => { if (process.argv[2] !== 'ignore-eof') process.exit(0); });
  setInterval(() => {}, 1000);
}

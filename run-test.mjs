import { spawn } from 'child_process';

const proc = spawn('npx', ['vitest', 'run', 'src/copy-trading/tests/CopyMetricsRecorder.test.ts'], {
  stdio: 'inherit',
  shell: true
});

proc.on('close', code => process.exit(code));

#!/usr/bin/env node
// Fixed verifier for the disposable mock repository; it launches no project code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

try {
  const content = readFileSync(join(process.cwd(), 'mock-implementation.txt'), 'utf8');
  if (content === 'corrected\n') {
    process.stdout.write('Mock verification passed after correction.\n');
  } else {
    process.stderr.write('Mock verification found the simulated implementation defect.\n');
    process.exitCode = 1;
  }
} catch {
  process.stderr.write('Mock implementation artifact is missing.\n');
  process.exitCode = 1;
}

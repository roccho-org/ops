import { execFileSync } from 'node:child_process';

// Existing generated Python test command; propagate output and failure.
execFileSync('semlint-core-check', ['--source'], { stdio: 'inherit' });

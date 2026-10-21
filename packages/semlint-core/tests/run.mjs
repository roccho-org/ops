import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Keep source mechanics and fresh-wheel consumer checks as distinct gates.
execFileSync('semlint-core-check', ['--source'], { stdio: 'inherit' });
execFileSync('python3', ['-B', fileURLToPath(new URL('./distribution.py', import.meta.url))], { stdio: 'inherit' });

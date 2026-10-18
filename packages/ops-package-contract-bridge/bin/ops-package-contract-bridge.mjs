#!/usr/bin/env node
import process from 'node:process';
import {
  buildPhase2Bundle,
  verifyPhase2Bundle,
} from '../src/phase2.mjs';
import {
  buildPhase2V4Bundle,
  verifyPhase2V4Bundle,
} from '../src/phase2-v4.mjs';
import {
  buildPhase2V5Bundle,
  verifyPhase2V5Bundle,
} from '../src/phase2-v5.mjs';
import {
  buildPhase3Bundle,
  verifyPhase3Bundle,
} from '../src/phase3.mjs';
import { serveDist } from '../src/serve.mjs';
import {
  stableJson,
  verifyPhase1Bundle,
} from '../src/verify.mjs';

function usage() {
  process.stderr.write([
    'usage:',
    '  ops-package-contract-bridge verify-phase1 BUNDLE_DIR',
    '  ops-package-contract-bridge build-phase2 --ops-source DIR --ops-candidate-sha SHA --out DIR [--repository OWNER/REPO]',
    '  ops-package-contract-bridge verify-phase2 BUNDLE_DIR',
    '  ops-package-contract-bridge build-phase2-v4 --ops-source DIR --ops-candidate-sha SHA --local-source-universe FILE --out DIR [--repository OWNER/REPO]',
    '  ops-package-contract-bridge verify-phase2-v4 BUNDLE_DIR',
    '  ops-package-contract-bridge build-phase2-v5 --ops-source DIR --ops-candidate-sha SHA --local-source-universe FILE --out DIR [--repository OWNER/REPO]',
    '  ops-package-contract-bridge verify-phase2-v5 BUNDLE_DIR',
    '  ops-package-contract-bridge build-phase3 --phase1-bundle DIR --phase2-bundle DIR --ui-source DIR --apps-source DIR --ui-revision SHA --apps-revision SHA --package-map-command FILE --package-map-viewer FILE --ops-candidate-sha SHA --out DIR',
    '  ops-package-contract-bridge verify-phase3 BUNDLE_DIR',
    '  ops-package-contract-bridge serve-dist --dir DIST [--host 127.0.0.1] [--port 4173]',
    '',
  ].join('\n'));
}

function flags(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument pair: ${key ?? ''}`);
    if (Object.hasOwn(values, key)) throw new Error(`duplicate argument: ${key}`);
    values[key] = value;
  }
  return values;
}

function exactFlags(args, allowed, required) {
  const values = flags(args);
  for (const key of Object.keys(values)) if (!allowed.includes(key)) throw new Error(`unknown argument: ${key}`);
  for (const key of required) if (!values[key]) throw new Error(`missing argument: ${key}`);
  return values;
}

function parsePhase2Flags(args, sourceUniverse = false) {
  const common = ['--ops-source', '--ops-candidate-sha', '--out', '--repository'];
  return exactFlags(
    args,
    [...common, ...(sourceUniverse ? ['--local-source-universe'] : [])],
    ['--ops-source', '--ops-candidate-sha', '--out', ...(sourceUniverse ? ['--local-source-universe'] : [])],
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (['verify-phase1', 'verify-phase2', 'verify-phase2-v4', 'verify-phase2-v5', 'verify-phase3'].includes(command)) {
    if (args.length !== 1) { usage(); process.exit(2); }
    const result = command === 'verify-phase1'
      ? verifyPhase1Bundle(args[0])
      : command === 'verify-phase2'
        ? verifyPhase2Bundle(args[0])
        : command === 'verify-phase2-v4'
          ? verifyPhase2V4Bundle(args[0])
          : command === 'verify-phase2-v5'
            ? verifyPhase2V5Bundle(args[0])
            : await verifyPhase3Bundle(args[0]);
    process.stdout.write(`${stableJson(result)}\n`);
    return;
  }

  if (['build-phase2', 'build-phase2-v4', 'build-phase2-v5'].includes(command)) {
    const sourceUniverse = command !== 'build-phase2';
    const values = parsePhase2Flags(args, sourceUniverse);
    const common = {
      opsSource: values['--ops-source'],
      opsCandidateSha: values['--ops-candidate-sha'],
      outDir: values['--out'],
      repository: values['--repository'] ?? 'roccho-org/ops',
    };
    const result = command === 'build-phase2'
      ? buildPhase2Bundle(common)
      : command === 'build-phase2-v4'
        ? buildPhase2V4Bundle({ ...common, localSourceUniverseFile: values['--local-source-universe'] })
        : buildPhase2V5Bundle({ ...common, localSourceUniverseFile: values['--local-source-universe'] });
    process.stdout.write(`${stableJson(result)}\n`);
    return;
  }

  if (command === 'build-phase3') {
    const required = [
      '--phase1-bundle', '--phase2-bundle', '--ui-source', '--apps-source',
      '--ui-revision', '--apps-revision', '--package-map-command', '--package-map-viewer',
      '--ops-candidate-sha', '--out',
    ];
    const values = exactFlags(args, required, required);
    const result = await buildPhase3Bundle({
      phase1Bundle: values['--phase1-bundle'],
      phase2Bundle: values['--phase2-bundle'],
      uiSource: values['--ui-source'],
      appsSource: values['--apps-source'],
      uiRevision: values['--ui-revision'],
      appsRevision: values['--apps-revision'],
      packageMapCommand: values['--package-map-command'],
      packageMapViewer: values['--package-map-viewer'],
      opsCandidateSha: values['--ops-candidate-sha'],
      outDir: values['--out'],
    });
    process.stdout.write(`${stableJson(result)}\n`);
    return;
  }

  if (command === 'serve-dist') {
    const values = exactFlags(args, ['--dir', '--host', '--port'], ['--dir']);
    serveDist({ dir: values['--dir'], host: values['--host'] ?? '127.0.0.1', port: values['--port'] ?? '4173' });
    return;
  }

  usage();
  process.exit(2);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});

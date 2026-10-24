import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';

const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const namespace = fs.readlinkSync('/proc/self/ns/pid');
export const sameContext = identity => identity?.bootId === bootId && identity?.namespace === namespace;

// Linux process start identity, group and parent; PID alone is never sufficient.
export function processIdentity(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return {bootId, namespace, pid: Number(pid), state: fields[0], ppid: Number(fields[1]), group: Number(fields[2]), start: fields[19]};
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    throw error;
  }
}
export function alive(identity) {
  const current = processIdentity(identity.pid);
  return sameContext(identity) && current?.start === identity.start && current.state !== 'Z';
}
export function discover(root, known = []) {
  const key = p => `${p.pid}:${p.start}`;
  const found = new Map(known.map(p => [key(p), p]));
  if (root) found.set(key(root), root);
  // A stale root PID is not an ancestry anchor for its replacement process.
  const anchors = new Set([...found.values()].filter(alive).map(p => p.pid));
  const currentRoot = root ? processIdentity(root.pid) : null;
  const groupBelongsToAttempt = sameContext(root) && (!currentRoot || currentRoot.start === root.start);
  const all = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)).map(processIdentity).filter(Boolean);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of all) {
      if (!found.has(key(p)) && ((groupBelongsToAttempt && p.group === root.pid) || anchors.has(p.ppid))) {
        found.set(key(p), p);
        if (alive(p)) anchors.add(p.pid);
        changed = true;
      }
    }
  }
  return [...found.values()];
}
export async function stopTree(root, known) {
  if (!sameContext(root)) throw Error('process namespace/boot unknown: HOLD');
  const identities = discover(root, known);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (root && alive(root)) { try { process.kill(-root.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    for (const p of identities) if (alive(p)) { try { process.kill(p.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    for (let i = 0; i < 25 && identities.some(alive); i++) await delay(20);
  }
  if (identities.some(alive)) throw Error('unresolved live descendants: HOLD');
  return identities;
}

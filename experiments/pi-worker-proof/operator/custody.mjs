/** One owner registration, one OS lock, one atomic durable record. No token diagnostics. */
import { constants } from "node:fs";
import { open, mkdir, lstat, rename, unlink, access } from "node:fs/promises";
import { dirname, join, resolve, parse } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const flock = await access("/run/current-system/sw/bin/flock").then(() => "/run/current-system/sw/bin/flock", () => "/usr/bin/flock");
async function checked(path, mode, directory = false) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== mode || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error("Unsafe owner custody metadata");
  }
}
async function parents(path) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe custody parent");
  }
}
export async function withRegistration(path, operation) {
  path = resolve(path);
  const dir = dirname(path);
  await parents(dirname(dir));
  await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  await checked(dir, 0o700, true);
  const lock = await open(path + ".lock", constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await checked(path + ".lock", 0o600);
    // flock(2) belongs to the inherited open-file description. Closing our fd releases it,
    // including on process death; no stale-lock deletion or persistent helper is involved.
    await new Promise((accept, reject) => {
      const child = spawn(flock, ["--exclusive", "--wait", "30", "3"], {
        stdio: ["ignore", "ignore", "ignore", lock.fd],
      });
      child.once("error", () => reject(new Error("Owner lock unavailable")));
      child.once("exit", code => code === 0 ? accept() : reject(new Error("Owner lock unavailable")));
    });
    let record;
    try {
      await checked(path, 0o600);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { record = JSON.parse(await file.readFile("utf8")); } finally { await file.close(); }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    async function save(next) {
      const temporary = join(dir, "." + randomUUID() + ".tmp");
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(JSON.stringify(next) + "\n");
        await file.sync();
      } finally { await file.close(); }
      try {
        await rename(temporary, path);
        const directory = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
        try { await directory.sync(); } finally { await directory.close(); }
        record = next;
      } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    }
    return await operation({ get: () => record, save });
  } finally { await lock.close(); }
}

export function ready(record, host) {
  if (record?.state !== "READY" || record.host !== host || !record.credential ||
      !record.credential.clientId || !record.credential.identity?.subject) {
    throw new Error("Owner registration unavailable; explicit recovery required");
  }
  return record.credential;
}
export function refreshTiming(credential, now = Date.now()) {
  if (!Number.isFinite(credential.actualExpiresAt)) throw new Error("Actual expiry unavailable");
  const raw = credential.earliestRefreshAt;
  let earliest = credential.actualExpiresAt;
  if (raw !== undefined) {
    if (typeof raw === "number") {
      earliest = Math.ceil(raw * 1000); // Protocol schema: Unix seconds, never magnitude guessing.
    } else if (typeof raw === "string") {
      const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(raw);
      if (!iso) throw new Error("Refresh timing invalid");
      const [, y,m,d,h,min,s,fraction,oh,om] = iso;
      if (+m < 1 || +m > 12 || +d < 1 || +d > new Date(Date.UTC(+y,+m,0)).getUTCDate() ||
          +h > 23 || +min > 59 || +s > 59 || +(oh ?? 0) > 23 || +(om ?? 0) > 59) throw new Error("Refresh timing invalid");
      earliest = Date.parse(raw);
      if (fraction?.length > 3 && /[1-9]/.test(fraction.slice(3))) earliest += 1;
    } else throw new Error("Refresh timing schema unresolved");
    if (!Number.isFinite(earliest) || earliest < 0 || earliest > 8.64e15) throw new Error("Refresh timing invalid");
  }
  const due = Math.max(credential.actualExpiresAt, earliest);
  return { allowed: now >= due, status: now >= due ? "PERMITTED_AT_ACTUAL_EXPIRY" : "NOT_DUE" };
}
export async function replaceCredential(store, host, kind, obtain) {
  const previous = store.get();
  if (previous && previous.host !== host) throw new Error("Registration host mismatch");
  const old = previous?.credential;
  const registeredClient = old?.clientId ?? previous?.pendingClientId;
  if (kind === "refresh") {
    ready(previous, host);
    if (!refreshTiming(old).allowed) throw new Error("Refresh timing not admitted");
  } else if (kind !== "login" && kind !== "reauth") throw new Error("Unknown credential operation");
  if (kind === "login" && previous) throw new Error("Registration already exists");
  if (kind === "reauth" && !(old?.clientId || previous?.pendingClientId)) throw new Error("Registered client unavailable");
  // A conservative premark BEFORE even starting authorization covers the eventual token POST.
  // Callback cancellation remains unusable until explicit owner reauthorization.
  await store.save({ ...previous, host, state: "IN_DOUBT", operation: kind, credential: old });
  const next = await obtain(old);
  if (!next?.identity?.subject || !next.clientId || !next.refresh || !next.access ||
      (registeredClient && next.clientId !== registeredClient) ||
      (old && (next.clientId !== old.clientId || next.identity.subject !== old.identity.subject))) {
    throw new Error("Registration replacement identity mismatch");
  }
  await store.save({ ...store.get(), host, state: "READY", operation: undefined, pendingClientId: undefined, rotations: (previous?.rotations ?? 0) + (kind === "refresh" ? 1 : 0), credential: next });
  return next;
}

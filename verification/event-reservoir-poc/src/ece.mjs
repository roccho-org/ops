import { PocError } from './store.mjs';

const utf8 = new TextEncoder();
export function decode(value) {
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new PocError('INVALID_KEY_ENCODING');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
export function encode(value) { return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function join(...parts) {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
async function hkdf(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}
function parameter(value, name) {
  const match = value?.split(/[;,]/).map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  if (!match) throw new PocError('ENCRYPTION_HEADER_REQUIRED');
  return decode(match.slice(name.length + 1).replace(/^"|"$/g, ''));
}

// RFC 8291 single-record aes128gcm, plus Mozilla/X's older aesgcm encoding.
export async function decryptNotification(notification, keys) {
  try {
    const data = decode(notification.data);
    const publicKey = decode(keys.public_key);
    const privateKey = decode(keys.private_key);
    const auth = decode(keys.auth_secret);
    if (data.length > 8192 || publicKey.length !== 65 || publicKey[0] !== 4 || privateKey.length !== 32 || auth.length !== 16) throw new Error();
    const encoding = notification.headers?.encoding ?? 'aes128gcm';
    let salt, sender, ciphertext, context;
    if (encoding === 'aes128gcm') {
      if (data.length < 103 || data[20] !== 65) throw new Error();
      const rs = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(16);
      salt = data.slice(0, 16); sender = data.slice(21, 86); ciphertext = data.slice(86);
      if (rs < 18 || ciphertext.length > rs) throw new Error();
    } else if (encoding === 'aesgcm') {
      salt = parameter(notification.headers?.encryption, 'salt');
      sender = parameter(notification.headers?.crypto_key, 'dh'); ciphertext = data;
      context = join(utf8.encode('P-256\0'), new Uint8Array([0, 65]), publicKey, new Uint8Array([0, 65]), sender);
    } else throw new Error();
    if (salt.length !== 16 || sender.length !== 65 || sender[0] !== 4) throw new Error();
    const receiver = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: encode(publicKey.slice(1, 33)), y: encode(publicKey.slice(33)), d: encode(privateKey), ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const peer = await crypto.subtle.importKey('raw', sender, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, receiver, 256));
    const ikm = await hkdf(shared, auth, encoding === 'aesgcm' ? utf8.encode('Content-Encoding: auth\0') : join(utf8.encode('WebPush: info\0'), publicKey, sender), 32);
    const cek = await hkdf(ikm, salt, join(utf8.encode(`Content-Encoding: ${encoding}\0`), context ?? new Uint8Array()), 16);
    const nonce = await hkdf(ikm, salt, join(utf8.encode('Content-Encoding: nonce\0'), context ?? new Uint8Array()), 12);
    const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, ciphertext));
    let content;
    if (encoding === 'aes128gcm') {
      let end = plaintext.length - 1;
      while (end >= 0 && plaintext[end] === 0) end--;
      if (end < 0 || plaintext[end] !== 2) throw new Error();
      content = plaintext.slice(0, end);
    } else {
      if (plaintext.length < 2) throw new Error();
      const padding = plaintext[0] * 256 + plaintext[1];
      if (padding + 2 > plaintext.length || plaintext.slice(2, 2 + padding).some(x => x !== 0)) throw new Error();
      content = plaintext.slice(2 + padding);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch { throw new PocError('WEBPUSH_DECRYPT_FAILED'); }
}

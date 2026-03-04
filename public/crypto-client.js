// public/crypto-client.js — E2E encryption helpers (HKDF, AES-GCM)
// For DM: key = HKDF(userId_A | userId_B | serverSalt)
// For group: key = HKDF("group" | serverSalt | groupId)
'use strict';

async function hkdf(salt, ikm, length = 32) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(ikm),
    { name: 'HKDF' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(salt), info: enc.encode('nexlink-v1') },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

async function deriveDmKey(userIdA, userIdB, serverSalt) {
  const pair = [userIdA, userIdB].sort().join('|');
  const raw = await hkdf(serverSalt, pair);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function deriveGroupKey(serverSalt, groupId) {
  const raw = await hkdf(serverSalt, 'group|' + groupId);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function randomIv() {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  return iv;
}

async function encrypt(key, plaintext) {
  const enc = new TextEncoder();
  const iv = randomIv();
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext)
  );
  return {
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(ct))),
    iv: btoa(String.fromCharCode(...iv)),
  };
}

async function decrypt(key, ciphertext, iv) {
  const ct = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const ivArr = Uint8Array.from(atob(iv), c => c.charCodeAt(0));
  const dec = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivArr },
    key,
    ct
  );
  return new TextDecoder().decode(dec);
}

function decodeLegacyPayload(ciphertext, iv) {
  try {
    // Old format (ASCII-safe): base64(JSON string)
    const decoded = atob(ciphertext || '');
    const json = JSON.parse(decoded);
    if (json && typeof json.text === 'string') return { text: json.text, id: json.id };
  } catch {}
  try {
    // New format (UTF-8 safe): base64(utf8 bytes of JSON string)
    const bytes = Uint8Array.from(atob(ciphertext || ''), c => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const json = JSON.parse(decoded);
    if (json && typeof json.text === 'string') return { text: json.text, id: json.id };
  } catch {}
  return null;
}

function encodeLegacyPayload(obj) {
  const enc = new TextEncoder();
  const bytes = enc.encode(JSON.stringify(obj || {}));
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

window.NexLinkCrypto = {
  deriveDmKey,
  deriveGroupKey,
  encrypt,
  decrypt,
  decodeLegacyPayload,
  encodeLegacyPayload,
};

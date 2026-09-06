#!/usr/bin/env node
// Pack the QuickListing Cookie Bridge extension into a signed CRX3 + generate the
// Chrome self-hosted update manifest (update.xml). PROTOTYPE release tooling.
//
// Usage:
//   node pack.mjs --genkey                 # one-time: create key.pem + write manifest "key" + print the extension ID
//   node pack.mjs [--bump=patch|minor|major] [--cdn=https://your.cdn/cookie-bridge]
//                                          # zip → CRX3-sign → dist/cookie-bridge-<ver>.crx + dist/update.xml
//
// Requires the PRIVATE key at ./key.pem (gitignored). It MUST correspond to the
// public key committed in manifest.json ("key"), or the packed CRX's extension
// ID won't match the load-unpacked ID. If you regenerate the key (--genkey) the
// ID CHANGES — update EXT_ID in src/main/facebook/bridgeInstaller.ts and the
// README, and re-host update.xml/CRX.
//
// The CRX is signed with RSA (the id-defining proof). Output is CRX3, which is
// what current Chrome/Edge accept. Zip is built with `archiver` (already a repo
// dep). No other external tooling (no chrome binary) needed.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  createSign,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';

const DIR = dirname(fileURLToPath(import.meta.url));
const KEY_PATH = join(DIR, 'key.pem');
const MANIFEST_PATH = join(DIR, 'manifest.json');
const DIST = join(DIR, 'dist');
const DEFAULT_CDN = 'https://REPLACE-ME.cdn/cookie-bridge'; // swap for your real CDN base

// Files that ship INSIDE the extension zip (never the key, pack script, dist, docs).
const INCLUDE = [
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.js',
  'icons/icon-16.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
];

function readManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
}

/** Extension ID = first 16 bytes of sha256(DER SPKI public key), hex→[a-p]. */
function extIdFromDer(der) {
  const hash = createHash('sha256').update(der).digest().subarray(0, 16);
  return [...hash]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .split('')
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');
}

function pubDerFromPrivate(priv) {
  return createPublicKey(priv).export({ type: 'spki', format: 'der' });
}

function genKey() {
  if (existsSync(KEY_PATH)) {
    console.error(
      `Refusing to overwrite existing ${KEY_PATH}. Delete it first if you really mean to.`,
    );
    process.exit(1);
  }
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const der = pubDerFromPrivate(privateKey);
  const manifest = readManifest();
  manifest.key = der.toString('base64');
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  const id = extIdFromDer(der);
  console.log('Generated key.pem (KEEP IT SECRET — gitignored).');
  console.log('Wrote public key into manifest.json "key".');
  console.log('Extension ID:', id);
  console.log(
    '>>> Update EXT_ID in src/main/facebook/bridgeInstaller.ts and the README to this value.',
  );
}

function bumpVersion(kind) {
  const manifest = readManifest();
  const parts = String(manifest.version)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  if (kind === 'major') {
    parts[0]++;
    parts[1] = 0;
    parts[2] = 0;
  } else if (kind === 'minor') {
    parts[1]++;
    parts[2] = 0;
  } else {
    parts[2]++;
  }
  manifest.version = parts.join('.');
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log('Bumped version →', manifest.version);
  return manifest.version;
}

/** Build the extension zip (in memory) from INCLUDE files. */
function buildZip() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('data', (c) => chunks.push(c));
    archive.on('warning', (e) => console.warn('zip warning:', e.message));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const f of INCLUDE) {
      const p = join(DIR, f);
      if (!existsSync(p)) return reject(new Error(`missing extension file: ${f}`));
      archive.file(p, { name: f });
    }
    archive.finalize();
  });
}

// ── CRX3 container ───────────────────────────────────────────────────────────
// Layout: "Cr24" | uint32LE(3) | uint32LE(headerLen) | header | zip
// header = CrxFileHeader protobuf:
//   field 2 (sha256_with_rsa): repeated AsymmetricKeyProof { 1: public_key, 2: signature }
//   field 10000 (signed_header_data): SignedData { 1: crx_id (16 bytes) }
// signature is RSASSA-PKCS1-v1_5(SHA256) over:
//   "CRX3 SignedData\x00" | uint32LE(len(signed_header_data)) | signed_header_data | zip

function pbVarint(n) {
  const out = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}
function pbLenField(fieldNo, wireType, payload) {
  const tag = (fieldNo << 3) | wireType;
  return Buffer.concat([pbVarint(tag), pbVarint(payload.length), payload]);
}

function crx3(zip, priv) {
  const der = pubDerFromPrivate(priv);
  const crxId = createHash('sha256').update(der).digest().subarray(0, 16);

  // SignedData { field 1: crx_id }
  const signedHeaderData = pbLenField(1, 2, crxId);

  // Signature input.
  const magic = Buffer.from('CRX3 SignedData\x00', 'latin1');
  const lenLE = Buffer.alloc(4);
  lenLE.writeUInt32LE(signedHeaderData.length, 0);
  const signer = createSign('RSA-SHA256');
  signer.update(Buffer.concat([magic, lenLE, signedHeaderData, zip]));
  const signature = signer.sign(priv);

  // AsymmetricKeyProof { 1: public_key, 2: signature }
  const proof = Buffer.concat([pbLenField(1, 2, der), pbLenField(2, 2, signature)]);
  // CrxFileHeader { 2: sha256_with_rsa (proof), 10000: signed_header_data }
  const header = Buffer.concat([pbLenField(2, 2, proof), pbLenField(10000, 2, signedHeaderData)]);

  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'latin1');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return { crx: Buffer.concat([prefix, header, zip]), id: extIdFromDer(der) };
}

function writeUpdateXml(id, version, cdn) {
  const codebase = `${cdn.replace(/\/+$/, '')}/cookie-bridge-${version}.crx`;
  const xml =
    `<?xml version='1.0' encoding='UTF-8'?>\n` +
    `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n` +
    `  <app appid='${id}'>\n` +
    `    <updatecheck codebase='${codebase}' version='${version}' />\n` +
    `  </app>\n` +
    `</gupdate>\n`;
  writeFileSync(join(DIST, 'update.xml'), xml);
  return { codebase };
}

async function pack(args) {
  if (!existsSync(KEY_PATH)) {
    console.error(
      `No ${KEY_PATH}. Run \`node pack.mjs --genkey\` first (one-time), or restore the release key.`,
    );
    process.exit(1);
  }
  const bump = args.find((a) => a.startsWith('--bump'));
  if (bump) bumpVersion(bump.split('=')[1] || 'patch');
  const cdnArg = args.find((a) => a.startsWith('--cdn='));
  const cdn = cdnArg ? cdnArg.split('=')[1] : DEFAULT_CDN;

  const manifest = readManifest();
  const version = manifest.version;
  const priv = createPrivateKey(readFileSync(KEY_PATH));

  // Sanity: committed manifest "key" must match the signing key, else the packed
  // ID differs from the load-unpacked ID.
  const signingDerB64 = pubDerFromPrivate(priv).toString('base64');
  if (manifest.key && manifest.key !== signingDerB64) {
    console.error(
      'manifest.json "key" does NOT match key.pem — packed ID would differ from unpacked.',
    );
    console.error(
      'Fix: run --genkey, or restore the key.pem that matches the committed manifest "key".',
    );
    process.exit(1);
  }

  if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true });
  const zip = await buildZip();
  const { crx, id } = crx3(zip, priv);
  const crxPath = join(DIST, `cookie-bridge-${version}.crx`);
  writeFileSync(crxPath, crx);
  // Standalone zip too (load-unpacked / Web Store submission / release asset).
  const zipPath = join(DIST, `quicklisting-bridge-${version}.zip`);
  writeFileSync(zipPath, zip);
  const { codebase } = writeUpdateXml(id, version, cdn);

  console.log('Extension ID:', id);
  console.log('CRX:         ', crxPath, `(${(crx.length / 1024).toFixed(1)} KB)`);
  console.log('ZIP:         ', zipPath, `(${(zip.length / 1024).toFixed(1)} KB)`);
  console.log('update.xml:  ', join(DIST, 'update.xml'));
  console.log('codebase:    ', codebase);
  if (cdn === DEFAULT_CDN) {
    console.log(
      '\n⚠  Using the PLACEHOLDER CDN. Re-run with --cdn=https://your.real.cdn/cookie-bridge',
    );
    console.log('   and also set runtime_config urls.cookieBridgeUpdateUrl to <cdn>/update.xml.');
  }
  console.log('\nRelease: upload the .crx AND update.xml to your CDN at the paths above.');
}

const args = process.argv.slice(2);
if (args.includes('--genkey')) {
  genKey();
} else {
  pack(args).catch((err) => {
    console.error('pack failed:', err);
    process.exitCode = 1;
  });
}

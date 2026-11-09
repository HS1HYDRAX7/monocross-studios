// Object storage (DBByte, S3-compatible). Runs only on the server: the secret key never reaches the browser.
// The endpoint and bucket are not secrets, so they live here. Only the two keys come from Vercel.
const crypto = require('crypto');

const REGION = 'us-east-1';
const SERVICE = 's3';
const HOST = 's3.dbbyte.com';
const BUCKET = 'monocross-studios';
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;

const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm', json: 'application/json',
};

function credentials() {
  const accessKeyId = (process.env.DBBYTE_ACCESS_KEY_ID || '').trim();
  const secret = (process.env.DBBYTE_SECRET_ACCESS_KEY || '').trim();
  if (!accessKeyId || !secret) throw new Error('Missing DBBYTE_ACCESS_KEY_ID or DBBYTE_SECRET_ACCESS_KEY in Vercel');
  return { accessKeyId, secret };
}

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function encodePath(key) {
  return key.split('/').map(encodeRfc3986).join('/');
}

// Path-style request: https://s3.dbbyte.com/<bucket>/<key>
function requestPath(key) {
  return key ? `/${BUCKET}/${encodePath(key)}` : `/${BUCKET}/`;
}

function canonicalQuery(params) {
  return Object.keys(params).sort()
    .map(name => `${encodeRfc3986(name)}=${encodeRfc3986(String(params[name]))}`)
    .join('&');
}

// AWS Signature Version 4. Pure function, so it can be checked against AWS's published test vector.
function sigv4({ method, host, path, query = '', headers, payloadHash, accessKeyId, secret, amzDate, region = REGION, service = SERVICE }) {
  const dateStamp = amzDate.slice(0, 8);
  const lower = {};
  for (const name of Object.keys(headers)) lower[name.toLowerCase()] = headers[name];
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map(name => `${name}:${String(lower[name]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + secret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return { signature, signedHeaders, scope };
}

function amzDateNow() {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
}

// Request signed in the Authorization header.
async function request(method, key, { query = {}, body = null, contentType } = {}) {
  const { accessKeyId, secret } = credentials();
  const amzDate = amzDateNow();
  const payloadHash = sha256(body == null ? '' : body);
  const headers = { host: HOST, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (contentType) headers['content-type'] = contentType;
  const qs = canonicalQuery(query);
  const path = requestPath(key);
  const { signature, signedHeaders, scope } = sigv4({ method, host: HOST, path, query: qs, headers, payloadHash, accessKeyId, secret, amzDate });
  const sent = { ...headers };
  delete sent.host; // fetch sets Host itself, and it matches the signed value
  sent.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return fetch(`https://${HOST}${path}${qs ? '?' + qs : ''}`, { method, headers: sent, body: body == null ? undefined : body });
}

// Link that works without credentials, for a limited time. Used for downloads and direct browser uploads.
function presign(method, key, seconds, contentType = '') {
  const { accessKeyId, secret } = credentials();
  const amzDate = amzDateNow();
  const path = requestPath(key);
  const base = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${amzDate.slice(0, 8)}/${REGION}/${SERVICE}/aws4_request`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.min(seconds, WEEK_SECONDS)),
    'X-Amz-SignedHeaders': contentType ? 'content-type;host' : 'host',
  };
  const qs = canonicalQuery(base);
  const signingHeaders = contentType ? { 'content-type': contentType, host: HOST } : { host: HOST };
  const { signature } = sigv4({ method, host: HOST, path, query: qs, headers: signingHeaders, payloadHash: 'UNSIGNED-PAYLOAD', accessKeyId, secret, amzDate });
  return `https://${HOST}${path}?${qs}&X-Amz-Signature=${signature}`;
}

function fileNameOf(file) {
  return typeof file === 'string' ? file : file.fileName;
}

function guessType(name) {
  const ext = name.split('.').pop().toLowerCase();
  return TYPES[ext] || 'application/octet-stream';
}

async function uploadBytes(key, content, contentType = 'application/octet-stream') {
  const response = await request('PUT', key, { body: content, contentType });
  if (!response.ok) throw new Error(`Storage upload failed (${response.status}): ${await response.text().catch(() => '')}`.slice(0, 300));
}

async function readJson(key) {
  const response = await request('GET', key);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read ${key} (${response.status})`);
  return response.json();
}

function decodeXml(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function tag(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? decodeXml(match[1]) : null;
}

async function listFiles(prefix) {
  const files = [];
  let token = null;
  do {
    const query = { 'list-type': '2', prefix };
    if (token) query['continuation-token'] = token;
    const response = await request('GET', '', { query });
    if (!response.ok) throw new Error(`Storage listing failed (${response.status})`);
    const xml = await response.text();
    for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const fileName = tag(item, 'Key');
      files.push({
        fileName,
        contentLength: Number(tag(item, 'Size') || 0),
        contentType: guessType(fileName),
        uploadTimestamp: Date.parse(tag(item, 'LastModified') || '') || 0,
      });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? tag(xml, 'NextContinuationToken') : null;
  } while (token);
  return files;
}

async function deleteFile(file) {
  const response = await request('DELETE', fileNameOf(file));
  if (!response.ok && response.status !== 404) throw new Error(`Storage delete failed (${response.status})`);
}

function signedUrl(key) {
  return presign('GET', key, WEEK_SECONDS);
}

function presignUpload(key, contentType) {
  return presign('PUT', key, HOUR_SECONDS, contentType);
}

// Stored media can be a full link (older updates) or a plain path. Both become the path in the bucket.
function mediaPath(src) {
  const text = String(src || '');
  const marker = '/file/';
  const at = text.indexOf(marker);
  if (at === -1) return safeDecode(text);
  const rest = text.slice(at + marker.length);
  return safeDecode(rest.slice(rest.indexOf('/') + 1).split('?')[0]);
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch (err) {
    return text;
  }
}

module.exports = { signedUrl, mediaPath, presignUpload, uploadBytes, readJson, listFiles, deleteFile, sigv4, encodeRfc3986 };

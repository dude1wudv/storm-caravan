import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const input = await readFile(path.join(root, 'assets/original-data/original-story.json'));
const story = JSON.parse(input);
const entries = [];
for (const id of ['1', '2', '3', '4', '5', '6', '7']) {
  const name = story.texts.business.filter((text) => text.table === 'Helphandbook' && text.id === id && text.field === 'name');
  const info = story.texts.business.filter((text) => text.table === 'Helphandbook' && text.id === id && text.field === 'info');
  const minTitle = story.texts.business.filter((text) => text.table === 'Helphandbook' && text.id === id && text.field === 'minTitle');
  if (name.length !== 1 || info.length !== 1 || minTitle.length !== 1 || !name[0].text || !info[0].text) throw new Error(`Exact original Helphandbook ${id} name/minTitle/info required`);
  entries.push({ id, title: name[0].text, minTitle: minTitle[0].text, text: info[0].text, origin: 'original', nameSourceUid: name[0].source_uid, minTitleSourceUid: minTitle[0].source_uid, textSourceUid: info[0].source_uid });
}
await writeFile(path.join(root, 'assets/original-data/original-help.json'), JSON.stringify({ schemaVersion: 1, origin: 'original', sourceVersion: story.sourceVersion, sourceSha256: createHash('sha256').update(input).digest('hex'), entries }) + '\n');
console.log(JSON.stringify({ ok: true, originalHelpTabs: entries.map((entry) => entry.title), textCharacters: entries.reduce((n, entry) => n + entry.text.length, 0) }));

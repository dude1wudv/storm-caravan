import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ContactEntry { id: string; image: string; status: string; note?: string }
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));

export async function contactSheet(entries: ContactEntry[], output: string, columns = 4, background = '#ddddda') {
  if (!entries.length) throw new Error('Contact sheet requires actual images');
  const cellWidth = 340, imageHeight = 240, cellHeight = 292;
  const layers: sharp.OverlayOptions[] = [];
  for (const [index, entry] of entries.entries()) {
    const left = (index % columns) * cellWidth, top = Math.floor(index / columns) * cellHeight;
    const image = await sharp(entry.image).resize(cellWidth - 16, imageHeight - 12, { fit: 'contain', background }).flatten({ background }).png().toBuffer();
    layers.push({ input: image, left: left + 8, top: top + 6 });
    const label = `<svg width="${cellWidth}" height="52"><rect width="100%" height="100%" fill="#f7f7f2"/><text x="10" y="19" font-family="sans-serif" font-size="15" fill="#222">${escape(entry.id)}</text><text x="10" y="39" font-family="sans-serif" font-size="12" fill="#555">${escape(entry.status + (entry.note ? ' · ' + entry.note : ''))}</text></svg>`;
    layers.push({ input: Buffer.from(label), left, top: top + imageHeight });
  }
  await mkdir(path.dirname(output), { recursive: true });
  await sharp({ create: { width: columns * cellWidth, height: Math.ceil(entries.length / columns) * cellHeight, channels: 3, background } }).composite(layers).png().toFile(output);
  await writeFile(output.replace(/\.png$/, '.json'), JSON.stringify({ output, background, entries }, null, 2));
  return output;
}

import { randomInt } from 'crypto';

export function pickUniqueRandom(items, winnersCount) {
  const total = items.length;
  if (winnersCount <= 0) return [];
  if (winnersCount >= total) return [...items];
  const selected = new Set();
  while (selected.size < winnersCount) {
    const idx = randomInt(0, total);
    selected.add(idx);
  }
  return [...selected].map((i) => items[i]);
}



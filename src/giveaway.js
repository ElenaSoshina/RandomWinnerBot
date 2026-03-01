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

export function pickUniqueWeighted(items, winnersCount, getWeight) {
  if (!Array.isArray(items) || items.length === 0 || winnersCount <= 0) return [];

  const pool = items.map((item) => ({
    item,
    weight: Math.max(1, Number(getWeight(item)) || 1),
  }));

  const need = Math.min(winnersCount, pool.length);
  const winners = [];

  for (let i = 0; i < need; i += 1) {
    const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0);
    let cursor = randomInt(0, totalWeight);
    let selectedIdx = 0;
    for (; selectedIdx < pool.length; selectedIdx += 1) {
      cursor -= pool[selectedIdx].weight;
      if (cursor < 0) break;
    }
    winners.push(pool[selectedIdx].item);
    pool.splice(selectedIdx, 1);
  }

  return winners;
}



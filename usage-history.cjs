const { readFile, writeFile, rename } = require('node:fs/promises');

const hour = 60 * 60 * 1000;
const agents = ['codex', 'claude'];

function createUsageHistory(file) {
  let stored;
  return async (usage, now = Date.now()) => {
    stored ??= await readFile(file, 'utf8').then(JSON.parse).catch(() => ({}));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
    const currentHour = Math.floor(now / hour);
    const charts = {};
    let changed = false;
    for (const agent of agents) {
      const { levels = {}, last } = stored[agent] ?? {};
      const reading = usage[agent]?.find(window => window.label === '7 days');
      const time = Math.min(now, reading?.observedAt ?? now);
      let next = last;
      if (last && !stored[agent]?.levels && Number.isFinite(last.used)) {
        levels[Math.floor(last.time / hour)] = last.used;
        changed = true;
      }
      if (reading && (!last || time > last.time) && time >= now - 168 * hour) {
        levels[Math.floor(time / hour)] = reading.used;
        next = { time, used: reading.used };
        changed = true;
      }
      for (const key of Object.keys(levels)) {
        if (Number(key) <= currentHour - 168) {
          delete levels[key];
          changed = true;
        }
      }
      stored[agent] = { last: next, levels };
      const series = count => Array.from({ length: count }, (_, index) => {
        const bucket = currentHour + index + 1 - count;
        return { start: bucket * hour, used: levels[bucket] ?? null };
      });
      charts[agent] = { daily: series(24), weekly: series(168) };
    }
    if (changed) {
      try {
        await writeFile(file + '.tmp', JSON.stringify(stored));
        await rename(file + '.tmp', file);
      } catch {
        // Keep live charts available if the profile cannot be written.
      }
    }
    return charts;
  };
}

module.exports = { createUsageHistory };

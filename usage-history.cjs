const { readFile, writeFile, rename } = require('node:fs/promises');

const hour = 60 * 60 * 1000;
const agents = ['codex', 'claude'];

function hourStart(time) {
  const date = new Date(time);
  // Subtract elapsed minutes so repeated hours on a clock change stay distinct.
  return time - ((date.getMinutes() * 60 + date.getSeconds()) * 1000 + date.getMilliseconds());
}

function dayStart(time, offset = 0) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date.getTime();
}

function addedUsage(previous, reading) {
  if (!previous || reading.time - previous.time >= 168 * hour) return null;
  if (previous.reset && reading.time >= previous.reset * 1000) {
    return reading.reset && reading.reset > previous.reset ? reading.used : null;
  }
  if (reading.used < previous.used && !previous.reset && !reading.reset) return reading.used;
  return Math.max(0, reading.used - previous.used);
}

function addToHour(hours, time, used) {
  if (used === null) return;
  const bucket = hourStart(time);
  hours[bucket] = (hours[bucket] ?? 0) + used;
}

function migrateLevels(levels) {
  const hours = {};
  let previous;
  for (const [bucket, used] of Object.entries(levels).sort(([a], [b]) => Number(a) - Number(b))) {
    const time = Number(bucket) * hour;
    if (!Number.isFinite(time) || !Number.isFinite(used) || used < 0) continue;
    const reading = { time, used };
    addToHour(hours, time, addedUsage(previous, reading));
    previous = reading;
  }
  return hours;
}

function createUsageHistory(file) {
  let stored;
  return async (usage, now = Date.now()) => {
    stored ??= await readFile(file, 'utf8').then(JSON.parse).catch(() => ({}));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
    const currentHour = hourStart(now);
    const days = Array.from({ length: 7 }, (_, index) => dayStart(now, index - 6));
    const charts = {};
    let changed = false;
    for (const agent of agents) {
      const previous = stored[agent];
      const hours = previous?.hours ?? migrateLevels(previous?.levels ?? {});
      let last = previous?.last;
      if (previous?.levels) changed = true;
      const reading = usage[agent]?.find(window => window.label === '7 days');
      const time = Math.min(now, reading?.observedAt ?? now);
      if (reading && (!last || time > last.time) && time >= now - 168 * hour) {
        const next = { time, used: reading.used, reset: reading.reset };
        addToHour(hours, time, addedUsage(last, next));
        last = next;
        changed = true;
      }
      const totals = new Map();
      for (const [key, used] of Object.entries(hours)) {
        const start = Number(key);
        if (start < days[0]) {
          delete hours[key];
          changed = true;
          continue;
        }
        if (start > currentHour) continue;
        const day = dayStart(start);
        totals.set(day, (totals.get(day) ?? 0) + used);
      }
      stored[agent] = { last, hours };
      const daily = Array.from({ length: 24 }, (_, index) => {
        const start = currentHour + (index - 23) * hour;
        return { start, used: hours[start] ?? null };
      });
      const weekly = days.map(start => ({ start, used: totals.get(start) ?? null }));
      charts[agent] = { daily, weekly };
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

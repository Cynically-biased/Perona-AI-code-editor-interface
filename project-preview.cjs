const fs = require('node:fs/promises');
const path = require('node:path');

const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const drive = process.env.SystemDrive || 'C:';
const xamppRoot = path.join(drive, 'xampp');

async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
}

async function localHosts(file = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/drivers/etc/hosts')) {
  const hosts = new Set(loopback);
  const external = new Set();
  for (const line of (await readOptional(file)).split(/\r?\n/)) {
    const [ip, ...names] = line.split('#')[0].trim().toLowerCase().split(/\s+/);
    for (const name of names) {
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name)) continue;
      if (ip === '127.0.0.1' || ip === '::1') hosts.add(name);
      else external.add(name);
    }
  }
  for (const name of external) if (!loopback.has(name)) hosts.delete(name);
  return hosts;
}

function directives(config, name) {
  return config.split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(new RegExp('^' + name + '\\s+(.*)', 'i'));
    return match ? [Array.from(match[1].matchAll(/"([^"]*)"|([^\s#]+)/g), token => token[1] ?? token[2])] : [];
  });
}

function relativeTo(root, target) {
  const relative = path.relative(root, target);
  return path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep) ? null : relative;
}

function urlFor(base, route, remainder) {
  const suffix = remainder.split(/[\\/]/).filter(Boolean).map(encodeURIComponent).join('/');
  const parts = [route.replace(/^\/+|\/+$/g, ''), suffix].filter(Boolean);
  return new URL(parts.length ? '/' + parts.join('/') + '/' : '/', base).href;
}

async function suggestPreview(folder, root = xamppRoot, hostsFile) {
  const apache = path.join(root, 'apache');
  const config = await readOptional(path.join(apache, 'conf/httpd.conf'));
  if (!config.trim()) return null;
  const hosts = await localHosts(hostsFile);
  const variables = new Map(directives(config, 'Define').filter(([key, value]) => key && value));
  variables.set('SRVROOT', variables.get('SRVROOT') || apache);
  const resolvePath = value => path.resolve(apache, value.replace(/\$\{([^}]+)\}/g, (match, name) => variables.get(name) ?? match));
  const canonical = async value => fs.realpath(value).catch(() => path.resolve(value));
  const project = await canonical(folder);
  const port = directives(config, 'Listen').map(args => Number(args[0]?.match(/(?:^|:)(\d+)$/)?.[1]))
    .find(value => Number.isInteger(value) && value > 0 && value <= 65535) || 80;
  const base = 'http://localhost' + (port === 80 ? '' : ':' + port);
  const sourceParts = [config];
  for (const [include] of [...directives(config, 'Include'), ...directives(config, 'IncludeOptional')]) {
    if (!include || !/(?:vhosts|xampp|ssl)[^\\/]*\.conf$/i.test(include)) continue;
    const file = resolvePath(include);
    if (relativeTo(apache, file) !== null) sourceParts.push(await readOptional(file));
  }
  const source = sourceParts.join('\n').replace(/^\s*#.*$/gm, '');
  const vhosts = Array.from(source.matchAll(/<VirtualHost\s+([^>]+)>([\s\S]*?)<\/VirtualHost>/gi));
  const global = source.replace(/<VirtualHost\s+[^>]+>[\s\S]*?<\/VirtualHost>/gi, '');
  const documentRoot = directives(config, 'DocumentRoot')[0]?.[0];
  const webRoot = documentRoot ? await canonical(resolvePath(documentRoot)) : null;
  const candidates = [];
  async function add(rootValue, origin, route, priority, allowAncestor = false) {
    if (!rootValue) return;
    const mapped = await canonical(resolvePath(rootValue));
    const remainder = relativeTo(mapped, project);
    if (remainder !== null) {
      candidates.push({ score: priority + mapped.length, url: urlFor(origin, route, remainder) });
    } else if (allowAncestor && project !== webRoot) {
      const child = relativeTo(project, mapped);
      if (child && /(?:^|[\\/])(?:public|web|www)$/i.test(child) && child.split(path.sep).length <= 3) {
        candidates.push({ score: priority - child.length, url: urlFor(origin, route, '') });
      }
    }
  }
  for (const [, binding, body] of vhosts) {
    const [configured] = directives(body, 'ServerName')[0] || [];
    const names = [configured, ...directives(body, 'ServerAlias').flat()].filter(Boolean);
    const declaredPort = Number(binding.trim().split(/\s+/)[0].match(/:(\d+)$/)?.[1]) || port;
    for (const name of names) {
      const host = name.replace(/:\d+$/, '').toLowerCase();
      if (!hosts.has(host) || host === 'localhost' || declaredPort < 1 || declaredPort > 65535) continue;
      const origin = (declaredPort === 443 ? 'https://' : 'http://') + host
        + ([80, 443].includes(declaredPort) ? '' : ':' + declaredPort);
      await add(directives(body, 'DocumentRoot')[0]?.[0], origin, '/', 1000, true);
      for (const [route, target] of directives(body, 'Alias')) if (route?.startsWith('/')) await add(target, origin, route, 1050, true);
      break;
    }
  }
  for (const [route, target] of directives(global, 'Alias')) if (route?.startsWith('/')) await add(target, base, route, 800, true);
  if (webRoot && project !== webRoot) await add(webRoot, base, '/', 100);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.url ?? null;
}

module.exports = { localHosts, suggestPreview };

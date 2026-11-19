const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const root = path.join(process.env.SystemDrive || 'C:', 'xampp');
const definitions = {
  apache: { label: 'Apache', exe: 'apache/bin/httpd.exe', log: 'apache/logs/error.log',
    configs: ['apache/conf/httpd.conf', 'apache/conf/extra/httpd-vhosts.conf', 'apache/conf/extra/httpd-ssl.conf', 'php/php.ini'],
    admin: 'http://localhost/dashboard/' },
  mysql: { label: 'MariaDB / MySQL', exe: 'mysql/bin/mysqld.exe', log: 'mysql/data/mysql_error.log',
    configs: ['mysql/bin/my.ini'], admin: 'http://localhost/phpmyadmin/' },
  filezilla: { label: 'FileZilla', exe: 'FileZillaFTP/FileZillaServer.exe',
    alternate: 'FileZillaFTP/FileZilla server.exe', logFolder: 'FileZillaFTP/Logs',
    configs: ['FileZillaFTP/FileZillaServer.xml', 'FileZillaFTP/FileZilla Server.xml'] },
  mercury: { label: 'Mercury', exe: 'MercuryMail/mercury.exe', logFolder: 'MercuryMail/LOGS',
    configs: ['MercuryMail/MERCURY.INI'] },
  tomcat: { label: 'Tomcat', exe: 'tomcat/bin/tomcat8.exe', logFolder: 'tomcat/logs',
    configs: ['tomcat/conf/server.xml', 'tomcat/conf/context.xml', 'tomcat/conf/tomcat-users.xml'],
    admin: 'http://localhost:8080/' }
};
const operations = new Set();
const issues = new Map();
const quote = value => "'" + value.replaceAll("'", "''") + "'";

async function ps(script) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference='Stop'; " + script, 'utf16le').toString('base64')],
  { windowsHide: true, timeout: 10000, encoding: 'utf8' });
  return stdout.trim();
}

function normalized(value) {
  return path.normalize(value).toLowerCase();
}

function validateModule(id) {
  if (!Object.hasOwn(definitions, id)) throw new Error('Unknown XAMPP module.');
  return definitions[id];
}

async function listeners() {
  const { stdout } = await run('netstat.exe', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 7000 });
  return stdout.split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^TCP\s+(\S+):(\d+)\s+(?:0\.0\.0\.0|\[::\]):0\s+\S+\s+(\d+)$/i);
    return match ? [{ address: match[1], port: Number(match[2]), pid: Number(match[3]) }] : [];
  });
}

async function inspect() {
  const [raw, network] = await Promise.all([ps(
    "$p = @(Get-CimInstance Win32_Process -Filter \"Name='httpd.exe' OR Name='mysqld.exe' OR Name='FileZillaServer.exe' OR Name='FileZilla server.exe' OR Name='mercury.exe' OR Name='tomcat8.exe' OR Name='java.exe' OR Name='javaw.exe'\" | Select-Object ExecutablePath,ProcessId,CommandLine); " +
    "$s = @(Get-CimInstance Win32_Service | Where-Object {$_.PathName -match '(httpd|mysqld|filezilla\s*server|mercury|tomcat8)\.exe'} | Select-Object Name,State,PathName,ProcessId); " +
    "@{processes=$p;services=$s} | ConvertTo-Json -Compress"
  ), listeners().catch(() => [])]);
  const data = JSON.parse(raw);
  return Promise.all(Object.entries(definitions).map(async ([id, info]) => {
    const executable = path.join(root, info.exe);
    const paths = new Set([info.exe, info.alternate].filter(Boolean).map(item => normalized(path.join(root, item))));
    const installed = await fs.access(executable).then(() => true, () => false);
    const service = data.services.find(entry => {
      const command = entry.PathName?.match(/^\s*"([^"]+)"|^\s*(.+?\.exe)(?:\s|$)/i);
      return command && paths.has(normalized(command[1] || command[2]));
    });
    const tomcat = normalized(path.join(root, 'tomcat'));
    const processes = data.processes.filter(entry => {
      if (entry.ExecutablePath && paths.has(normalized(entry.ExecutablePath))) return true;
      if (id !== 'tomcat' || !entry.ExecutablePath || !/javaw?\.exe$/i.test(entry.ExecutablePath)) return false;
      const command = entry.CommandLine?.replaceAll('/', '\\').toLowerCase() || '';
      const base = command.match(/-dcatalina\.base=([^"\r\n]+?)(?:"|\s+-|$)/)?.[1];
      return base?.trim() === tomcat && /org\.apache\.catalina\.startup\.bootstrap\s+start\b/.test(command);
    }).map(({ ProcessId, ExecutablePath }) => ({ ProcessId, ExecutablePath }));
    const pids = [...new Set([...processes.map(item => item.ProcessId), service?.ProcessId].filter(Boolean))];
    const ports = [...new Set(network.filter(item => pids.includes(item.pid)).map(item => item.port))].sort((a, b) => a - b);
    return { id, label: info.label, installed, service: service && { Name: service.Name, State: service.State },
      processes, pids, ports, running: Boolean(service?.State === 'Running' || processes.length),
      busy: operations.has(id), issue: issues.get(id) || '',
      canRegister: ['apache', 'mysql', 'filezilla', 'tomcat'].includes(id), configs: info.configs };
  }));
}

async function readLog(id) {
  const definition = validateModule(id);
  let log = definition.log && path.join(root, definition.log);
  if (!log && definition.logFolder) {
    const folder = path.join(root, definition.logFolder);
    const files = await fs.readdir(folder, { withFileTypes: true }).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    });
    const dated = await Promise.all(files.filter(file => file.isFile() && /\.(log|out)$/i.test(file.name))
      .map(async file => {
        const target = path.join(folder, file.name);
        return { target, time: (await fs.stat(target)).mtimeMs };
      }));
    log = dated.sort((a, b) => b.time - a.time)[0]?.target;
  }
  if (!log) return '';
  const file = await fs.open(log, 'r').catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!file) return '';
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - 32000);
    const data = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(data, 0, data.length, start);
    return data.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

async function serviceCommand(service, action) {
  if (!/^[\w .\-$]+$/.test(service.Name)) throw new Error('Invalid Windows service name.');
  await run('sc.exe', [action, service.Name], { windowsHide: true, timeout: 10000 });
}

async function stopApache(processes) {
  const pid = Number((await fs.readFile(path.join(root, 'apache/logs/httpd.pid'), 'utf8')).trim());
  if (!processes.some(info => info.ProcessId === pid)) throw new Error('Apache’s parent process could not be verified.');
  await ps("$p=Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid +
    "'; if ($p.ExecutablePath -ine " + quote(path.join(root, definitions.apache.exe)) +
    ") { throw 'Apache is no longer running.' }; " +
    "$event=[Threading.EventWaitHandle]::OpenExisting('ap" + pid + "_shutdown'); try { [void]$event.Set() } finally { $event.Dispose() }");
}

async function stopDatabase(processes) {
  const config = path.join(root, 'mysql/bin/my.ini');
  const ini = await fs.readFile(config, 'utf8');
  const server = ini.match(/^\[mysqld\]\s*([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] || '';
  const client = ini.match(/^\[client\]\s*([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] || '';
  const user = /^\s*user\s*=/m.test(client) ? [] : ['--user=root'];
  const port = Number(server.match(/^\s*port\s*=\s*(\d+)\s*$/m)?.[1] || 3306);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('The MariaDB port is invalid.');
  const listening = JSON.parse(await ps("@(Get-NetTCPConnection -LocalPort " + port +
    " -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess) | ConvertTo-Json -Compress") || '[]');
  const owners = Array.isArray(listening) ? listening : [listening];
  if (owners.length && owners.every(pid => processes.some(info => info.ProcessId === pid))) {
    await run(path.join(root, 'mysql/bin/mysqladmin.exe'), [
      '--defaults-file=' + config, '--protocol=tcp', '--host=127.0.0.1', '--port=' + port, ...user, 'shutdown'
    ], { cwd: root, windowsHide: true, timeout: 10000 });
  } else {
    throw new Error('Perona could not verify which process owns MariaDB’s port.');
  }
}

async function launch(executable, args, cwd, options = {}) {
  const child = spawn(executable, args, { cwd, windowsHide: true, detached: true, stdio: 'ignore', ...options });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return child;
}

async function tomcatEnvironment() {
  const env = { ...process.env, CATALINA_HOME: path.join(root, 'tomcat'), CATALINA_BASE: path.join(root, 'tomcat') };
  if (!env.JAVA_HOME && !env.JRE_HOME) {
    try {
      const { stdout } = await run('where.exe', ['java.exe'], { windowsHide: true, timeout: 3000 });
      const first = stdout.trim().split(/\r?\n/)[0];
      const executable = await fs.realpath(first);
      env.JAVA_HOME = path.dirname(path.dirname(executable));
    } catch {
      throw new Error('Tomcat needs Java. Install a JDK and set JAVA_HOME.');
    }
  }
  return env;
}

function runTomcat(script, args, env) {
  return run('cmd.exe', ['/d', '/c', 'call', script, ...args], {
    env, cwd: path.join(root, 'tomcat/bin'), windowsHide: true, timeout: 15000
  });
}

async function requestMercuryClose(processes) {
  const pids = processes.map(process => process.ProcessId).filter(Number.isSafeInteger);
  if (!pids.length) throw new Error('Mercury’s process could not be verified.');
  await ps("$sent=$false; foreach($id in @(" + pids.join(',') + ")) { " +
    "$p=Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p.Path -ieq " +
    quote(path.join(root, definitions.mercury.exe)) + " -and $p.CloseMainWindow()) {$sent=$true} }; " +
    "if (!$sent) { throw 'Open Mercury Admin to shut down Mercury gracefully.' }");
}

async function registerModule(id, action, info) {
  if (!info.canRegister) throw new Error('This module does not support service registration.');
  if (info.running || info.service?.State && info.service.State !== 'Stopped') {
    throw new Error('Stop the module before changing its Windows service registration.');
  }
  const install = action === 'install';
  if (install === Boolean(info.service)) return;
  const exe = path.join(root, definitions[id].exe);
  const options = { cwd: root, windowsHide: true, timeout: 15000 };
  if (!install && id !== 'tomcat') return serviceCommand(info.service, 'delete');
  if (id === 'apache') return run(exe, ['-k', 'install', '-n', 'Apache2.4'], options);
  if (id === 'mysql') return run(exe, ['--install', 'mysql', '--defaults-file=' + path.join(root, 'mysql/bin/my.ini')], options);
  if (id === 'filezilla') return run(exe, ['/install'], options);
  return runTomcat('service.bat', [install ? 'install' : 'remove', install ? 'Tomcat8' : info.service.Name],
    await tomcatEnvironment());
}

async function control(id, action) {
  const definition = validateModule(id);
  if (!['start', 'stop', 'install', 'remove'].includes(action) || operations.has(id)) return;
  operations.add(id);
  issues.delete(id);
  try {
    const info = (await inspect()).find(entry => entry.id === id);
    if (!info.installed) throw new Error('XAMPP module is unavailable at ' + root + '.');
    if (action === 'install' || action === 'remove') {
      await registerModule(id, action, info);
      return;
    }
    if (info.running === (action === 'start')) return;
    if (info.service) await serviceCommand(info.service, action);
    else if (id === 'filezilla') await run(path.join(root, definition.exe), ['/' + action],
      { cwd: path.join(root, 'FileZillaFTP'), windowsHide: true, timeout: 12000 });
    else if (id === 'tomcat') await runTomcat('catalina.bat', [action], await tomcatEnvironment());
    else if (action === 'stop') {
      if (id === 'apache') await stopApache(info.processes);
      else if (id === 'mysql') await stopDatabase(info.processes);
      else await requestMercuryClose(info.processes);
    } else {
      const executable = path.join(root, definition.exe);
      const args = id === 'mysql' ? ['--defaults-file=' + path.join(root, 'mysql/bin/my.ini'), '--standalone'] : [];
      const cwd = id === 'mercury' ? path.dirname(executable) : root;
      const child = await launch(executable, args, cwd, { windowsHide: id !== 'mercury' });
      child.on('exit', code => { if (code) issues.set(id, 'Exited with code ' + code + '. Check the module log.'); });
    }
  } catch (error) {
    issues.set(id, String(error.stderr || error.stdout || error.message).trim().slice(0, 900));
  } finally {
    operations.delete(id);
  }
}

const panelConfigs = ['xampp-control.ini'];
function configPaths(id) {
  return id === 'panel' ? panelConfigs : validateModule(id).configs;
}

async function openAdmin(id, shell) {
  const definition = validateModule(id);
  if (definition.admin) return shell.openExternal(definition.admin);
  if (id === 'filezilla') {
    const cwd = path.join(root, 'FileZillaFTP');
    await launch(path.join(cwd, 'FileZilla Server Interface.exe'), [], cwd, { windowsHide: false });
  } else {
    const info = (await inspect()).find(entry => entry.id === id);
    if (!info.running) throw new Error('Start Mercury before opening its admin window.');
    const pids = info.pids.filter(Number.isSafeInteger);
    await ps("$shell = New-Object -ComObject WScript.Shell; foreach($id in @(" +
      pids.join(',') + ")) { if ($shell.AppActivate($id)) { exit 0 } }; throw 'Mercury has no visible admin window.'");
  }
}

async function utility(action, shell) {
  if (action === 'explorer') {
    const error = await shell.openPath(root);
    if (error) throw new Error(error);
  } else if (action === 'shell') {
    await launch('cmd.exe', ['/d', '/k', 'call', 'xampp_shell.bat'], root, { windowsHide: false });
  } else if (action === 'windows-services') {
    await launch('mmc.exe', ['services.msc'], root, { windowsHide: false });
  } else if (action === 'help') {
    await shell.openExternal('https://www.apachefriends.org/faq_windows.html');
  }
}

module.exports = { root, inspect, readLog, control, listeners, configPaths, openAdmin, utility };

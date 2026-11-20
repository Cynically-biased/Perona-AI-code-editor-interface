const { spawn } = require('node:child_process');
const { open } = require('node:fs/promises');

function windowUsage(label, used, reset) {
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  if (reset && reset * 1000 <= Date.now()) return null;
  return { label, used, reset: reset || null };
}

function codexUsage(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['app-server', '--listen', 'stdio://'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
    });
    const timer = setTimeout(() => finish(new Error('Usage request timed out.')), 10000);
    function finish(error, result) {
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(result);
    }
    function send(message) { child.stdin.write(JSON.stringify(message) + '\n'); }
    child.on('error', finish);
    child.stdin.on('error', finish);
    child.on('exit', () => finish(new Error('Usage service exited.')));
    require('node:readline').createInterface({ input: child.stdout }).on('line', line => {
      let reply;
      try { reply = JSON.parse(line); } catch { return; }
      if (reply.id === 1 && !reply.error) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read' });
      } else if (reply.id === 1 || reply.id === 2) {
        const rates = reply.result?.rateLimitsByLimitId?.codex ?? reply.result?.rateLimits;
        finish(reply.error ? new Error('Account limits unavailable.') : null,
          [rates?.primary, rates?.secondary].filter(Boolean).map(rate => {
            const minutes = rate.windowDurationMins;
            const label = minutes === 10080 ? '7 days' : minutes === 300 ? '5 hours'
              : minutes ? minutes + ' min' : 'Usage';
            return windowUsage(label, rate.usedPercent, rate.resetsAt);
          }).filter(Boolean));
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'perona', version: '1.0.0' } } });
  });
}

function claudeUsageSettings(file) {
  // Keep only the quota fields. Claude supplies them through its native status line.
  const destination = "'" + file.replaceAll("'", "''") + "'";
  const script = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $data = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($null -ne $data.rate_limits) {
      $file = ${destination}
      $tmp = "$file.$PID.tmp"
      try {
        $data.rate_limits | ConvertTo-Json -Compress | Set-Content -LiteralPath $tmp -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $file -Force
      } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp }
      }
    }
  `;
  return JSON.stringify({ statusLine: {
    type: 'command',
    command: 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' +
      Buffer.from(script, 'utf16le').toString('base64')
  } });
}

async function claudeUsage(file) {
  const handle = await open(file, 'r');
  try {
    const { mtimeMs } = await handle.stat();
    const rates = JSON.parse((await handle.readFile('utf8')).replace(/^\uFEFF/, ''));
    return [['5 hours', rates.five_hour], ['7 days', rates.seven_day], ['Spend limit', rates.spend_limit]]
      .map(([label, rate]) => windowUsage(label, rate?.used_percentage, rate?.resets_at)).filter(Boolean)
      .map(rate => ({ ...rate, observedAt: mtimeMs }));
  } finally {
    await handle.close();
  }
}

module.exports = { codexUsage, claudeUsage, claudeUsageSettings };

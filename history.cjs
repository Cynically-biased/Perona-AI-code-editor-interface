const { existsSync, readdirSync, openSync, readSync, closeSync, fstatSync } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const maxMessages = 100;
const maxActivity = 150;
const messageLimit = 48000;
const activityLimit = 12000;

function openDatabase(root, prefix) {
  if (!existsSync(root)) return;
  const files = readdirSync(root).filter(name => name.startsWith(prefix) && /^\w+_\d+\.sqlite$/.test(name));
  const file = files.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  if (file) return new DatabaseSync(path.join(root, file), { readOnly: true });
}

function textBlocks(content) {
  return Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    : typeof content === 'string' ? content : '';
}

function push(list, entry, limit) {
  const previous = list.findIndex(item => item.id === entry.id);
  if (previous !== -1) list[previous] = entry;
  else {
    list.push(entry);
    if (list.length > limit) list.shift();
  }
}

function comparablePath(folder) {
  const local = folder.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  return path.resolve(local).toLowerCase();
}

function codexSnapshot(state, candidate, idle) {
  if (!state.thread && !uuid.test(candidate || '')) return { messages: [], activity: [], working: false };
  const root = process.env.CODEX_SQLITE_HOME || process.env.CODEX_HOME || path.join(homedir(), '.codex');
  const id = state.thread || candidate;
  if (!state.thread) {
    const db = openDatabase(root, 'state_');
    try {
      const row = db?.prepare('SELECT cwd, created_at FROM threads WHERE id = ?').get(id);
      if (!row || comparablePath(row.cwd) !== comparablePath(state.cwd)
          || row.created_at * 1000 < state.startedAt - 5000) {
        return { messages: [], activity: [], working: false };
      }
      state.onThread?.(id);
      state.thread = id;
    } finally {
      db?.close();
    }
  }
  const db = openDatabase(root, 'thread_history_');
  if (!db) return { messages: [], activity: [], working: false };
  try {
    const working = !idle && Boolean(db.prepare(
      "SELECT 1 FROM thread_turns WHERE thread_id = ? AND status = 'inProgress' LIMIT 1").get(id));
    const messages = db.prepare(
      "SELECT item_id, item_json FROM thread_items WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage') ORDER BY rollout_ordinal DESC LIMIT 200")
      .all(id).reverse().flatMap(({ item_id, item_json }) => {
        const item = JSON.parse(item_json);
        const user = item.type === 'userMessage';
        const text = user ? textBlocks(item.content) : item.phase === 'final_answer' ? item.text : '';
        return text ? [{ id: item_id, role: user ? 'user' : 'assistant', text: text.slice(0, messageLimit) }] : [];
      }).slice(-maxMessages);
    const activity = db.prepare(
      "SELECT item_id, item_json FROM thread_items WHERE thread_id = ? AND item_type IN ('commandExecution','fileChange','mcpToolCall','webSearch','dynamicToolCall','agentMessage','plan','collabAgentToolCall') ORDER BY rollout_ordinal DESC LIMIT 180")
      .all(id).reverse().flatMap(({ item_id, item_json }) => {
        const item = JSON.parse(item_json);
        const label = {
          commandExecution: 'Command', fileChange: 'File change', webSearch: 'Search',
          mcpToolCall: 'Tool · ' + item.tool, dynamicToolCall: 'Tool · ' + item.tool,
          plan: 'Plan', agentMessage: 'Progress', collabAgentToolCall: 'Agent task'
        }[item.type];
        if (item.type === 'agentMessage' && item.phase !== 'commentary') return [];
        const detail = item.command ?? item.text ?? item.query ?? item.tool
          ?? item.changes?.map(change => change.path).join('\n') ?? '';
        return [{ id: item_id, label, detail: String(detail).slice(0, activityLimit), status: item.status ?? '' }];
      }).slice(-maxActivity);
    return { messages, activity, working, thread: id };
  } finally {
    db.close();
  }
}

function claudeLog(state) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects');
  if (!existsSync(root)) return;
  const encoded = state.cwd.replace(/[^A-Za-z0-9]/g, '-');
  const expected = path.join(root, encoded, state.id + '.jsonl');
  if (existsSync(expected)) return expected;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith(encoded.slice(0, 32).toLowerCase())) continue;
    const file = path.join(root, entry.name, state.id + '.jsonl');
    if (existsSync(file)) return file;
  }
}

function claudeEvent(state, entry) {
  if (entry.isSidechain || entry.isMeta || entry.isCompactSummary || (entry.sessionId && entry.sessionId !== state.id)) return;
  const content = entry.message?.content;
  const text = textBlocks(content);
  const id = entry.uuid || entry.message?.id || String(state.offset);
  const finish = () => {
    for (const answer of state.pending.values()) push(state.messages, answer, maxMessages);
    state.pending.clear();
    state.working = false;
  };
  if (entry.type === 'system' && entry.subtype === 'turn_duration') {
    finish();
  } else if (entry.type === 'user') {
    if (text) {
      finish();
      push(state.messages, { id, role: 'user', text: text.slice(0, messageLimit) }, maxMessages);
      state.working = true;
    }
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type !== 'tool_result') continue;
      const item = state.activity.find(activity => activity.id === block.tool_use_id);
      if (item) item.status = block.is_error ? 'failed' : 'completed';
    }
  } else if (entry.type === 'assistant') {
    const tools = (Array.isArray(content) ? content : []).filter(block => block.type === 'tool_use');
    if (tools.length) {
      for (const answer of state.pending.values()) {
        push(state.activity, { id: answer.id, label: 'Progress', detail: answer.text }, maxActivity);
      }
      state.pending.clear();
      if (text) push(state.activity, { id, label: 'Progress', detail: text.slice(0, activityLimit) }, maxActivity);
      for (const tool of tools) {
        const input = tool.input || {};
        const detail = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.description ?? '';
        push(state.activity, { id: tool.id, label: tool.name || 'Tool',
          detail: String(detail).slice(0, activityLimit), status: 'inProgress' }, maxActivity);
      }
    } else if (text) {
      state.pending.set(id, { id, role: 'assistant', text: text.slice(0, messageLimit) });
      while (state.pending.size > 12) state.pending.delete(state.pending.keys().next().value);
    }
    if (entry.message?.stop_reason === 'end_turn') finish();
  }
}

function claudeSnapshot(state, idle) {
  state.file ||= claudeLog(state);
  if (!state.file) return { messages: state.messages, activity: state.activity, working: false };
  const fd = openSync(state.file, 'r');
  const previous = state.offset;
  try {
    const { size } = fstatSync(fd);
    const length = Math.max(0, Math.min(size - state.offset, 512 * 1024));
    if (length) {
      const data = Buffer.alloc(length);
      const read = readSync(fd, data, 0, length, state.offset);
      const end = data.lastIndexOf(10, read - 1);
      if (end >= 0) {
        for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
          try { claudeEvent(state, JSON.parse(line)); } catch { /* Incomplete record. */ }
        }
        state.offset += end + 1;
      } else if (length === 512 * 1024) {
        // Skip a single oversized record without blocking all subsequent events.
        state.offset += read;
      }
    }
  } finally {
    closeSync(fd);
  }
  if (idle && previous === state.offset) {
    for (const answer of state.pending.values()) push(state.messages, answer, maxMessages);
    state.pending.clear();
    state.working = false;
  }
  return { messages: state.messages, activity: state.activity, working: state.working };
}

function resumeThread(id, agent, cwd, knownThread) {
  if (agent === 'claude') return claudeLog({ id, cwd }) ? id : undefined;
  if (!uuid.test(knownThread || '')) return;
  const root = process.env.CODEX_SQLITE_HOME || process.env.CODEX_HOME || path.join(homedir(), '.codex');
  const db = openDatabase(root, 'state_');
  try {
    const row = db?.prepare('SELECT cwd, has_user_event FROM threads WHERE id = ?').get(knownThread);
    if (!row || comparablePath(row.cwd) !== comparablePath(cwd)) return;
    if (row.has_user_event) return knownThread;
    const history = openDatabase(root, 'thread_history_');
    try {
      if (history?.prepare("SELECT 1 FROM thread_items WHERE thread_id = ? AND item_type = 'userMessage' LIMIT 1").get(knownThread)) {
        return knownThread;
      }
    } finally {
      history?.close();
    }
  } finally {
    db?.close();
  }
}

function createHistory(id, agent, cwd, thread, onThread) {
  const state = { id, agent, cwd, thread, onThread, startedAt: Date.now(), offset: 0, messages: [],
    activity: [], pending: new Map(), working: false };
  return (candidate, idle) => agent === 'codex' ? codexSnapshot(state, candidate, idle) : claudeSnapshot(state, idle);
}

module.exports = { createHistory, resumeThread };

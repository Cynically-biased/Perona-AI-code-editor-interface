const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { tabs, agentTabs, normalize: readDock, projectTabs, appendSession, removeSession } = require('./dock-model.js');
const isId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const isAgent = value => value === 'codex' || value === 'claude';
const label = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : 'Chat';
const sessionState = (record, allowed) => ({
  id: record.id, thread: isId(record.thread) ? record.thread : undefined,
  view: allowed.includes(record.view) ? record.view : 'chat', layout: readDock(record.layout, allowed)
});

function findSession(chat, id) {
  for (const project of chat?.projects ?? []) {
    if (project.id === id) return { project, session: project, agent: chat.agent };
    const session = project.agents?.find(item => item.id === id);
    if (session) return { project, session, agent: session.agent };
  }
}

function openWorkspace(folder) {
  const file = path.join(folder, 'workspace.json');
  let state = { version: 1, active: null, chats: [] };
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded.version !== 1 || !Array.isArray(loaded.chats)) throw new Error('Unsupported workspace version.');
    const ids = new Set();
    const sessionIds = new Set();
    state.chats = loaded.chats.flatMap(chat => {
      if (!isId(chat?.id) || ids.has(chat.id) || !isAgent(chat.agent) || !Array.isArray(chat.projects)) return [];
      ids.add(chat.id);
      const projects = chat.projects.flatMap(project => {
        if (!isId(project?.id) || sessionIds.has(project.id) || typeof project.folder !== 'string'
            || !path.isAbsolute(project.folder) || project.folder.includes('\0')) return [];
        sessionIds.add(project.id);
        const agents = (Array.isArray(project.agents) ? project.agents : []).flatMap(item => {
          if (!isId(item?.id) || sessionIds.has(item.id) || !isAgent(item.agent)) return [];
          sessionIds.add(item.id);
          return [{ ...sessionState(item, agentTabs), agent: item.agent, name: label(item.name) }];
        });
        return [{ ...sessionState(project, tabs), folder: project.folder, agents,
          dockLayout: readDock(project.dockLayout, projectTabs({ id: project.id, agents })),
          activeAgent: agents.some(item => item.id === project.activeAgent) ? project.activeAgent : undefined }];
      });
      if (!projects.length) return [];
      const selected = projects.some(project => project.id === chat.selected) ? chat.selected : projects[0].id;
      return [{ id: chat.id, agent: chat.agent, name: label(chat.name), selected, projects }];
    });
    state.active = state.chats.some(chat => chat.id === loaded.active) ? loaded.active : null;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      fs.renameSync(file, file + '.backup-' + Date.now());
    }
  }

  function commit(next) {
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    fs.mkdirSync(folder, { recursive: true });
    const temp = path.join(folder, 'workspace-' + randomUUID() + '.tmp');
    try {
      fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
      fs.renameSync(temp, file);
      state = next;
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  function edit(change) {
    const next = structuredClone(state);
    change(next);
    commit(next);
  }

  return {
    read: () => state,
    project(chatId, id, agent) {
      const found = findSession(state.chats.find(entry => entry.id === chatId), id);
      if (found?.agent === agent) return { ...found.session, folder: found.project.folder };
    },
    add(chatId, agent, name, id, cwd) {
      if (!isId(chatId) || !isId(id) || !isAgent(agent)) throw new Error('Invalid chat.');
      edit(next => {
        let chat = next.chats.find(entry => entry.id === chatId);
        if (chat && chat.agent !== agent) throw new Error('Agent does not match the saved chat.');
        if (!chat) {
          chat = { id: chatId, agent, name: label(name), selected: id, projects: [] };
          next.chats.push(chat);
        }
        if (next.chats.some(entry => findSession(entry, id))) {
          throw new Error('Project already exists.');
        }
        chat.projects.push({ id, folder: cwd, view: 'chat', agents: [] });
      });
    },
    addChatInProject(sourceChatId, sourceProjectId, id, agent, name) {
      if (!isId(id) || !isAgent(agent)) throw new Error('Invalid chat.');
      const session = { id, agent, name: label(name), view: 'chat' };
      edit(next => {
        const project = next.chats.find(chat => chat.id === sourceChatId)
          ?.projects.find(item => item.id === sourceProjectId);
        if (!project) throw new Error('This project is no longer available.');
        if (next.chats.some(chat => findSession(chat, id))) throw new Error('Chat already exists.');
        project.agents.push(session);
        if (project.dockLayout) appendSession(project.dockLayout, session, agentTabs, randomUUID);
      });
      return session;
    },
    removeProjectChat(chatId, id) {
      edit(next => {
        const found = findSession(next.chats.find(chat => chat.id === chatId), id);
        if (!found || found.session === found.project) throw new Error('This side chat is unavailable.');
        const { project, session } = found;
        project.agents = project.agents.filter(item => item !== session);
        if (project.dockLayout) removeSession(project.dockLayout, id);
        if (project.activeAgent === id) project.activeAgent = undefined;
      });
    },
    saveProjectDock(chatId, projectId, layout) {
      edit(next => {
        const project = next.chats.find(chat => chat.id === chatId)?.projects.find(item => item.id === projectId);
        if (!project) return;
        const validated = readDock(layout, projectTabs(project));
        if (validated) project.dockLayout = validated;
      });
    },
    rememberThread(chatId, id, thread) {
      if (!isId(thread)) return;
      edit(next => {
        const found = findSession(next.chats.find(chat => chat.id === chatId), id);
        if (found) found.session.thread = thread;
      });
    },
    select(chatId, projectId, view, layout, sessionId = projectId) {
      edit(next => {
        const chat = next.chats.find(entry => entry.id === chatId);
        if (!chat) return;
        next.active = chatId;
        const project = chat.projects.find(item => item.id === projectId);
        if (!project) return;
        chat.selected = projectId;
        const session = sessionId === projectId ? project : project.agents.find(item => item.id === sessionId);
        if (!session) return;
        project.activeAgent = session === project ? undefined : sessionId;
        const allowed = session === project ? tabs : agentTabs;
        if (allowed.includes(view)) session.view = view;
        const validated = readDock(layout, allowed);
        if (validated) session.layout = validated;
      });
    },
    rename(chatId, title) {
      edit(next => {
        const chat = next.chats.find(entry => entry.id === chatId);
        if (chat) chat.name = label(title);
      });
    },
    remove(chatId) {
      edit(next => {
        next.chats = next.chats.filter(chat => chat.id !== chatId);
        if (next.active === chatId) next.active = null;
      });
    }
  };
}

module.exports = { openWorkspace };

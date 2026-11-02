import { connectHost, HostRequestError, type GuestProject, type GuestSessionRecord, type HostReadyContext, type SessionSnapshot } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountSpinner,
  type Tone,
} from '@openchamber/sdk/ui';

import {
  applyPresetToText,
  orchestratorModel,
  parseConfigText,
  resolvePresetView,
  resolveWriteTarget,
  sortedPresetNames,
  writeTargetAccepts,
  type ParsedLayer,
  type PresetAgent,
  type PresetView,
  type WriteTarget,
} from './config.ts';
import { buildSessionTree, countGlyph, groupAgentSessions, sameDirectory, type AgentSession, type AgentSessionGroups, type SessionTreeNode } from './sessions.ts';
import { auditModelRefs, collectModelRefs, type ModelAudit } from './model-audit.ts';

// The extension can see the global omo-slim config through the manifest's
// filesystem globs. The project override is a relative path, which the host
// joins to the open project under the `files` capability; `ready.directory`
// says whether there is one.
const GLOBAL_PATHS = [
  '~/.config/opencode/oh-my-opencode-slim.json',
  '~/.config/opencode/oh-my-opencode-slim.jsonc',
];
const PROJECT_PATHS = [
  '.opencode/oh-my-opencode-slim.json',
  '.opencode/oh-my-opencode-slim.jsonc',
];
const RESTART_HINT = 'Wirksam nach Neustart des Managed Service (Settings → Apply & Restart).';

type Notice = { tone: Extract<Tone, 'success' | 'warning' | 'error' | 'info'>; title: string; body?: string };

type ReadyModel = {
  global: ParsedLayer;
  project: ParsedLayer | null;
  view: PresetView;
  directory: string | null;
};

type Screen =
  | { kind: 'loading' }
  | { kind: 'failed'; title: string; detail: string }
  | { kind: 'ready'; model: ReadyModel };

type Interaction =
  | { kind: 'browse' }
  | { kind: 'confirm'; name: string }
  | { kind: 'applying'; name: string };

type LayersRead =
  | { status: 'ready'; global: ParsedLayer; project: ParsedLayer | null }
  | { status: 'failed'; title: string; detail: string };

type FileRead =
  | { kind: 'missing' }
  | { kind: 'file'; raw: string }
  | { kind: 'failed'; message: string };

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('missing #root');

let directory: string | null = null;
let surface: HostReadyContext['surface'] = 'panel';
let screen: Screen = { kind: 'loading' };
let interaction: Interaction = { kind: 'browse' };
let listOpen = false;
let notice: Notice | null = null;
let loadToken = 0;
let heightFrame = 0;
let mounted: Array<{ dispose: () => void }> = [];
let agentSessions = new Map<string, AgentSessionGroups>();
let currentSession: SessionSnapshot | null = null;
/** Finished sessions hidden early (eye button); a new activity on a hidden session clears it. */
const dismissedSessions = new Set<string>();
let workspaceSessions: GuestSessionRecord[] = [];
let treeOpen = false;
const collapsedTreeNodes = new Set<string>();
let openAgent: string | undefined;
let sessionsToken = 0;
let projectLookupToken = 0;
let stopProjects: (() => void) | null = null;
let stopSessions: (() => void) | null = null;
let subscribedProject: string | null = null;
let subscriptionToken = 0;

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const errorText = (error: unknown): string => {
  if (error instanceof HostRequestError) {
    switch (error.code) {
      case 'NOT_GRANTED':
        return `Zugriff nicht freigegeben (${error.message}).`;
      case 'NO_DIRECTORY':
        return 'Kein Projekt geöffnet.';
      case 'BAD_PATH':
        return `Pfad nicht erlaubt (${error.message}).`;
      case 'FILE_TOO_LARGE':
        return 'Die Datei ist größer als das erlaubte Limit.';
      default:
        return `${error.code}: ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
};

const readConfigFile = async (path: string): Promise<FileRead> => {
  try {
    const stat = await host.stat(path);
    if (stat.kind === 'missing') return { kind: 'missing' };
    if (stat.kind !== 'file') return { kind: 'failed', message: `${path} ist keine Datei (${stat.kind}).` };
    const { content } = await host.readFile(path);
    return { kind: 'file', raw: content };
  } catch (error) {
    return { kind: 'failed', message: `${path}: ${errorText(error)}` };
  }
};

const readLayer = async (
  kind: 'global' | 'project',
  paths: string[],
): Promise<{ kind: 'loaded'; layer: ParsedLayer } | { kind: 'missing'; path: string } | { kind: 'failed'; path: string; message: string }> => {
  for (const path of paths) {
    const file = await readConfigFile(path);
    if (file.kind === 'missing') continue;
    if (file.kind === 'failed') return { kind: 'failed', path, message: file.message };
    const parsed = parseConfigText(file.raw, path);
    if (!parsed.ok) return { kind: 'failed', path, message: parsed.error };
    return { kind: 'loaded', layer: { kind, path, raw: file.raw, config: parsed.config } };
  }
  return { kind: 'missing', path: paths[0] };
};

const readLayers = async (projectDirectory: string | null): Promise<LayersRead> => {
  const global = await readLayer('global', GLOBAL_PATHS);
  if (global.kind === 'failed') {
    return { status: 'failed', title: 'Globale Konfiguration nicht lesbar', detail: global.message };
  }
  if (global.kind === 'missing') {
    return {
      status: 'failed',
      title: 'Keine oh-my-opencode-slim-Konfiguration gefunden',
      detail: `Weder ${GLOBAL_PATHS[0]} noch ${GLOBAL_PATHS[1]} existiert. Ohne Datei wird nichts geschrieben.`,
    };
  }

  let project: ParsedLayer | null = null;
  if (projectDirectory) {
    const read = await readLayer('project', PROJECT_PATHS);
    if (read.kind === 'failed') {
      return { status: 'failed', title: 'Projekt-Override nicht lesbar', detail: read.message };
    }
    if (read.kind === 'loaded') project = read.layer;
  }

  return { status: 'ready', global: global.layer, project };
};

const scheduleHeight = (): void => {
  if (surface !== 'status') return;
  if (heightFrame) cancelAnimationFrame(heightFrame);
  heightFrame = requestAnimationFrame(() => {
    heightFrame = 0;
    // Measure the content, not the viewport: a status frame has to be able to
    // shrink after the preset list closes.
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (height > 0) void host.setHeight(height).catch(() => undefined);
  });
};

const clearMounted = (): void => {
  for (const handle of mounted.splice(0)) handle.dispose();
  root.replaceChildren();
};

const paintBanner = (parent: Element, value: Notice): void => {
  mounted.push(mountBanner(parent, {
    tone: value.tone,
    title: value.title,
    body: value.body,
  }));
};

const auditForReadyScreen = (): ModelAudit | null => (modelCheck.kind === 'done' ? modelCheck.audit : null);

const agentRow = (agent: PresetAgent): HTMLElement => {
  const key = agent.agent;
  const name = agent.agent;
  const missing = modelIsMissing(auditForReadyScreen(), agent.model);
  const group = element('div', missing ? 'agent-group is-missing' : 'agent-group');
  const row = element('div', 'agent');
  const sessions = agentSessions.get(key)?.active ?? [];
  const recent = (agentSessions.get(key)?.recent ?? []).filter((entry) => !dismissedSessions.has(entry.id));
  if (sessions.length || recent.length) {
    const trigger = element('button', 'agent-disclosure');
    trigger.type = 'button';
    trigger.dataset.agent = key;
    trigger.setAttribute('aria-expanded', String(openAgent === key));
    const parts = [`${sessions.length} aktiv`];
    if (recent.length) parts.push(`${recent.length} letzte`);
    trigger.setAttribute('aria-label', `${name}: ${parts.join(', ')}${parts.length > 1 ? ' (letzte 8 Std)' : ''} — Zum Aufklappen`);
    trigger.append(...[
      sessions.length ? element('span', 'session-count', countGlyph(Math.min(sessions.length, 10)) + (sessions.length > 10 ? '+' : '')) : null,
      recent.length ? element('span', 'session-count is-done', `${Math.min(recent.length, 9)}${recent.length > 9 ? '+' : ''}`) : null,
      element('span', 'agent-name', name),
      element('span', 'agent-chevron', openAgent === key ? '▴' : '▾'),
    ].filter((node): node is HTMLElement => node !== null));
    trigger.addEventListener('click', () => {
      openAgent = openAgent === key ? undefined : key;
      paint();
    });
    row.append(trigger);
  } else {
    row.append(element('span', 'agent-name', name));
  }
  const value = element('span', 'agent-model');
  const model = element('span', 'model-text');
  // Provider part dezent, Modell-ID betont — Split am letzten "/".
  const slash = agent.model.lastIndexOf('/');
  if (slash > 0) {
    model.append(element('span', 'model-provider', agent.model.slice(0, slash + 1)));
    model.append(element('span', 'model-content', agent.model.slice(slash + 1)));
  } else {
    model.append(element('span', 'model-content', agent.model));
  }
  value.append(model);
  if (agent.variant) {
    const variant = element('span', 'variant');
    variant.append(element('span', 'model-content', agent.variant));
    value.append(variant);
  }
  value.title = `${agent.agent} · ${agent.model}${agent.variant ? ` (${agent.variant})` : ''}`
    + (missing ? ' · Modell nicht im Katalog gefunden' : '');
  row.append(value);
  group.append(row);
  if ((sessions.length || recent.length) && openAgent === key) {
    const list = element('div', 'session-list');
    list.setAttribute('aria-label', `${name}: aktive und letzte Sessions (8 Std)`);
    const dismissTitle = 'Ausblenden (bis zur nächsten Aktivität der Session)';
    const eyeGlyph = (): HTMLElement => element('span', 'session-hide-glyph', '👁');
    const rows: { session: AgentSession; done: boolean }[] = [
      ...sessions.map((session) => ({ session, done: false })),
      ...recent.map((session) => ({ session, done: true })),
    ];
    for (const { session, done } of rows) {
      const option = element('div', done ? 'session-option is-done' : 'session-option');
      option.dataset.session = session.id;
      const open = element('button', 'session-open');
      open.type = 'button';
      const label = element('span', 'session-title', session.title || 'Session ohne Titel');
      open.title = session.title;
      open.append(label);
      if (done) {
        const outcome = session.outcome === 'completed' ? '✓'
          : session.outcome === 'failed' ? '×' : '';
        const when = relativeTime(session.updatedAt);
        open.append(element('span', 'session-activity', outcome ? `${outcome} ${when}` : when));
      } else {
        const activity = session.activity === 'waiting-permission' ? 'Warten auf Freigabe'
          : session.activity === 'waiting-question' ? 'Warten auf Antwort'
            : session.activity === 'retrying' ? 'Erneuter Versuch' : '';
        if (activity) open.append(element('span', 'session-activity', activity));
        const elapsed = element('span', 'session-activity is-live');
        elapsed.dataset.elapsedStart = String(session.createdAt);
        elapsed.textContent = formatDuration(Date.now() - session.createdAt);
        elapsed.title = 'Laufzeit seit Erstellung';
        open.append(elapsed);
      }
      open.addEventListener('click', () => {
        openSession(session.id);
      });
      option.append(open);
      if (done) {
        const hide = element('button', 'session-hide');
        hide.type = 'button';
        hide.title = dismissTitle;
        hide.setAttribute('aria-label', dismissTitle);
        hide.append(eyeGlyph());
        hide.addEventListener('click', (event) => {
          event.stopPropagation();
          dismissedSessions.add(session.id);
          paint();
        });
        option.append(hide);
      }
      list.append(option);
    }
    // Laufzeit-Anzeigen jede Sekunde weiterticken; repaint entsorgt das Intervall.
    const tickElapsed = (): void => {
      const now = Date.now();
      for (const node of list.querySelectorAll<HTMLElement>('.is-live[data-elapsed-start]')) {
        node.textContent = formatDuration(now - Number(node.dataset.elapsedStart ?? '0'));
      }
    };
    const elapsedTimer = setInterval(tickElapsed, 1000);
    mounted.push({ dispose: () => clearInterval(elapsedTimer) });
    group.append(list);
  }
  return group;
};

const relativeTime = (timestamp: number): string => {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} Min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} Std`;
  return `vor ${Math.floor(hours / 24)} Tagen`;
};

/** Kompakte Laufzeit wie in OpenChamber selbst: 45s, 1m 3s, 2h 15m. */
const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

const openSession = (id: string): void => {
  void host.openSession(id).catch((error: unknown) => {
    void host.toast({ kind: 'error', message: `Session konnte nicht geöffnet werden: ${errorText(error)}` }).catch(() => undefined);
  });
};

const treeNode = (node: SessionTreeNode, isRoot: boolean, depth = 0): HTMLElement => {
  const item = element('li', 'tree-item');
  const row = element('div', 'tree-row');
  if (node.children.length) {
    const expanded = !collapsedTreeNodes.has(node.id);
    const disclosure = element('button', 'tree-disclosure', expanded ? '▾' : '▸');
    disclosure.type = 'button';
    disclosure.dataset.treeToggle = node.id;
    disclosure.setAttribute('aria-expanded', String(expanded));
    disclosure.setAttribute('aria-label', `${node.title || node.id.slice(0, 8)}: ${node.children.length} direkte Subsessions ${expanded ? 'einklappen' : 'ausklappen'}`);
    disclosure.addEventListener('click', () => {
      if (expanded) collapsedTreeNodes.add(node.id);
      else collapsedTreeNodes.delete(node.id);
      paint();
    });
    row.append(disclosure);
  } else {
    const spacer = element('span', 'tree-disclosure-spacer');
    spacer.setAttribute('aria-hidden', 'true');
    row.append(spacer);
  }

  const button = element('button', 'tree-session');
  button.type = 'button';
  button.dataset.treeSession = node.id;
  const title = node.title.trim() || node.id.slice(0, 8);
  button.title = `${title}${node.record ? ` · ${relativeTime(node.record.updatedAt)}` : ''}`;
  const headline = element('span', 'tree-headline');
  headline.append(element('span', 'tree-title', title));
  if (node.children.length) {
    const count = element('span', 'tree-child-count', String(node.children.length));
    count.setAttribute('aria-label', `${node.children.length} direkte Subsessions`);
    headline.append(count);
  }
  button.append(headline);

  const recordActivity = node.record?.activity ?? 'unknown';
  const activity = isRoot && currentSession?.busy && (recordActivity === 'unknown' || recordActivity === 'idle')
    ? 'running' : recordActivity;
  const status = activity === 'running' ? 'Läuft'
    : activity === 'retrying' ? 'Wiederholung'
      : activity === 'waiting-permission' ? 'Warten auf Freigabe'
        : activity === 'waiting-question' ? 'Warten auf Antwort' : '';
  const outcome = node.record?.outcome === 'completed' ? '✓ Abgeschlossen'
    : node.record?.outcome === 'failed' ? '× Fehlgeschlagen' : '';
  const metadata = isRoot ? [currentSession?.agent, currentSession?.model].filter(Boolean).join(' · ') : '';
  if (status || outcome || metadata) {
    const details = element('span', 'tree-details');
    if (status) {
      const state = element('span', activity === 'running' ? 'tree-state is-live' : 'tree-state', status);
      details.append(state);
    }
    if (outcome) details.append(element('span', 'tree-outcome', outcome));
    if (metadata) details.append(element('span', 'tree-metadata', metadata));
    button.append(details);
  }
  button.addEventListener('click', () => openSession(node.id));
  row.append(button);
  item.append(row);
  if (node.children.length && !collapsedTreeNodes.has(node.id)) {
    const children = element('ul', depth >= 5 ? 'tree-children is-deep' : 'tree-children');
    for (const child of node.children) children.append(treeNode(child, false, depth + 1));
    item.append(children);
  }
  return item;
};

const paintSessionTree = (panel: HTMLElement): void => {
  const tree = buildSessionTree(currentSession, workspaceSessions);
  if (!tree) return;
  const section = element('section', 'tree-section');
  const trigger = element('button', 'tree-section-trigger');
  trigger.type = 'button';
  trigger.dataset.treeSection = 'true';
  trigger.setAttribute('aria-expanded', String(treeOpen));
  trigger.setAttribute('aria-controls', 'omo-session-tree');
  trigger.append(element('span', '', 'Aktuelle Session'), element('span', 'chevron', treeOpen ? '▴' : '▾'));
  trigger.addEventListener('click', () => {
    treeOpen = !treeOpen;
    paint();
  });
  section.append(trigger);
  const list = element('ul', 'tree-list');
  list.id = 'omo-session-tree';
  list.hidden = !treeOpen;
  if (treeOpen) list.append(treeNode(tree, true));
  section.append(list);
  panel.append(section);
};

const layerRow = (label: string, value: string | null, path: string | undefined, muted: boolean): HTMLElement => {
  const row = element('div', 'layer');
  row.append(element('span', 'layer-label', label));
  const text = element('strong', muted ? 'is-empty' : '', value ?? '–');
  if (path) row.title = path;
  row.append(text);
  return row;
};

const paintPresetList = (parent: Element, model: ReadyModel, busy: boolean): void => {
  const names = sortedPresetNames(model.view.presets);
  const list = element('div', 'preset-list');
  list.id = 'omo-preset-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Verfügbare Presets');

  for (const name of names) {
    const active = name === model.view.active.name;
    const option = element('button', 'preset-option');
    option.type = 'button';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', active ? 'true' : 'false');
    option.dataset.active = active ? 'true' : 'false';
    option.disabled = busy;

    const label = element('span', 'option-label');
    label.append(element('span', 'option-name', name));
    const hint = orchestratorModel(model.view.presets, name);
    if (hint) label.append(element('span', 'option-model', hint));
    option.append(label);
    if (active) option.append(element('span', 'option-check', '✓'));
    option.addEventListener('click', () => {
      listOpen = false;
      if (name === model.view.active.name) {
        paint();
        return;
      }
      interaction = { kind: 'confirm', name };
      paint();
      const card = root.querySelector<HTMLElement>('.confirm');
      card?.focus();
    });
    list.append(option);
  }

  parent.append(list);
  const active = list.querySelector<HTMLElement>('[data-active="true"]');
  active?.focus();
};

const paintTrigger = (parent: Element, model: ReadyModel, busy: boolean): void => {
  const trigger = element('button', 'preset-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', listOpen ? 'true' : 'false');
  trigger.setAttribute('aria-controls', 'omo-preset-list');
  trigger.disabled = busy;
  trigger.title = 'Preset wechseln';
  trigger.append(element('span', 'preset-name', model.view.active.name));
  mounted.push(mountBadge(trigger, {
    label: model.view.active.origin === 'project' ? 'Projekt' : 'Global',
    tone: model.view.active.origin === 'project' ? 'info' : 'neutral',
  }));
  trigger.append(element('span', 'chevron', listOpen ? '▴' : '▾'));
  trigger.addEventListener('click', () => {
    listOpen = !listOpen;
    paint();
  });
  parent.append(trigger);
};

const paintMissingModelsBanner = (panel: HTMLElement, audit: ModelAudit): void => {
  if (audit.missing.length === 0) return;
  const when = audit.checkedAt
    ? new Date(audit.checkedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    : null;
  const body = audit.missing.map((entry) => entry.ref).join(', ')
    + (when ? ` — geprüft ${when}` : '');
  mounted.push(mountBanner(panel, {
    tone: 'error',
    title: `${audit.missing.length} konfiguriertes Modell${audit.missing.length === 1 ? '' : 'e'} ${audit.missing.length === 1 ? 'ist' : 'sind'} nicht mehr im Modellkatalog`,
    body,
  }));
};

const paintModelCheckRow = (panel: HTMLElement, check: ModelCheck, busy: boolean): void => {
  const row = element('div', 'model-check');
  const label = element('span', 'model-check-label');
  const action = element('button', 'model-check-refresh', '↻');
  action.type = 'button';
  action.disabled = busy;
  const audit: ModelAudit | null = check.kind === 'done' ? check.audit : null;
  if (check.kind === 'checking') {
    label.append(element('span', 'is-muted', 'Modelle werden geprüft …'));
    action.disabled = true;
  } else if (check.kind === 'unavailable') {
    label.append(element('span', 'is-muted', 'Modellprüfung nicht verfügbar (Service nicht freigegeben).'));
    action.remove();
  } else if (check.kind === 'failed') {
    label.append(element('span', 'is-muted', `Modellprüfung fehlgeschlagen: ${check.message}`));
    action.title = 'Erneut prüfen';
    action.addEventListener('click', () => refreshModelCheck(modelCheckRefs));
  } else if (audit && audit.checkedAt === null) {
    label.append(element('span', 'is-muted', audit.checked === 0 ? 'Keine Modelle konfiguriert.' : 'Noch nicht geprüft.'));
    action.remove();
  } else if (audit) {
    const when = audit.checkedAt ? new Date(audit.checkedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
    label.append(element('span', audit.ok ? 'is-ok' : 'is-missing', audit.ok
      ? `✓ Alle ${audit.checked} konfigurierten Modelle verfügbar`
      : `⚠ ${audit.missing.length} von ${audit.checked} Modellen fehlen im Katalog`));
    label.title = `Geprüft ${when} · Kataloggröße ${audit.catalogSize}`;
    action.title = 'Erneut prüfen';
    action.addEventListener('click', () => refreshModelCheck(modelCheckRefs));
  }
  row.append(label);
  if (action.isConnected) row.append(action);
  panel.append(row);
};

const modelIsMissing = (audit: ModelAudit | null, model: string): boolean => (
  audit !== null && audit.checkedAt !== null && audit.missing.some((entry) => entry.ref === model)
);

const paintReady = (panel: HTMLElement, model: ReadyModel): void => {
  const busy = interaction.kind === 'applying';

  const head = element('div', 'head');
  head.append(element('span', 'eyebrow', 'oh-my-opencode-slim'));
  const refresh = element('button', 'icon-btn', '↻');
  refresh.type = 'button';
  refresh.title = 'Neu laden';
  refresh.setAttribute('aria-label', 'Neu laden');
  refresh.disabled = busy;
  refresh.addEventListener('click', () => {
    notice = null;
    void loadAndPaint();
  });
  head.append(refresh);
  panel.append(head);

  if (modelCheck.kind === 'done') paintMissingModelsBanner(panel, modelCheck.audit);

  if (interaction.kind === 'confirm' || interaction.kind === 'applying') {
    const name = interaction.name;
    const target = resolveWriteTarget(model.global, model.project);
    const card = element('div', 'confirm');
    card.tabIndex = -1;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', `Preset ${name} anwenden`);
    card.append(element('div', 'confirm-title', `Preset „${name}“ anwenden?`));
    const body = element('div', 'confirm-body');
    body.append(
      document.createTextNode('Schreibt ausschließlich den Schlüssel '),
      element('code', '', 'preset'),
      document.createTextNode(` in ${target.path}. Die presets-Map, Kommentare und alle anderen Inhalte bleiben unverändert.`),
    );
    card.append(body);
    card.append(element('div', 'confirm-hint', RESTART_HINT));

    const actions = element('div', 'confirm-actions');
    mounted.push(mountButton(actions, {
      label: 'Abbrechen',
      variant: 'ghost',
      size: 'sm',
      disabled: busy,
      onClick: () => {
        interaction = { kind: 'browse' };
        paint();
      },
    }));
    mounted.push(mountButton(actions, {
      label: 'Anwenden',
      size: 'sm',
      loading: busy,
      onClick: () => { void applyPreset(name); },
    }));
    card.append(actions);
    panel.append(card);
    return;
  }

  const activeRow = element('div', 'active-row');
  paintTrigger(activeRow, model, busy);
  panel.append(activeRow);

  if (listOpen) paintPresetList(panel, model, busy);

  if (notice) paintBanner(panel, notice);

  const agents = element('div', 'agents');
  if (model.view.agents.length === 0) {
    agents.append(element('div', 'agents-empty', 'Für dieses Preset sind keine Agenten konfiguriert.'));
  } else {
    for (const agent of model.view.agents) agents.append(agentRow(agent));
  }
  panel.append(agents);

  const layers = element('div', 'layers');
  layers.append(layerRow('Global', model.global.config.preset, model.global.path, !model.global.config.preset));
  if (!model.directory) {
    layers.append(layerRow('Projekt', null, undefined, true));
    layers.lastElementChild?.setAttribute('title', 'Kein Projekt geöffnet');
  } else {
    layers.append(layerRow(
      'Projekt',
      model.project?.config.preset ?? null,
      model.project?.path ?? PROJECT_PATHS[0],
      !model.project?.config.preset,
    ));
  }
  panel.append(layers);

  paintSessionTree(panel);
  paintModelCheckRow(panel, modelCheck, busy);
  panel.append(element('p', 'hint', RESTART_HINT));
};

const paintLoading = (panel: HTMLElement): void => {
  const box = element('div', 'loading');
  mounted.push(mountSpinner(box, { label: 'Presets werden geladen' }));
  panel.append(box);
};

const paintFailed = (panel: HTMLElement, failed: Extract<Screen, { kind: 'failed' }>): void => {
  mounted.push(mountBanner(panel, {
    tone: 'error',
    title: failed.title,
    body: failed.detail,
    action: {
      label: 'Erneut laden',
      onClick: () => {
        notice = null;
        void loadAndPaint();
      },
    },
  }));
  if (notice?.tone === 'success') paintBanner(panel, notice);
};

const paint = (): void => {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusedAgent = focused?.dataset.agent;
  const focusedSession = focused?.dataset.session;
  const focusedTreeSession = focused?.dataset.treeSession;
  const focusedTreeToggle = focused?.dataset.treeToggle;
  const focusedTreeSection = focused?.dataset.treeSection === 'true';
  const treeScroll = root.querySelector<HTMLElement>('.tree-list')?.scrollTop ?? 0;
  clearMounted();
  const panel = element('div', 'panel');
  if (screen.kind === 'loading') {
    paintLoading(panel);
    paintSessionTree(panel);
  } else if (screen.kind === 'failed') {
    paintFailed(panel, screen);
    paintSessionTree(panel);
  } else paintReady(panel, screen.model);
  root.append(panel);
  const treeList = root.querySelector<HTMLElement>('.tree-list');
  if (treeList) treeList.scrollTop = treeScroll;
  if (focusedAgent) [...root.querySelectorAll<HTMLElement>('.agent-disclosure')].find((item) => item.dataset.agent === focusedAgent)?.focus();
  else if (focusedSession) [...root.querySelectorAll<HTMLElement>('.session-option')].find((item) => item.dataset.session === focusedSession)?.focus();
  else if (focusedTreeSection) root.querySelector<HTMLElement>('.tree-section-trigger')?.focus();
  else if (focusedTreeToggle) [...root.querySelectorAll<HTMLElement>('.tree-disclosure')].find((item) => item.dataset.treeToggle === focusedTreeToggle)?.focus();
  else if (focusedTreeSession) [...root.querySelectorAll<HTMLElement>('.tree-session')].find((item) => item.dataset.treeSession === focusedTreeSession)?.focus();
  scheduleHeight();
};

// Directory changes can race both project lookup and the asynchronous SDK
// subscription handshake. Tokens keep late snapshots and unsubscriptions scoped.
const watchSessions = (currentDirectory: string | null): void => {
  const token = ++sessionsToken;
  ++projectLookupToken;
  stopProjects?.(); stopProjects = null;
  stopSessions?.(); stopSessions = null;
  ++subscriptionToken;
  subscribedProject = null;
  agentSessions = new Map();
  workspaceSessions = [];
  collapsedTreeNodes.clear();
  openAgent = undefined;
  if (!currentDirectory) return;

  const selectProject = async (projects: GuestProject[]): Promise<void> => {
    const lookup = ++projectLookupToken;
    let project = projects.find((item) => sameDirectory(item.directory, currentDirectory));
    if (!project) {
      const trees = await Promise.all(projects.map(async (item) => {
        try { return { item, snapshot: await host.listWorktrees(item.id) }; }
        catch { return null; }
      }));
      project = trees.find((result) => result?.snapshot.worktrees.some((tree) => sameDirectory(tree.directory, currentDirectory)))?.item;
    }
    if (token !== sessionsToken || lookup !== projectLookupToken) return;
    const projectId = project?.id ?? null;
    if (projectId === subscribedProject) return;
    stopSessions?.(); stopSessions = null;
    const subscription = ++subscriptionToken;
    subscribedProject = projectId;
    agentSessions = new Map();
    workspaceSessions = [];
    openAgent = undefined;
    paint();
    if (!projectId) return;
    try {
      const unsubscribe = await host.onSessions(projectId, (snapshot) => {
        if (token !== sessionsToken || subscription !== subscriptionToken || subscribedProject !== projectId || snapshot.projectId !== projectId) return;
        const records = snapshot.sessions.filter((session) => session.projectId === projectId);
        const next = groupAgentSessions(records as AgentSession[], projectId, currentDirectory);
        // Avoid stealing focus on unchanged host updates.
        const signature = (groups: Map<string, AgentSessionGroups>): string => JSON.stringify([...groups].map(([name, entries]) => [
          name,
          entries.active.map((entry) => [entry.id, entry.title, entry.activity]),
          entries.recent.map((entry) => [entry.id, entry.title, entry.activity, entry.updatedAt]),
        ]));
        const treeSignature = (sessions: GuestSessionRecord[]): string => JSON.stringify(sessions.map((session) => [session.id, session.title, session.parentId, session.archivedAt, session.activity, session.outcome, session.updatedAt]));
        const unchanged = signature(next) === signature(agentSessions) && treeSignature(records) === treeSignature(workspaceSessions);
        agentSessions = next;
        // Aktivität setzt eine vorzeitige Ausblendung zurück.
        for (const entry of next.values()) for (const active of entry.active) dismissedSessions.delete(active.id);
        workspaceSessions = records;
        if (unchanged) return;
        if (openAgent !== undefined && !next.has(openAgent)) openAgent = undefined;
        // A live update must not reset focus in the preset picker or confirmation.
        // Those views repaint from the latest snapshot when they close.
        if (!listOpen && interaction.kind === 'browse') paint();
      });
      if (token !== sessionsToken || subscription !== subscriptionToken || subscribedProject !== projectId) unsubscribe();
      else stopSessions = unsubscribe;
    } catch {
      if (token === sessionsToken && subscription === subscriptionToken && subscribedProject === projectId) subscribedProject = null;
    }
  };

  let receivedProjects = false;
  void host.onProjects((snapshot) => {
    if (token === sessionsToken && snapshot.state === 'ready') {
      receivedProjects = true;
      void selectProject(snapshot.projects);
    }
  }).then((unsubscribe) => {
    if (token !== sessionsToken) unsubscribe();
    else stopProjects = unsubscribe;
  }).catch(() => undefined);
  void host.listProjects().then((snapshot) => {
    if (token === sessionsToken && !receivedProjects && snapshot.state === 'ready') void selectProject(snapshot.projects);
  }).catch(() => undefined);
};

// ---------------------------------------------------------------------------
// Model availability check
//
// The panel asks the package service (contributes.service) for the model
// catalog the effective OpenCode installation reports. Configured references
// missing from the catalog get a red badge and move the first banner to a
// warning, because providers (especially free tiers) retire model ids.

const MODEL_CHECK_RETRY_MS = 15 * 60 * 1000;

type ModelCheck =
  | { kind: 'checking' }
  | { kind: 'unavailable' }
  | { kind: 'failed'; message: string }
  | { kind: 'done'; audit: ModelAudit };

let modelCheck: ModelCheck = { kind: 'checking' };
let modelCheckTimer: ReturnType<typeof setTimeout> | 0 = 0;
let modelCheckRefs: readonly string[] = [];

const scheduleModelCheck = (refs: readonly string[]): void => {
  if (modelCheckTimer) clearTimeout(modelCheckTimer);
  modelCheckTimer = setTimeout(() => {
    modelCheckTimer = 0;
    refreshModelCheck(refs, { background: true });
  }, MODEL_CHECK_RETRY_MS);
};

const refreshModelCheck = (refs: readonly string[], options: { background?: boolean } = {}): void => {
  if (refs.length === 0) {
    modelCheck = { kind: 'done', audit: auditModelRefs([], [], null) };
    if (!options.background) paint();
    return;
  }
  modelCheckRefs = refs;
  if (!options.background) {
    modelCheck = { kind: 'checking' };
    paint();
  }
  void host.serviceRequest({ method: 'GET', path: '/models' })
    .then((result) => {
      if (result.status !== 200) throw new Error(`Service antwortete HTTP ${result.status}.`);
      const answer = JSON.parse(result.body) as { ok?: boolean; catalog?: unknown; checkedAt?: string };
      if (!answer.ok || !Array.isArray(answer.catalog)) throw new Error('Katalogantwort unverständlich.');
      const audit = auditModelRefs(refs, answer.catalog as string[], answer.checkedAt ?? null);
      modelCheck = { kind: 'done', audit };
      paint();
      scheduleModelCheck(refs);
    })
    .catch((error: unknown) => {
      if (error instanceof HostRequestError && (error.code === 'NOT_GRANTED' || error.code === 'NO_SERVICE')) {
        modelCheck = { kind: 'unavailable' };
      } else {
        modelCheck = { kind: 'failed', message: errorText(error) };
      }
      paint();
      scheduleModelCheck(refs);
    });
};

const auditRefsFor = (view: PresetView, project: ParsedLayer | null): string[] => collectModelRefs(
  view.agents,
  [
    view.active.name && view.presets[view.active.name] ? view.presets[view.active.name] : null,
    project && project.config.preset && view.presets[project.config.preset] ? view.presets[project.config.preset] : null,
  ],
);

const loadAndPaint = async (): Promise<void> => {
  const token = ++loadToken;
  const currentDirectory = directory;
  interaction = { kind: 'browse' };
  listOpen = false;
  screen = { kind: 'loading' };
  paint();

  const layers = await readLayers(currentDirectory);
  if (token !== loadToken) return;

  if (layers.status === 'failed') {
    screen = { kind: 'failed', title: layers.title, detail: layers.detail };
    paint();
    return;
  }

  const resolved = resolvePresetView(layers.global, layers.project);
  if (!resolved.ok) {
    screen = { kind: 'failed', title: 'Preset-Konfiguration ungültig', detail: resolved.error };
    paint();
    return;
  }

  screen = {
    kind: 'ready',
    model: {
      global: layers.global,
      project: layers.project,
      view: resolved.view,
      directory: currentDirectory,
    },
  };
  paint();
  refreshModelCheck(auditRefsFor(resolved.view, layers.project));
};

const applyPreset = async (name: string): Promise<void> => {
  if (interaction.kind === 'applying') return;
  const model = screen.kind === 'ready' ? screen.model : null;
  if (!model) return;

  interaction = { kind: 'applying', name };
  notice = null;
  paint();

  const expected = resolveWriteTarget(model.global, model.project);
  const startDirectory = directory;

  // Re-read before writing: a concurrent edit must not be overwritten with a
  // stale copy, and the layer in force must still be the one the user confirmed.
  const layers = await readLayers(directory);
  if (layers.status === 'failed') {
    interaction = { kind: 'browse' };
    screen = {
      kind: 'failed',
      title: 'Preset wurde nicht geändert',
      detail: `${layers.title}: ${layers.detail}`,
    };
    paint();
    return;
  }
  const resolved = resolvePresetView(layers.global, layers.project);
  if (!resolved.ok) {
    interaction = { kind: 'browse' };
    screen = { kind: 'failed', title: 'Preset wurde nicht geändert', detail: resolved.error };
    paint();
    return;
  }

  const target: WriteTarget = resolveWriteTarget(layers.global, layers.project);
  if (target.kind !== expected.kind) {
    interaction = { kind: 'browse' };
    notice = {
      tone: 'error',
      title: 'Preset wurde nicht geändert',
      body: 'Die aktive Ebene hat sich inzwischen geändert. Bitte erneut auswählen.',
    };
    screen = { kind: 'ready', model: { ...model, global: layers.global, project: layers.project, view: resolved.view } };
    paint();
    return;
  }
  if (!writeTargetAccepts(target, name)) {
    interaction = { kind: 'browse' };
    notice = {
      tone: 'error',
      title: 'Preset wurde nicht geändert',
      body: `Preset "${name}" ist in ${target.path} nicht definiert. Es wurde nichts geschrieben.`,
    };
    screen = { kind: 'ready', model: { ...model, global: layers.global, project: layers.project, view: resolved.view } };
    paint();
    return;
  }
  if (directory !== startDirectory) {
    interaction = { kind: 'browse' };
    notice = {
      tone: 'error',
      title: 'Preset wurde nicht geändert',
      body: 'Das geöffnete Projekt hat sich während der Bestätigung geändert. Bitte erneut auswählen.',
    };
    screen = { kind: 'ready', model: { ...model, global: layers.global, project: layers.project, view: resolved.view } };
    paint();
    return;
  }

  const source = target.kind === 'project' ? layers.project : layers.global;
  if (!source) {
    interaction = { kind: 'browse' };
    screen = {
      kind: 'failed',
      title: 'Preset wurde nicht geändert',
      detail: `${target.path} wurde nicht gefunden.`,
    };
    paint();
    return;
  }

  try {
    const next = applyPresetToText(source.raw, name);
    await host.writeFile(target.path, next);
    notice = {
      tone: 'success',
      title: `Preset „${name}“ gespeichert`,
    };
    interaction = { kind: 'browse' };
    await loadAndPaint();
    void host.toast({ kind: 'success', message: `Preset „${name}“ gespeichert. ${RESTART_HINT}` });
  } catch (error) {
    interaction = { kind: 'browse' };
    notice = { tone: 'error', title: 'Preset wurde nicht geändert', body: errorText(error) };
    screen = { kind: 'ready', model };
    paint();
  }
};

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (interaction.kind === 'confirm') {
    interaction = { kind: 'browse' };
    paint();
  } else if (listOpen) {
    listOpen = false;
    paint();
  } else if (openAgent !== undefined) {
    openAgent = undefined;
    paint();
  }
});

// A click listener, not pointerdown: closing must not remove the element the
// user just pressed before its own click handler runs.
document.addEventListener('click', (event) => {
  if (!listOpen) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('.active-row') || target.closest('.preset-list')) return;
  listOpen = false;
  paint();
});

let didMount = false;
host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  surface = ctx.surface;
  const nextDirectory = ctx.directory;
  if (!didMount) {
    didMount = true;
    directory = nextDirectory;
    watchSessions(directory);
    void loadAndPaint();
    return;
  }
  if (nextDirectory !== directory) {
    directory = nextDirectory;
    watchSessions(directory);
    void loadAndPaint();
  }
});

host.onDirectory((next) => {
  if (!didMount || next === directory) return;
  directory = next;
  watchSessions(directory);
  void loadAndPaint();
});

host.onSession((next) => {
  if (JSON.stringify(next) === JSON.stringify(currentSession)) return;
  if (next?.id !== currentSession?.id) collapsedTreeNodes.clear();
  currentSession = next;
  if (didMount && !listOpen && interaction.kind === 'browse') paint();
});

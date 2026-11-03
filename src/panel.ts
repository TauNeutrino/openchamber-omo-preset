import { connectHost, HostRequestError, type GuestProject, type HostReadyContext } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountSpinner,
  type Tone,
} from '@openchamber/sdk/ui';

import {
  addPresetToText,
  applyAgentModelToText,
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
import { countGlyph, groupAgentSessions, sameDirectory, type AgentSession, type AgentSessionGroups } from './sessions.ts';
import { setLocale, t } from './i18n.ts';
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
const restartHint = (): string => t('restartHint');

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
  | { kind: 'applying'; name: string }
  | { kind: 'confirm-model-switch'; sessionId: string; model: string; presetName: string };

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
let settingsOpen = false;
let noticeDismissTimer: ReturnType<typeof setTimeout> | null = null;
let notice: Notice | null = null;
let loadToken = 0;

const autoDismissNotice = (ms: number): void => {
  if (noticeDismissTimer) clearTimeout(noticeDismissTimer);
  noticeDismissTimer = setTimeout(() => {
    noticeDismissTimer = null;
    if (notice?.tone === 'success') {
      notice = null;
      paint();
    }
  }, ms);
};

const clearNoticeDismissTimer = (): void => {
  if (noticeDismissTimer) {
    clearTimeout(noticeDismissTimer);
    noticeDismissTimer = null;
  }
};
let heightFrame = 0;
let mounted: Array<{ dispose: () => void }> = [];
let agentSessions = new Map<string, AgentSessionGroups>();
/** Finished sessions hidden early (eye button); a new activity on a hidden session clears it. */
const dismissedSessions = new Set<string>();
/** Hours a finished session stays visible. Configurable in the panel's settings section. */
let finishedWindowHours = 8;
let presetEditingEnabled = false;
/** Last session snapshot as delivered by the host, for regrouping when the window changes. */
let lastSessionSnapshot: { records: AgentSession[]; projectId: string; directory: string } | null = null;
/** Model picker state when preset editing is enabled. */
let modelPicker: { agent: string; presetName: string; targetPath: string; currentModel: string; currentVariant: string } | null = null;
let pickerFilter = '';
let pickerAppliedFilter = '';
let pickerDebounce: ReturnType<typeof setTimeout> | 0 = 0;
let modelCatalog: string[] = [];
let modelVariants: Record<string, string[]> = {};
let cloneState: { source: string; scope: 'global' | 'project' | null; name: string } | null = null;

const regroupSessions = (): void => {
  if (!lastSessionSnapshot) return;
  const next = groupAgentSessions(
    lastSessionSnapshot.records, lastSessionSnapshot.projectId, lastSessionSnapshot.directory,
    Date.now(), finishedWindowHours * 60 * 60 * 1000,
  );
  agentSessions = next;
  if (openAgent !== undefined && !next.has(openAgent)) openAgent = undefined;
};
/** Current OpenCode session, for optional model switching after a preset change. */
let currentSessionId: string | null = null;
let currentSessionAgent: string | null = null;
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
        return `${t('accessNotGranted')} (${error.message}).`;
      case 'NO_DIRECTORY':
        return t('noProjectOpen');
      case 'BAD_PATH':
        return `Pfad nicht erlaubt (${error.message}).`;
      case 'FILE_TOO_LARGE':
        return t('fileTooLarge');
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
    return { status: 'failed', title: t('globalConfigUnreadable'), detail: global.message };
  }
  if (global.kind === 'missing') {
    return {
      status: 'failed',
      title: t('noConfigFound'),
      detail: t('noConfigDetail', GLOBAL_PATHS[0], GLOBAL_PATHS[1]),
    };
  }

  let project: ParsedLayer | null = null;
  if (projectDirectory) {
    const read = await readLayer('project', PROJECT_PATHS);
    if (read.kind === 'failed') {
      return { status: 'failed', title: t('projectOverrideUnreadable'), detail: read.message };
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

const agentRow = (agent: PresetAgent, editable: boolean, onEdit: (agent: PresetAgent) => void): HTMLElement => {
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
    const parts = [t('activeSessions', sessions.length)];
    if (recent.length) parts.push(t('recentSessions', recent.length));
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
  const value = element('span', editable ? 'agent-model is-editable' : 'agent-model');
  if (editable) {
    value.style.cursor = 'pointer';
    value.addEventListener('click', () => onEdit(agent));
  }
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
    + (missing ? t('modelNotFoundInCatalog') : '');
  row.append(value);
  group.append(row);
  if ((sessions.length || recent.length) && openAgent === key) {
    const list = element('div', 'session-list');
    list.setAttribute('aria-label', `${name}: ${t('activeAndRecentSessions')}`);
    const dismissTitle = t('hideSession');
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
      const label = element('span', 'session-title', session.title || t('sessionWithoutTitle'));
      open.title = session.title;
      open.append(label);
      if (done) {
        const outcome = session.outcome === 'completed' ? '✓'
          : session.outcome === 'failed' ? '×' : '';
        const when = relativeTime(session.updatedAt);
        open.append(element('span', 'session-activity', outcome ? `${outcome} ${when}` : when));
      } else {
        const activity = session.activity === 'waiting-permission' ? t('waitingForApproval')
          : session.activity === 'waiting-question' ? t('waitingForAnswer')
            : session.activity === 'retrying' ? t('retrying') : '';
        if (activity) open.append(element('span', 'session-activity', activity));
        const elapsed = element('span', 'session-activity is-live');
        elapsed.dataset.elapsedStart = String(session.createdAt);
        elapsed.textContent = formatDuration(Date.now() - session.createdAt);
        elapsed.title = t('runtimeSinceCreation');
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
  if (minutes < 1) return t('justNow');
  if (minutes < 60) return t('minutesAgo', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('hoursAgo', hours);
  return t('daysAgo', Math.floor(hours / 24));
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

const paintPresetList = (parent: Element, model: ReadyModel, busy: boolean): void => {
  const names = sortedPresetNames(model.view.presets);
  const list = element('div', 'preset-list');
  list.id = 'omo-preset-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', t('availablePresets'));

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
    const inProject = !!model.project?.config.hasPresets && (model.project.config.presetNames?.includes(name) ?? false);
    const origin = inProject ? 'project' : 'global';
    const badge = element('span', 'origin-badge', origin === 'project' ? t('projectLayer') : t('globalLayer'));
    if (origin === 'project') badge.classList.add('is-project');
    option.append(badge);
    if (active) option.append(element('span', 'option-check', '✓'));
    if (presetEditingEnabled) {
      const cloneBtn = element('button', 'clone-btn', '🗐');
      cloneBtn.type = 'button';
      cloneBtn.title = t('clonePreset');
      cloneBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cloneState = { source: name, scope: null, name: '' };
        listOpen = false;
        paint();
      });
      option.append(cloneBtn);
    }
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
  trigger.title = t('switchPreset');
  trigger.append(element('span', 'preset-name', model.view.active.name));
  const originBadge = element('span', 'origin-badge', model.view.active.origin === 'project' ? t('projectLayer') : t('globalLayer'));
  originBadge.style.pointerEvents = 'none';
  if (model.view.active.origin === 'project') originBadge.classList.add('is-project');
  trigger.append(originBadge);
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
  const refs = audit.missing.map((entry) => entry.ref).join(', ');
  mounted.push(mountBanner(panel, {
    tone: 'error',
    title: t('missingModelsBannerTitle', audit.missing.length),
    body: refs + (when ? ` — ${t('checkedAt', when)}` : ''),
  }));
};

const modelIsMissing = (audit: ModelAudit | null, model: string): boolean => (
  audit !== null && audit.checkedAt !== null && audit.missing.some((entry) => entry.ref === model)
);

const paintReady = (panel: HTMLElement, model: ReadyModel): void => {
  const busy = interaction.kind === 'applying';

  if (modelCheck.kind === 'done') paintMissingModelsBanner(panel, modelCheck.audit);

  if (interaction.kind === 'confirm-model-switch') {
    const card = element('div', 'confirm');
    card.tabIndex = -1;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', t('orchestratorSessionSwitchTitle'));
    card.append(element('div', 'confirm-title', t('orchestratorSessionSwitchTitle')));
    const body = element('div', 'confirm-body');
    const full = t('orchestratorSessionSwitchBody', interaction.model);
    const idx = full.indexOf(interaction.model);
    if (idx >= 0) {
      body.append(document.createTextNode(full.slice(0, idx)));
      body.append(element('code', '', interaction.model));
      body.append(document.createTextNode(full.slice(idx + interaction.model.length)));
    } else {
      body.append(document.createTextNode(full));
    }
    card.append(body);
    const actions = element('div', 'confirm-actions');
    mounted.push(mountButton(actions, {
      label: t('no'),
      variant: 'ghost',
      size: 'sm',
      onClick: () => {
        interaction = { kind: 'browse' };
        paint();
      },
    }));
    mounted.push(mountButton(actions, {
      label: t('switchModel'),
      size: 'sm',
      onClick: () => {
        const { sessionId, model } = interaction as Extract<Interaction, { kind: 'confirm-model-switch' }>;
        void switchSessionModel(sessionId, model);
      },
    }));
    card.append(actions);
    panel.append(card);
    return;
  }
  if (interaction.kind === 'confirm' || interaction.kind === 'applying') {
    const name = interaction.name;
    const target = resolveWriteTarget(model.global, model.project);
    const card = element('div', 'confirm');
    card.tabIndex = -1;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', `${t('apply')} ${name}`);
    card.append(element('div', 'confirm-title', t('applyPresetTitle', name)));
    const body = element('div', 'confirm-body');
    const bodyText = t('applyPresetBody', target.path);
    const presetIdx = bodyText.indexOf('preset');
    if (presetIdx >= 0) {
      body.append(document.createTextNode(bodyText.slice(0, presetIdx)));
      body.append(element('code', '', 'preset'));
      body.append(document.createTextNode(bodyText.slice(presetIdx + 'preset'.length)));
    } else {
      body.append(document.createTextNode(bodyText));
    }
    card.append(body);
    card.append(element('div', 'confirm-hint', restartHint()));

    const actions = element('div', 'confirm-actions');
    mounted.push(mountButton(actions, {
      label: t('cancel'),
      variant: 'ghost',
      size: 'sm',
      disabled: busy,
      onClick: () => {
        interaction = { kind: 'browse' };
        paint();
      },
    }));
    mounted.push(mountButton(actions, {
      label: t('apply'),
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
  // Refresh (↻) direkt neben dem Preset-Selektor statt einer Eyebrow-Zeile oben.
  const refresh = element('button', 'icon-btn', '↻');
  refresh.type = 'button';
  refresh.title = t('reload');
  refresh.setAttribute('aria-label', t('reload'));
  refresh.disabled = busy;
  refresh.addEventListener('click', () => {
    notice = null;
    void loadAndPaint();
  });
  activeRow.append(refresh);
  const gear = element('button', 'icon-btn settings-btn', '⚙');
  gear.type = 'button';
  gear.title = t('settings');
  gear.setAttribute('aria-label', t('settings'));
  gear.setAttribute('aria-expanded', String(settingsOpen));
  gear.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    paint();
  });
  activeRow.append(gear);
  panel.append(activeRow);

  if (settingsOpen) {
    const box = element('div', 'settings-box');
    const row = element('div', 'setting-row');
    row.append(element('span', 'setting-label', t('finishedSessionsWindow')));
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '72';
    input.value = String(finishedWindowHours);
    input.className = 'setting-input';
    input.addEventListener('change', () => {
      const v = parseWindowHours(input.value);
      if (v !== null) applyFinishedWindow(v);
    });
    row.append(input);
    box.append(row);

    const editRow = element('div', 'setting-row');
    editRow.append(element('span', 'setting-label', t('presetEditingEnabled')));
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'setting-input';
    checkbox.checked = presetEditingEnabled;
    checkbox.addEventListener('change', () => {
      presetEditingEnabled = checkbox.checked;
      void host.storage.set('presetEditingEnabled', checkbox.checked).catch(() => undefined);
      paint();
    });
    editRow.append(checkbox);
    box.append(editRow);
    panel.append(box);
  }

  if (cloneState) {
    const box = element('div', 'settings-box');
    box.append(element('div', 'confirm-title', t('clonePreset')));
    box.append(element('div', 'confirm-body', `${cloneState.source}`));
    if (cloneState.scope === null) {
      const row = element('div', 'setting-row');
      const gBtn = element('button', 'icon-btn', t('cloneGlobal'));
      gBtn.type = 'button';
      gBtn.addEventListener('click', () => { if (cloneState) { cloneState.scope = 'global'; paint(); } });
      const pBtn = element('button', 'icon-btn', t('cloneProject'));
      pBtn.type = 'button';
      pBtn.addEventListener('click', () => { if (cloneState) { cloneState.scope = 'project'; paint(); } });
      row.append(gBtn, pBtn);
      box.append(row);
    } else {
      const row = element('div', 'setting-row');
      row.append(element('span', 'setting-label', t('cloneName')));
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'setting-input';
      input.style.width = '140px';
      input.value = cloneState.name;
      input.addEventListener('input', () => { if (cloneState) cloneState.name = input.value; });
      row.append(input);
      box.append(row);
      const actions = element('div', 'confirm-actions');
      const cancel = element('button', 'icon-btn', t('cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', () => { cloneState = null; paint(); });
      const create = element('button', 'icon-btn', t('cloneCreate'));
      create.type = 'button';
      create.addEventListener('click', () => { void doClone(model); });
      actions.append(cancel, create);
      box.append(actions);
    }
    panel.append(box);
  }

  if (listOpen) paintPresetList(panel, model, busy);

  if (notice) paintBanner(panel, notice);

  const agents = element('div', 'agents');
  if (model.view.agents.length === 0) {
    agents.append(element('div', 'agents-empty', t('noAgentsConfigured')));
  } else {
    for (const agent of model.view.agents) agents.append(agentRow(agent, presetEditingEnabled, (a) => openModelPicker(a, model)));
  }
  panel.append(agents);

  if (modelPicker) {
    const box = element('div', 'model-picker');
    const head = element('div', 'picker-head');
    head.append(element('span', 'picker-title', `${modelPicker.agent} · ${modelCatalog.length} Modelle`));
    const close = element('button', 'icon-btn', '×');
    close.type = 'button';
    close.title = t('cancel');
    close.addEventListener('click', () => { closeModelPicker(); paint(); });
    head.append(close);
    box.append(head);
    // Unsichtbares Eingabefeld, damit Tastatureingabe zuverlässig erfasst wird
    // (kein sichtbares Input-Feld, nur die Modellliste).
    const hiddenInput = document.createElement('input');
    hiddenInput.type = 'text';
    hiddenInput.className = 'picker-hidden-input';
    hiddenInput.value = pickerFilter;
    hiddenInput.setAttribute('aria-hidden', 'true');
    hiddenInput.tabIndex = -1;
    hiddenInput.style.position = 'absolute';
    hiddenInput.style.opacity = '0';
    hiddenInput.style.width = '1px';
    hiddenInput.style.height = '1px';
    hiddenInput.style.border = '0';
    hiddenInput.style.padding = '0';
    hiddenInput.style.pointerEvents = 'none';
    hiddenInput.addEventListener('input', () => {
      pickerFilter = hiddenInput.value;
      if (pickerDebounce) { clearTimeout(pickerDebounce); pickerDebounce = 0; }
      pickerDebounce = setTimeout(() => { pickerAppliedFilter = pickerFilter; paint(); }, 500);
      paint();
    });
    box.append(hiddenInput);
    setTimeout(() => { try { hiddenInput.focus(); } catch {} }, 0);
    if (pickerFilter) {
      box.append(element('div', 'picker-filter', `Filter: ${pickerFilter}`));
    }
    const list = element('div', 'picker-list');
    const filter = pickerAppliedFilter.toLowerCase();
    const items = modelCatalog.filter((m) => !filter || m.toLowerCase().includes(filter));
    if (items.length === 0) {
      const emptyMsg = modelCatalog.length === 0
        ? t('modelCheckLabel')
        : (pickerAppliedFilter ? t('noModelsMatchingFilter') : t('noModelsConfigured'));
      list.append(element('div', 'picker-empty', emptyMsg));
    } else {
      for (const m of items) {
        const row = element('div', 'picker-row');
        const opt = element('button', 'picker-option');
        opt.type = 'button';
        opt.title = m;
        const optText = element('span', 'picker-option-text', m);
        opt.append(optText);
        if (m === modelPicker.currentModel) {
          opt.classList.add('is-current');
          row.classList.add('is-current-row');
        }
        opt.addEventListener('click', () => { void applyPickedModel(m); });
        row.append(opt);
        const variants = modelVariants[m] ?? [];
        if (variants.length) {
          const vwrap = element('span', 'picker-variants');
          for (const v of variants) {
            const pill = element('button', 'variant-pill', v);
            pill.type = 'button';
            pill.title = `${m} (${v})`;
            if (m === modelPicker.currentModel && v === modelPicker.currentVariant) pill.classList.add('is-active');
            pill.addEventListener('click', (e) => {
              e.stopPropagation();
              void applyPickedModel(m, v);
            });
            vwrap.append(pill);
          }
          row.append(vwrap);
        }
        list.append(row);
      }
    }
    box.append(list);
    panel.append(box);
    // Scroll to the currently selected model (center).
    setTimeout(() => {
      const node = list.querySelector('.is-current-row') as HTMLElement | null;
      if (node) node.scrollIntoView({ block: 'center' });
    }, 0);
  }
};

const paintLoading = (panel: HTMLElement): void => {
  const box = element('div', 'loading');
  mounted.push(mountSpinner(box, { label: t('presetsLoading') }));
  panel.append(box);
};

const paintFailed = (panel: HTMLElement, failed: Extract<Screen, { kind: 'failed' }>): void => {
  mounted.push(mountBanner(panel, {
    tone: 'error',
    title: failed.title,
    body: failed.detail,
    action: {
      label: t('reload'),
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
  clearMounted();
  const panel = element('div', 'panel');
  if (screen.kind === 'loading') {
    paintLoading(panel);
  } else if (screen.kind === 'failed') {
    paintFailed(panel, screen);
  } else paintReady(panel, screen.model);
  root.append(panel);
  if (focusedAgent) [...root.querySelectorAll<HTMLElement>('.agent-disclosure')].find((item) => item.dataset.agent === focusedAgent)?.focus();
  else if (focusedSession) [...root.querySelectorAll<HTMLElement>('.session-option')].find((item) => item.dataset.session === focusedSession)?.focus();
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
    openAgent = undefined;
    paint();
    if (!projectId) return;
    try {
      const unsubscribe = await host.onSessions(projectId, (snapshot) => {
        if (token !== sessionsToken || subscription !== subscriptionToken || subscribedProject !== projectId || snapshot.projectId !== projectId) return;
        const records = snapshot.sessions.filter((session) => session.projectId === projectId);
        lastSessionSnapshot = { records: records as AgentSession[], projectId, directory: currentDirectory };
        const next = groupAgentSessions(records as AgentSession[], projectId, currentDirectory, Date.now(), finishedWindowHours * 60 * 60 * 1000);
        // Avoid stealing focus on unchanged host updates.
        const signature = (groups: Map<string, AgentSessionGroups>): string => JSON.stringify([...groups].map(([name, entries]) => [
          name,
          entries.active.map((entry) => [entry.id, entry.title, entry.activity]),
          entries.recent.map((entry) => [entry.id, entry.title, entry.activity, entry.updatedAt]),
        ]));
        const unchanged = signature(next) === signature(agentSessions);
        agentSessions = next;
        // Aktivität setzt eine vorzeitige Ausblendung zurück.
        for (const entry of next.values()) for (const active of entry.active) dismissedSessions.delete(active.id);
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
      if (result.status !== 200) throw new Error(t('serviceHttpError', result.status));
      const answer = JSON.parse(result.body) as { ok?: boolean; catalog?: unknown; checkedAt?: string };
      if (!answer.ok || !Array.isArray(answer.catalog)) throw new Error(t('catalogResponseUnintelligible'));
      const audit = auditModelRefs(refs, answer.catalog as string[], answer.checkedAt ?? null);
      modelCheck = { kind: 'done', audit };
      modelCatalog = answer.catalog as string[];
      modelVariants = (answer as { variants?: Record<string, string[]> }).variants ?? {};
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

const fetchModelCatalog = async (): Promise<void> => {
  try {
    const result = await host.serviceRequest({ method: 'GET', path: '/models' });
    if (result.status !== 200) return;
    const answer = JSON.parse(result.body) as { ok?: boolean; catalog?: unknown };
    if (answer.ok && Array.isArray(answer.catalog)) {
      modelCatalog = answer.catalog as string[];
      modelVariants = (answer as { variants?: Record<string, string[]> }).variants ?? {};
      paint();
    }
  } catch {
    // ignore; picker will show "unavailable"
  }
};

const openModelPicker = (agent: PresetAgent, model: ReadyModel): void => {
  const project = model.project;
  const global = model.global;
  let targetPath = global.path;
  if (project?.config.hasPresets && project.config.presetNames.includes(model.view.active.name)) {
    targetPath = project.path;
  }
  modelPicker = {
    agent: agent.agent,
    presetName: model.view.active.name,
    targetPath,
    currentModel: agent.model,
    currentVariant: agent.variant ?? '',
  };
  pickerFilter = '';
  pickerAppliedFilter = '';
  if (pickerDebounce) { clearTimeout(pickerDebounce); pickerDebounce = 0; }
  if (modelCatalog.length === 0) void fetchModelCatalog();
  paint();
};

const closeModelPicker = (): void => {
  modelPicker = null;
  pickerFilter = '';
  pickerAppliedFilter = '';
  if (pickerDebounce) { clearTimeout(pickerDebounce); pickerDebounce = 0; }
};

const applyPickedModel = async (picked: string, variant?: string): Promise<void> => {
  if (!modelPicker) return;
  const { agent, presetName, targetPath } = modelPicker;
  try {
    const file = await readConfigFile(targetPath);
    if (file.kind === 'missing') throw new Error(t('fileNotFound', targetPath));
    if (file.kind === 'failed') throw new Error(file.message);
    const next = applyAgentModelToText(file.raw, presetName, agent, picked, variant ?? '');
    await host.writeFile(targetPath, next);
    closeModelPicker();
    await loadAndPaint();
  } catch (error) {
    notice = { tone: 'error', title: t('presetNotChanged'), body: errorText(error) };
    paint();
    autoDismissNotice(5000);
  }
};
const doClone = async (model: ReadyModel): Promise<void> => {
  if (!cloneState) return;
  const source = cloneState.source;
  const scope = cloneState.scope;
  const trimmed = cloneState.name.trim();
  if (!trimmed || !scope) return;
  const agents = model.view.presets[source] ?? [];
  if (agents.length === 0) {
    notice = { tone: 'error', title: t('presetNotChanged'), body: t('noAgentsConfigured') };
    paint();
    autoDismissNotice(5000);
    return;
  }
  const targetPath = scope === 'global'
    ? model.global.path
    : (model.project?.path ?? PROJECT_PATHS[0]);
  try {
    const file = await readConfigFile(targetPath);
    const raw = file.kind === 'file' ? file.raw : '';
    const next = addPresetToText(raw, trimmed, agents);
    await host.writeFile(targetPath, next);
    cloneState = null;
    notice = { tone: 'success', title: t('cloneSuccess', trimmed), body: targetPath };
    paint();
    autoDismissNotice(5000);
    await loadAndPaint();
  } catch (error) {
    notice = { tone: 'error', title: t('presetNotChanged'), body: errorText(error) };
    paint();
    autoDismissNotice(5000);
  }
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
  clearNoticeDismissTimer();
  notice = null;
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
    screen = { kind: 'failed', title: t('invalidPresetConfig'), detail: resolved.error };
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

const switchSessionModel = async (sessionId: string, model: string): Promise<void> => {
  interaction = { kind: 'applying', name: t('modelSwitching') };
  paint();
  try {
    const result = await host.serviceRequest({ method: 'POST', path: '/switch-model', body: JSON.stringify({ sessionId, model }) });
    if (result.status !== 200) throw new Error(`Service antwortete HTTP ${result.status}.`);
    const answer = JSON.parse(result.body) as { ok?: boolean; error?: string };
    if (!answer.ok) throw new Error(answer.error ?? 'Umstellung fehlgeschlagen.');
    interaction = { kind: 'browse' };
    notice = { tone: 'success', title: t('modelSwitched'), body: model };
    paint();
    autoDismissNotice(5000);
    void host.toast({ kind: 'success', message: t('switchFailedToast', model) });
  } catch (error) {
    interaction = { kind: 'browse' };
    notice = { tone: 'error', title: t('modelSwitchFailed'), body: errorText(error) || t('modelSwitchFailedDetail') };
    paint();
  }
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
      title: t('presetNotChanged'),
      detail: `${layers.title}: ${layers.detail}`,
    };
    paint();
    return;
  }
  const resolved = resolvePresetView(layers.global, layers.project);
  if (!resolved.ok) {
    interaction = { kind: 'browse' };
    screen = { kind: 'failed', title: t('presetNotChanged'), detail: resolved.error };
    paint();
    return;
  }

  const target: WriteTarget = resolveWriteTarget(layers.global, layers.project);
  if (target.kind !== expected.kind) {
    interaction = { kind: 'browse' };
    notice = {
      tone: 'error',
      title: t('presetNotChanged'),
      body: t('activeLayerChanged'),
    };
    screen = { kind: 'ready', model: { ...model, global: layers.global, project: layers.project, view: resolved.view } };
    paint();
    return;
  }
  if (!writeTargetAccepts(target, name)) {
    interaction = { kind: 'browse' };
    notice = {
      tone: 'error',
      title: t('presetNotChanged'),
      body: t('presetNotDefined', name, target.path),
    };
    screen = { kind: 'ready', model: { ...model, global: layers.global, project: layers.project, view: resolved.view } };
    paint();
    return;
  }
  if (directory !== startDirectory) {
    interaction = { kind: 'browse' };
    notice = {
      tone: 'error',
      title: t('presetNotChanged'),
      body: t('projectChanged'),
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
      title: t('presetNotChanged'),
      detail: `${target.path} wurde nicht gefunden.`,
    };
    paint();
    return;
  }

  try {
    const next = applyPresetToText(source.raw, name);
    await host.writeFile(target.path, next);
    // Neues Orchestrator-Modell aus dem gewählten Preset ermitteln.
    const newOrchestratorModel = orchestratorModel(model.view.presets, name);
    notice = {
      tone: 'success',
      title: `Preset „${name}“ gespeichert`,
    };
    interaction = { kind: 'browse' };
    await loadAndPaint();
    void host.toast({ kind: 'success', message: `Preset „${name}“ gespeichert. ${restartHint()}` });
    autoDismissNotice(5000);
    // Wenn die aktuelle Session der Orchestrator ist: anbieten, dessen Modell umzustellen.
    if (currentSessionAgent === 'orchestrator' && currentSessionId && newOrchestratorModel) {
      interaction = {
        kind: 'confirm-model-switch',
        sessionId: currentSessionId,
        model: newOrchestratorModel,
        presetName: name,
      };
      paint();
    }
  } catch (error) {
    interaction = { kind: 'browse' };
    notice = { tone: 'error', title: t('presetNotChanged'), body: errorText(error) };
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
document.addEventListener('keydown', (event) => {
  if (!modelPicker) return;
  if (event.key === 'Escape') {
    closeModelPicker();
    paint();
    event.preventDefault();
  }
});

// A click listener, not pointerdown: closing must not remove the element the
// user just pressed before its own click handler runs.
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (settingsOpen && !target.closest('.settings-box') && !target.closest('.settings-btn')) {
    settingsOpen = false;
    paint();
  }
  if (modelPicker && !target.closest('.model-picker') && !target.closest('.agent-model.is-editable')) {
    closeModelPicker();
    paint();
  }
  if (!listOpen) return;
  if (target.closest('.active-row') || target.closest('.preset-list')) return;
  listOpen = false;
  paint();
});

let didMount = false;

const parseWindowHours = (raw: unknown): number | null => {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 72 ? n : null;
};

const applyFinishedWindow = (hours: number): void => {
  if (hours === finishedWindowHours) return;
  finishedWindowHours = hours;
  // Persistiert für später; sofortige Wirkung kommt aus dem Regruppieren.
  void host.storage.set('finishedWindowHours', hours).catch(() => undefined);
  if (didMount) {
    regroupSessions();
    if (!listOpen && interaction.kind === 'browse') paint();
  }
};

host.onReady(async (ctx) => {
  applyHostReady(ctx, document.documentElement);
  setLocale(ctx.locale);
  surface = ctx.surface;
  // Bevorzugt die auf der OpenChamber-Settings-Seite gesetzten Werte,
  // sonst der Endpoint-Value aus host.storage (frühere Version).
  const fromSettings = parseWindowHours(ctx.settings?.finishedWindowHours);
  const fromStorage = await host.storage.get('finishedWindowHours').catch(() => undefined);
  const resolved = fromSettings ?? parseWindowHours(fromStorage) ?? 8;
  const editStored = await host.storage.get('presetEditingEnabled').catch(() => undefined);
  if (typeof editStored === 'boolean') presetEditingEnabled = editStored;
  if (!didMount) {
    finishedWindowHours = resolved;
  } else {
    applyFinishedWindow(resolved);
  }
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

host.onSettings((settings) => {
  const hours = parseWindowHours(typeof settings.finishedWindowHours === 'string' || typeof settings.finishedWindowHours === 'number' ? settings.finishedWindowHours : undefined);
  if (hours !== null) applyFinishedWindow(hours);
});

host.onDirectory((next) => {
  if (!didMount || next === directory) return;
  directory = next;
  watchSessions(directory);
  void loadAndPaint();
});

host.onSession((next) => {
  currentSessionId = next?.id ?? null;
  currentSessionAgent = next?.agent ?? null;
  if (didMount && !listOpen && interaction.kind === 'browse') paint();
});

import { connectHost, HostRequestError, type HostReadyContext } from '@openchamber/sdk';
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

const agentRow = (agent: PresetAgent): HTMLElement => {
  const row = element('div', 'agent');
  row.append(element('span', 'agent-name', agent.agent));
  const value = element('span', 'agent-model');
  value.append(element('span', '', agent.model));
  if (agent.variant) value.append(element('span', 'variant', agent.variant));
  value.title = `${agent.agent} · ${agent.model}${agent.variant ? ` (${agent.variant})` : ''}`;
  row.append(value);
  return row;
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
  clearMounted();
  const panel = element('div', 'panel');
  if (screen.kind === 'loading') paintLoading(panel);
  else if (screen.kind === 'failed') paintFailed(panel, screen);
  else paintReady(panel, screen.model);
  root.append(panel);
  scheduleHeight();
};

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
    void loadAndPaint();
    return;
  }
  if (nextDirectory !== directory) {
    directory = nextDirectory;
    void loadAndPaint();
  }
});

host.onDirectory((next) => {
  if (!didMount || next === directory) return;
  directory = next;
  void loadAndPaint();
});

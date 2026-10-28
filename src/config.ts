/**
 * Reading and rewriting of the oh-my-opencode-slim preset selection.
 *
 * Everything here is pure: the panel owns the host calls, this module owns the
 * rules. Writes mirror the OpenChamber server's omo-preset route, so a switch
 * made in the panel lands in the same layer and follows the same inheritance
 * rules as one made through the API. The file is edited in place with
 * jsonc-parser, which keeps comments, ordering and the original formatting of
 * every key except `preset`.
 */
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from 'jsonc-parser';

export type PresetAgent = {
  agent: string;
  model: string;
  variant?: string;
};

export type ParsedPresetConfig = {
  /** The `preset` key, trimmed; null when the file does not set one. */
  preset: string | null;
  /** Valid agent blocks per preset name. Invalid blocks keep their name and an empty list. */
  presets: Record<string, PresetAgent[]>;
  /** All keys of the `presets` map, including blocks without a usable agent. */
  presetNames: string[];
  /** Whether the file carries a `presets` object at all; an empty map counts. */
  hasPresets: boolean;
  /** A file holding only comments or whitespace, which has no root object yet. */
  commentOnly: boolean;
};

export type ParseOutcome =
  | { ok: true; config: ParsedPresetConfig }
  | { ok: false; error: string };

export type PresetLayerKind = 'global' | 'project';

export type ParsedLayer = {
  kind: PresetLayerKind;
  /** The path shown to the user, e.g. `~/.config/opencode/oh-my-opencode-slim.json`. */
  path: string;
  raw: string;
  config: ParsedPresetConfig;
};

export type ActivePreset = {
  name: string;
  origin: PresetLayerKind;
};

export type PresetView = {
  active: ActivePreset;
  /** Effective presets: the project map merged over the global one. */
  presets: Record<string, PresetAgent[]>;
  agents: PresetAgent[];
  activePath: string;
};

export type ResolveOutcome =
  | { ok: true; view: PresetView }
  | { ok: false; error: string };

export type WriteTarget = {
  kind: PresetLayerKind;
  path: string;
  /** Names the addressed layer accepts; a project file without its own map inherits the global one. */
  availableNames: string[];
};

const BOM = '\uFEFF';

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const agentsOf = (block: unknown): PresetAgent[] => {
  if (!isPlainObject(block)) return [];
  // Newer slim configs wrap the agent map in an `agents` key (next to
  // `marketplace`); read through that layer when it is present.
  const map = isPlainObject(block.agents) ? block.agents : block;
  const agents: PresetAgent[] = [];
  for (const [agent, value] of Object.entries(map)) {
    if (!isPlainObject(value)) continue;
    const model = nonEmptyString(value.model);
    if (!model) continue;
    const variant = nonEmptyString(value.variant);
    agents.push(variant ? { agent, model, variant } : { agent, model });
  }
  return agents;
};

/**
 * Parses one preset file. A missing file is the caller's concern; anything
 * unreadable or malformed is refused here, because guessing an empty config
 * would let a write replace content that could not be understood.
 */
export const parseConfigText = (raw: string, label: string): ParseOutcome => {
  const content = raw.startsWith(BOM) ? raw.slice(1) : raw;
  if (!content.trim()) {
    return {
      ok: true,
      config: { preset: null, presets: {}, presetNames: [], hasPresets: false, commentOnly: true },
    };
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
  const commentOnly = parsed === undefined
    && errors.every((entry) => printParseErrorCode(entry.error) === 'ValueExpected');
  if (commentOnly) {
    return {
      ok: true,
      config: { preset: null, presets: {}, presetNames: [], hasPresets: false, commentOnly: true },
    };
  }
  if (errors.length > 0) {
    const first = errors[0];
    const where = first && Number.isFinite(first.offset)
      ? ` (${printParseErrorCode(first.error)} at offset ${first.offset})`
      : '';
    return { ok: false, error: `${label} enthält ungültiges JSONC${where}.` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: `${label} muss ein JSON-Objekt als Wurzel enthalten.` };
  }

  let preset: string | null = null;
  if (Object.prototype.hasOwnProperty.call(parsed, 'preset')) {
    preset = nonEmptyString(parsed.preset);
    if (preset === null) {
      return { ok: false, error: `In ${label} ist "preset" kein nicht-leerer String.` };
    }
  }

  let presets: Record<string, PresetAgent[]> = {};
  let presetNames: string[] = [];
  let hasPresets = false;
  if (Object.prototype.hasOwnProperty.call(parsed, 'presets')) {
    const value = parsed.presets;
    if (!isPlainObject(value)) {
      return { ok: false, error: `In ${label} ist "presets" kein Objekt.` };
    }
    hasPresets = true;
    presetNames = Object.keys(value);
    presets = Object.fromEntries(
      presetNames.map((name) => [name, agentsOf(value[name])]),
    );
  }

  return {
    ok: true,
    config: { preset, presets, presetNames, hasPresets, commentOnly: false },
  };
};

/**
 * Uses the indentation the file already uses, so an inserted `preset` key sits
 * like its neighbours. Existing lines are never reformatted.
 */
const formattingFor = (content: string): FormattingOptions => {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)\S/m.exec(content)?.[1];
  if (indent?.startsWith('\t')) {
    return { insertSpaces: false, tabSize: 1, eol };
  }
  if (indent) {
    return { insertSpaces: true, tabSize: Math.min(Math.max(indent.length, 1), 8), eol };
  }
  return { insertSpaces: true, tabSize: 2, eol };
};

/**
 * Returns the file with only `preset` set. Throws instead of returning a
 * doubtful result: the caller must not write then.
 */
export const applyPresetToText = (raw: string, name: string): string => {
  const nextName = name.trim();
  if (!nextName) {
    throw new Error('Der Preset-Name darf nicht leer sein.');
  }

  const before = parseConfigText(raw, 'Die Konfiguration');
  if (!before.ok) {
    throw new Error(before.error);
  }

  const hasBom = raw.startsWith(BOM);
  const content = hasBom ? raw.slice(1) : raw;
  const { eol } = formattingFor(content);

  let next: string;
  if (before.config.commentOnly) {
    // jsonc-parser appends an object below a comment-only file, which turns a
    // leading comment into a trailing one. Keep the comments and put the new
    // root object after them.
    const prefix = content.trimEnd();
    next = `${prefix ? `${prefix}${eol}` : ''}${JSON.stringify({ preset: nextName }, null, 2)}${eol}`;
  } else {
    const edits = modify(content, ['preset'], nextName, { formattingOptions: formattingFor(content) });
    next = applyEdits(content, edits);
  }

  const after = parseConfigText(next, 'Das Ergebnis');
  if (!after.ok) {
    throw new Error(`Die Änderung würde die Konfiguration beschädigen: ${after.error}`);
  }
  if (after.config.preset !== nextName) {
    throw new Error('Die Änderung konnte nicht verifiziert werden; es wurde nichts geschrieben.');
  }
  if (JSON.stringify(after.config.presets) !== JSON.stringify(before.config.presets)) {
    throw new Error('Die Änderung hätte die presets-Map verändert; es wurde nichts geschrieben.');
  }

  return hasBom ? `${BOM}${next}` : next;
};

const definedPresets = (
  global: ParsedLayer,
  project: ParsedLayer | null,
): Record<string, PresetAgent[]> => (
  project?.config.hasPresets
    ? { ...global.config.presets, ...project.config.presets }
    : global.config.presets
);

const writeNamesFor = (
  global: ParsedLayer,
  project: ParsedLayer | null,
): { kind: PresetLayerKind; path: string; availableNames: string[] } => {
  if (project?.config.preset) {
    // A project override may only change the active preset and inherit the
    // global map; when it defines its own map, that map decides.
    return {
      kind: 'project',
      path: project.path,
      availableNames: project.config.hasPresets
        ? project.config.presetNames
        : global.config.presetNames,
    };
  }
  return { kind: 'global', path: global.path, availableNames: global.config.presetNames };
};

/**
 * Decides which preset is in force, which agents it configures, and which
 * layer a switch would write. The project override wins whenever it sets a
 * preset, exactly like the oh-my-opencode-slim merge.
 */
export const resolvePresetView = (
  global: ParsedLayer,
  project: ParsedLayer | null,
): ResolveOutcome => {
  const presets = definedPresets(global, project);
  const target = writeNamesFor(global, project);
  const projectPreset = project?.config.preset ?? null;

  if (projectPreset) {
    if (!target.availableNames.includes(projectPreset)) {
      return {
        ok: false,
        error: `Preset "${projectPreset}" ist in ${target.path} nicht definiert.`,
      };
    }
    return {
      ok: true,
      view: {
        active: { name: projectPreset, origin: 'project' },
        presets,
        agents: presets[projectPreset] ?? [],
        activePath: target.path,
      },
    };
  }

  if (!global.config.preset) {
    return { ok: false, error: `In ${global.path} ist kein Preset gesetzt.` };
  }
  if (!target.availableNames.includes(global.config.preset)) {
    return {
      ok: false,
      error: `Preset "${global.config.preset}" ist in ${target.path} nicht definiert.`,
    };
  }
  return {
    ok: true,
    view: {
      active: { name: global.config.preset, origin: 'global' },
      presets,
      agents: presets[global.config.preset] ?? [],
      activePath: target.path,
    },
  };
};

/**
 * The layer a switch writes, derived from the preset in force. Returns the
 * names that layer accepts so the caller can refuse an unknown preset without
 * touching the file.
 */
export const resolveWriteTarget = (global: ParsedLayer, project: ParsedLayer | null): WriteTarget => (
  writeNamesFor(global, project)
);

export const writeTargetAccepts = (target: WriteTarget, name: string): boolean => (
  target.availableNames.includes(name)
);

/** The agent that every preset configures, used as the dropdown's one-line hint. */
export const orchestratorModel = (
  presets: Record<string, PresetAgent[]>,
  name: string,
): string | null => {
  const agents = presets[name] ?? [];
  const orchestrator = agents.find((agent) => agent.agent === 'orchestrator') ?? agents[0];
  return orchestrator?.model ?? null;
};

export const sortedPresetNames = (presets: Record<string, PresetAgent[]>): string[] => (
  Object.keys(presets).sort((left, right) => left.localeCompare(right))
);

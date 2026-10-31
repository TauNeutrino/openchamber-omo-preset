/**
 * Model availability audit: which model references from the active preset are
 * still defined in the model catalog the host's `opencode models` reports.
 * Pure logic, no I/O, so tests run without the service or the CLI.
 */

/** One `provider/model` line from `opencode models`. */
export const parseCatalogLine = (line: string): string | null => {
  const value = line.trim();
  if (!value || value.startsWith('#')) return null;
  const slash = value.indexOf('/');
  // Provider id and model id must both be non-empty and contain no whitespace,
  // so prose lines from a wrapper script do not become fake models.
  if (slash <= 0 || slash >= value.length - 1) return null;
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  if (/\s/.test(provider) || /\s/.test(model)) return null;
  return `${provider}/${model}`;
};

export const parseCatalogOutput = (stdout: string): string[] => {
  const seen = new Set<string>();
  for (const line of stdout.split('\n')) {
    const ref = parseCatalogLine(line);
    if (ref && !seen.has(ref)) seen.add(ref);
  }
  return [...seen];
};

export type ModelRefLike = { model: string; variant?: string };

export type ModelAuditFinding = {
  /** `provider/model` reference as configured. */
  ref: string;
};

export type ModelAudit = {
  /** All checks passed: at least one catalog run succeeded and nothing is missing. */
  ok: boolean;
  /** `null` when no successful catalog run succeeded yet. */
  checkedAt: string | null;
  missing: ModelAuditFinding[];
  checked: number;
  catalogSize: number;
};

/** Every model reference the panel's layers reference, deduped, in stable order. */
export const collectModelRefs = (
  activeAgents: readonly ModelRefLike[],
  layerPresets: readonly (readonly ModelRefLike[] | null)[],
): string[] => {
  const seen = new Set<string>();
  const refs: string[] = [];
  const push = (list: readonly ModelRefLike[] | null): void => {
    for (const entry of list ?? []) {
      if (typeof entry !== 'object' || entry === null) continue;
      if (typeof entry.model !== 'string' || !entry.model.trim() || seen.has(entry.model)) continue;
      seen.add(entry.model);
      refs.push(entry.model);
    }
  };
  push(activeAgents);
  for (const layer of layerPresets) push(layer);
  return refs;
};

export const auditModelRefs = (
  refs: readonly string[],
  catalog: readonly string[],
  checkedAt: string | null,
): ModelAudit => {
  // No successful catalog run yet → no claim, nothing to show as missing.
  if (checkedAt === null) return { ok: false, checkedAt: null, missing: [], checked: refs.length, catalogSize: catalog.length };
  const known = new Set(catalog);
  const missing: ModelAuditFinding[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    // variant suffixes ride along the same model id; strip them for the lookup
    const base = ref.split('#')[0];
    if (known.has(base) || known.has(ref) || seen.has(ref)) continue;
    seen.add(ref);
    missing.push({ ref });
  }
  return {
    ok: checkedAt !== null && missing.length === 0,
    checkedAt,
    missing,
    checked: refs.length,
    catalogSize: catalog.length,
  };
};

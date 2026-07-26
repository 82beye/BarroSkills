import { randomUUID } from 'node:crypto';
import {
  mkdir,
  lstat,
  link,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_ROOT = path.resolve(MODULE_DIR, '../../..');
const CHANNEL_SCHEMA_PATH = path.join(DEFAULT_SKILL_ROOT, 'schemas', 'channel.schema.json');
const SERIES_SCHEMA_PATH = path.join(DEFAULT_SKILL_ROOT, 'schemas', 'series.schema.json');

export const CHANNEL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

const STATUS_VALUES = new Set(['needs_review', 'active', 'paused', 'archived']);
const RESOLVED_CONFLICT_STATUSES = new Set(['resolved', 'accepted', 'ignored']);
const ALLOWED_PATH_VARIABLES = new Set([
  'BARROTUBE_DATA',
  'BARRO_AI_FACTORY',
  'BARROSKILLS_HOME',
  'CHANNEL_ROOT',
]);
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_KEY_PATTERN = /(?:^|[_-])(password|passwd|secret|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token)(?:$|[_-])/i;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SUPPORTED_PIPELINE_PROFILES = new Set(['barrotube-s12', 'media-render-r11', 'carousel-c4']);
const OBVIOUS_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/,
  /\bAIza[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~-]{12,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

let validatorsPromise;

function inferRepoRoot(skillRoot) {
  const normalized = path.resolve(skillRoot);
  const marker = `${path.sep}.claude${path.sep}skills${path.sep}`;
  const markerIndex = normalized.lastIndexOf(marker);
  return markerIndex >= 0 ? normalized.slice(0, markerIndex) : normalized;
}

export class ChannelRegistryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ChannelRegistryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepMerge(base, override) {
  if (override === undefined) return clone(base);
  if (!isPlainObject(base) || !isPlainObject(override)) return clone(override);

  const result = clone(base);
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = clone(value);
    }
  }
  return result;
}

function formatAjvErrors(errors = []) {
  return errors.map((error) => ({
    path: error.instancePath || '/',
    keyword: error.keyword,
    message: error.message,
    params: error.params,
  }));
}

async function getValidators() {
  if (!validatorsPromise) {
    validatorsPromise = (async () => {
      const [channelText, seriesText] = await Promise.all([
        readFile(CHANNEL_SCHEMA_PATH, 'utf8'),
        readFile(SERIES_SCHEMA_PATH, 'utf8'),
      ]);
      const channelSchema = JSON.parse(channelText);
      const seriesSchema = JSON.parse(seriesText);
      const ajv = new Ajv({ allErrors: true, strict: false });
      return {
        channel: ajv.compile(channelSchema),
        series: ajv.compile(seriesSchema),
      };
    })();
  }
  return validatorsPromise;
}

function findUnsafeObjectKeys(value, location = '') {
  const violations = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      violations.push(...findUnsafeObjectKeys(item, `${location}[${index}]`));
    });
    return violations;
  }
  if (!isPlainObject(value)) return violations;

  for (const [key, child] of Object.entries(value)) {
    const childPath = location ? `${location}.${key}` : key;
    if (DANGEROUS_OBJECT_KEYS.has(key)) {
      violations.push({ path: childPath, message: `Unsafe object key: ${key}` });
    }
    violations.push(...findUnsafeObjectKeys(child, childPath));
  }
  return violations;
}

function findSecretViolations(value, location = '', protectedValue = false) {
  const violations = [];
  if (typeof value === 'string') {
    const environmentReference = ENV_NAME_PATTERN.test(value);
    if (protectedValue && !environmentReference) {
      violations.push({
        path: location,
        message: 'Sensitive and credential values must be environment-variable names, not secret values.',
      });
    } else if (OBVIOUS_SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
      violations.push({
        path: location,
        message: 'Value looks like a secret and cannot be stored in a channel manifest.',
      });
    }
    return violations;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      violations.push(...findSecretViolations(item, `${location}[${index}]`, protectedValue));
    });
    return violations;
  }
  if (!isPlainObject(value)) {
    if (protectedValue && value !== null && value !== undefined) {
      violations.push({ path: location, message: 'Sensitive and credential values must be environment-variable names.' });
    }
    return violations;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = location ? `${location}.${key}` : key;
    const childProtected = protectedValue || key === 'credentials' || isSensitiveKey(key);
    violations.push(...findSecretViolations(child, childPath, childProtected));
  }
  return violations;
}

function isSensitiveKey(key) {
  if (SENSITIVE_KEY_PATTERN.test(key)) return true;
  const compact = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return [
    'password', 'passwd', 'secret', 'apikey', 'privatekey',
    'accesstoken', 'refreshtoken', 'clientsecret', 'authtoken',
  ].some(fragment => compact.includes(fragment))
    || compact === 'token'
    || compact.endsWith('token');
}

/**
 * Validate a channel manifest against channel.schema.json and the no-secrets rule.
 * Returns a result object instead of throwing so migration reports can preserve errors.
 */
export async function validateChannelManifest(manifest) {
  const validators = await getValidators();
  const schemaValid = validators.channel(manifest);
  const errors = schemaValid ? [] : formatAjvErrors(validators.channel.errors);
  const unsafeKeys = findUnsafeObjectKeys(manifest);
  const secretViolations = findSecretViolations(manifest);
  errors.push(
    ...unsafeKeys.map((item) => ({ ...item, keyword: 'safeObjectKey' })),
    ...secretViolations.map((item) => ({ ...item, keyword: 'noSecrets' })),
  );
  return {
    valid: errors.length === 0,
    kind: manifest?.channel?.id && !manifest?.id ? 'legacy' : 'canonical',
    errors,
  };
}

/** Validate canonical v2 or the read-only today.myo v1 series index. */
export async function validateSeriesIndex(index) {
  const validators = await getValidators();
  const valid = validators.series(index);
  return {
    valid,
    kind: index?.schema_version !== undefined ? 'canonical' : 'today.myo-legacy',
    errors: valid ? [] : formatAjvErrors(validators.series.errors),
  };
}

function assertChannelId(id) {
  if (typeof id !== 'string' || !CHANNEL_ID_PATTERN.test(id)) {
    throw new ChannelRegistryError(
      'INVALID_CHANNEL_ID',
      `Invalid channel id "${String(id)}". Use lowercase letters, digits, dots, and hyphens (1-64 characters).`,
      { id },
    );
  }
}

async function assertValidManifest(manifest) {
  const validation = await validateChannelManifest(manifest);
  if (!validation.valid) {
    const secretErrors = validation.errors.filter((error) => error.keyword === 'noSecrets');
    const unsafeKeyErrors = validation.errors.filter((error) => error.keyword === 'safeObjectKey');
    const code = secretErrors.length > 0
      ? 'SECRET_VALUE_FORBIDDEN'
      : unsafeKeyErrors.length > 0
        ? 'UNSAFE_OBJECT_KEY'
        : 'VALIDATION_ERROR';
    throw new ChannelRegistryError(code, 'Channel manifest validation failed.', {
      errors: validation.errors,
    });
  }
}

function assertSafeInput(value) {
  const unsafeKeys = findUnsafeObjectKeys(value);
  if (unsafeKeys.length > 0) {
    throw new ChannelRegistryError('UNSAFE_OBJECT_KEY', 'Channel data contains unsafe object keys.', {
      errors: unsafeKeys,
    });
  }
  const secretViolations = findSecretViolations(value);
  if (secretViolations.length > 0) {
    throw new ChannelRegistryError(
      'SECRET_VALUE_FORBIDDEN',
      'Channel data contains a raw secret; use an environment-variable name reference.',
      { errors: secretViolations },
    );
  }
}

function assertActiveStateHasNoConflicts(record) {
  if (record.status === 'active' && record.unresolvedConflicts.length > 0) {
    throw new ChannelRegistryError(
      'UNRESOLVED_CONFLICTS',
      `Channel "${record.id}" cannot be active until all migration/path conflicts are resolved.`,
      { id: record.id, conflicts: record.unresolvedConflicts },
    );
  }
}

function canonicalizeManifest(input, idHint = undefined) {
  if (!isPlainObject(input)) {
    throw new ChannelRegistryError('VALIDATION_ERROR', 'Channel manifest must be an object.');
  }

  const legacy = !input.id && isPlainObject(input.channel) && input.channel.id;
  let manifest;

  if (legacy) {
    const { channel, youtube, ...legacyExtras } = input;
    const migration = deepMerge(
      {
        sources: [],
        provenance: { imported_manifest_shape: 'legacy.channel' },
        conflicts: [],
      },
      input.migration ?? {},
    );
    const knownLegacyKeys = new Set([
      'schema_version', 'revision', 'status', 'identity', 'platforms', 'pipeline',
      'formats', 'cadence', 'paths', 'document', 'credentials', 'migration',
    ]);
    const extras = Object.fromEntries(
      Object.entries(legacyExtras).filter(([key]) => !knownLegacyKeys.has(key)),
    );
    manifest = {
      schema_version: input.schema_version ?? 1,
      id: channel.id,
      revision: input.revision ?? 1,
      status: input.status ?? 'needs_review',
      identity: {
        display_name: channel.display_name || channel.name || channel.id,
        ...(channel.description !== undefined ? { description: channel.description } : {}),
        ...(channel.language !== undefined ? { language: channel.language } : {}),
        ...(channel.target_country !== undefined ? { target_country: channel.target_country } : {}),
      },
      platforms: deepMerge(input.platforms ?? {}, youtube ? { youtube } : {}),
      pipeline: input.pipeline ?? {},
      formats: input.formats ?? [],
      cadence: input.cadence ?? {},
      paths: input.paths ?? { project_root: '${CHANNEL_ROOT}' },
      document: input.document ?? {},
      credentials: input.credentials ?? {},
      migration,
      ...extras,
    };
  } else {
    manifest = clone(input);
    delete manifest.channel;
    manifest.schema_version ??= 1;
    manifest.id ??= idHint;
    manifest.revision ??= 1;
    manifest.status ??= 'needs_review';
    manifest.identity = deepMerge({}, manifest.identity ?? {});
    manifest.identity.display_name ??= manifest.identity.name ?? manifest.id;
    delete manifest.identity.name;
    manifest.platforms ??= {};
    manifest.pipeline ??= {};
    manifest.formats ??= [];
    manifest.cadence ??= {};
    manifest.paths = deepMerge({ project_root: '${CHANNEL_ROOT}' }, manifest.paths ?? {});
    manifest.document ??= {};
    manifest.credentials ??= {};
    manifest.migration = deepMerge(
      { sources: [], provenance: {}, conflicts: [] },
      manifest.migration ?? {},
    );
  }

  if (idHint !== undefined && manifest.id !== idHint) {
    throw new ChannelRegistryError(
      'CHANNEL_ID_MISMATCH',
      `Manifest id "${manifest.id}" does not match requested channel "${idHint}".`,
      { expected: idHint, actual: manifest.id },
    );
  }
  assertChannelId(manifest.id);
  const canonicalKeys = new Set([
    'schema_version', 'id', 'revision', 'status', 'identity', 'platforms', 'pipeline',
    'formats', 'cadence', 'paths', 'document', 'credentials', 'migration',
  ]);
  const extras = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => !canonicalKeys.has(key) && key !== 'channel'),
  );
  return {
    schema_version: manifest.schema_version,
    id: manifest.id,
    revision: manifest.revision,
    status: manifest.status,
    identity: manifest.identity,
    platforms: manifest.platforms,
    pipeline: manifest.pipeline,
    formats: manifest.formats,
    cadence: manifest.cadence,
    paths: manifest.paths,
    document: manifest.document,
    credentials: manifest.credentials,
    migration: manifest.migration,
    ...extras,
  };
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function realpathWithMissingTail(target) {
  let cursor = path.resolve(target);
  const tail = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      return path.resolve(existing, ...tail.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      tail.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function normalizeAllowedRoots(roots) {
  const normalized = [];
  for (const root of roots.filter(Boolean)) {
    const lexical = path.resolve(root);
    let physical = lexical;
    try {
      physical = await realpathWithMissingTail(lexical);
    } catch {
      // A missing allowed root is still useful for validating a future path lexically.
    }
    normalized.push({ lexical, physical });
  }
  return normalized;
}

async function assertAllowedPath(target, allowedRoots, field) {
  const lexicalTarget = path.resolve(target);
  let physicalTarget;
  try {
    physicalTarget = await realpathWithMissingTail(lexicalTarget);
  } catch (error) {
    throw new ChannelRegistryError(
      'PATH_UNRESOLVABLE',
      `Could not safely resolve ${field}: ${lexicalTarget}`,
      { field, path: lexicalTarget, cause: error.message },
    );
  }

  const allowed = allowedRoots.some(({ lexical, physical }) => (
    isInside(lexical, lexicalTarget) && isInside(physical, physicalTarget)
  ));
  if (!allowed) {
    throw new ChannelRegistryError(
      'PATH_OUTSIDE_ALLOWED_ROOT',
      `${field} resolves outside the configured BarroTube roots: ${lexicalTarget}`,
      {
        field,
        path: lexicalTarget,
        allowedRoots: allowedRoots.map((root) => root.lexical),
      },
    );
  }
  return lexicalTarget;
}

function expandHome(value, homeRoot, field, conflicts) {
  if (value === '~') return homeRoot;
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) {
    return path.join(homeRoot, value.slice(2));
  }
  if (value.startsWith('~')) {
    conflicts.push({
      code: 'UNRESOLVED_HOME',
      field,
      path: field,
      message: 'Only ~ and ~/ paths are supported; named-user home paths are not.',
      resolved: false,
    });
  }
  return value;
}

function interpolatePathVariables(value, variables, field, conflicts) {
  let unresolved = false;
  const expanded = value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (token, name) => {
    if (!ALLOWED_PATH_VARIABLES.has(name) || !variables[name]) {
      unresolved = true;
      conflicts.push({
        code: 'UNRESOLVED_PATH_VARIABLE',
        field,
        path: field,
        variable: name,
        message: `Path variable ${token} is not configured or is not allowed.`,
        resolved: false,
      });
      return token;
    }
    return variables[name];
  });
  if (expanded.includes('${') && !unresolved) {
    unresolved = true;
    conflicts.push({
      code: 'UNRESOLVED_PATH_VARIABLE',
      field,
      path: field,
      message: 'Path contains an unsupported or malformed variable placeholder.',
      resolved: false,
    });
  }
  return { expanded, unresolved };
}

/**
 * Resolve and validate all path-bearing manifest fields.
 * Unknown placeholders are reported as unresolved conflicts; escaping an allowed
 * root (including through an existing symlink) is rejected.
 */
export async function resolveManifestPaths(manifest, options = {}) {
  const id = manifest?.id ?? manifest?.channel?.id;
  assertChannelId(id);

  const env = { ...process.env, ...(options.env ?? {}) };
  const channelRoot = path.resolve(
    options.channelRoot
      ?? path.join(options.channelsRoot ?? DEFAULT_SKILL_ROOT, id),
  );
  const homeRoot = options.homeRoot ?? env.HOME ?? homedir();
  const dataRoot = options.dataRoot ?? env.BARROTUBE_DATA ?? path.join(homeRoot, 'BarroTubeData');
  const factoryRoot = options.factoryRoot ?? env.BARRO_AI_FACTORY ?? path.join(homeRoot, 'BarroAiFactory');
  const skillRoot = options.skillRoot ?? env.BARROTUBE_HOME ?? env.BARROSKILLS_HOME ?? DEFAULT_SKILL_ROOT;
  const barroSkillsRoot = options.barroSkillsRoot ?? options.repoRoot ?? inferRepoRoot(skillRoot);
  const variables = {
    BARROTUBE_DATA: dataRoot ? path.resolve(dataRoot) : undefined,
    BARRO_AI_FACTORY: factoryRoot ? path.resolve(factoryRoot) : undefined,
    BARROSKILLS_HOME: barroSkillsRoot ? path.resolve(barroSkillsRoot) : undefined,
    CHANNEL_ROOT: channelRoot,
  };
  const configuredRoots = options.allowedRoots
    ?? [channelRoot, dataRoot, factoryRoot, skillRoot, barroSkillsRoot];
  const allowedRoots = await normalizeAllowedRoots([channelRoot, ...configuredRoots]);
  const conflicts = [];

  async function resolveOne(value, field, relativeRoot) {
    if (typeof value !== 'string') return value;
    let expanded = expandHome(value, homeRoot, field, conflicts);
    const interpolation = interpolatePathVariables(expanded, variables, field, conflicts);
    expanded = interpolation.expanded;
    if (interpolation.unresolved || expanded.startsWith('~')) return expanded;

    const absolute = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(relativeRoot, expanded);
    return assertAllowedPath(absolute, allowedRoots, field);
  }

  async function resolveTree(value, field, relativeRoot) {
    if (typeof value === 'string') return resolveOne(value, field, relativeRoot);
    if (Array.isArray(value)) {
      return Promise.all(value.map((item, index) => resolveTree(item, `${field}[${index}]`, relativeRoot)));
    }
    if (isPlainObject(value)) {
      const result = {};
      for (const [key, child] of Object.entries(value)) {
        result[key] = await resolveTree(child, `${field}.${key}`, relativeRoot);
      }
      return result;
    }
    return value;
  }

  const rawPaths = clone(manifest.paths ?? {});
  const rawProjectRoot = rawPaths.project_root ?? '${CHANNEL_ROOT}';
  const projectRoot = await resolveOne(rawProjectRoot, 'paths.project_root', channelRoot);
  const projectRootUnresolved = typeof projectRoot === 'string' && /\$\{|^~/.test(projectRoot);
  const relativeRoot = projectRootUnresolved ? channelRoot : projectRoot;
  const paths = { project_root: projectRoot };

  for (const [key, value] of Object.entries(rawPaths)) {
    if (key === 'project_root') continue;
    if (projectRootUnresolved && typeof value === 'string' && !path.isAbsolute(value)) {
      conflicts.push({
        code: 'PROJECT_ROOT_UNRESOLVED',
        field: `paths.${key}`,
        path: `paths.${key}`,
        message: `Relative path cannot be finalized until paths.project_root resolves: ${value}`,
        resolved: false,
      });
    }
    paths[key] = await resolveTree(value, `paths.${key}`, relativeRoot);
  }

  const document = clone(manifest.document ?? {});
  if (typeof document.output_path === 'string') {
    document.output_path = await resolveOne(
      document.output_path,
      'document.output_path',
      relativeRoot,
    );
  }

  return {
    channelRoot,
    paths,
    document,
    conflicts,
    unresolved: conflicts,
  };
}

function conflictIsResolved(conflict) {
  if (isPlainObject(conflict)) {
    if (conflict.resolved === true) return true;
    if (RESOLVED_CONFLICT_STATUSES.has(String(conflict.status ?? '').toLowerCase())) return true;
    if (typeof conflict.resolution === 'string' && conflict.resolution.trim().length > 0) return true;
  }
  return false;
}

function manifestConflicts(manifest) {
  const conflicts = manifest.migration?.conflicts ?? manifest.conflicts ?? [];
  return Array.isArray(conflicts) ? clone(conflicts) : [clone(conflicts)];
}

function normalizeFormats(globalConfig, manifest) {
  const globalEntries = Array.isArray(globalConfig?.formats) ? globalConfig.formats : [];
  const globalsById = Object.fromEntries(
    globalEntries
      .filter((entry) => isPlainObject(entry) && typeof entry.id === 'string')
      .map((entry) => [entry.id, entry]),
  );
  const channelMapping = globalConfig?.channel_format_mapping?.[manifest.id] ?? {};
  let requested = manifest.formats;

  if (requested === undefined) requested = channelMapping.enabled_formats ?? globalEntries.map((entry) => entry.id);
  if (isPlainObject(requested)) {
    if (Array.isArray(requested.enabled)) {
      requested = requested.enabled.map((id) => deepMerge({ id }, requested.overrides?.[id] ?? {}));
    } else {
      requested = Object.entries(requested)
        .filter(([key]) => !['overrides', 'defaults'].includes(key))
        .map(([id, override]) => deepMerge({ id }, isPlainObject(override) ? override : {}));
    }
  }
  if (!Array.isArray(requested)) requested = [];

  const formats = requested.map((entry) => {
    const override = typeof entry === 'string' ? { id: entry } : clone(entry);
    const base = globalsById[override.id] ?? { id: override.id };
    const normalized = deepMerge(base, override);
    const persona = manifest.default_persona?.[normalized.id];
    if (persona && normalized.persona === undefined) normalized.persona = persona;
    return normalized;
  }).filter((entry) => entry.enabled !== false);

  return {
    formats,
    formatsById: Object.fromEntries(formats.map((entry) => [entry.id, entry])),
    formatIds: formats.map((entry) => entry.id),
    mapping: channelMapping,
  };
}

function normalizePersonas(globalConfig, manifest) {
  const globals = Array.isArray(globalConfig?.personas) ? globalConfig.personas : [];
  const globalsById = Object.fromEntries(
    globals
      .filter((entry) => isPlainObject(entry) && typeof entry.id === 'string')
      .map((entry) => [entry.id, entry]),
  );
  const overrides = manifest.personas;
  if (overrides === undefined) {
    return {
      personas: clone(globals),
      personasById: clone(globalsById),
    };
  }

  const overrideEntries = Array.isArray(overrides)
    ? overrides
    : Object.entries(overrides).map(([id, value]) => deepMerge({ id }, value));
  const personas = overrideEntries.map((entry) => {
    const override = typeof entry === 'string' ? { id: entry } : clone(entry);
    return deepMerge(globalsById[override.id] ?? { id: override.id }, override);
  });
  return {
    personas,
    personasById: Object.fromEntries(personas.map((entry) => [entry.id, entry])),
  };
}

async function readJsonConfig(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return clone(fallback);
    throw new ChannelRegistryError(
      'CONFIG_INVALID',
      `Could not load global config ${filePath}: ${error.message}`,
      { path: filePath },
    );
  }
}

async function atomicWriteYaml(filePath, manifest) {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const output = stringifyYaml(manifest, { indent: 2, lineWidth: 0 });
  let handle;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(output, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function atomicCreateYaml(filePath, manifest) {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const output = stringifyYaml(manifest, { indent: 2, lineWidth: 0 });
  let handle;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(output, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    // link(2) publishes the complete temp inode only when the target does not
    // already exist, giving create a no-replace atomic commit across processes.
    await link(tempPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error.code === 'EEXIST') {
      throw new ChannelRegistryError('ALREADY_EXISTS', 'Channel manifest already exists.', {
        manifestPath: filePath,
      });
    }
    throw error;
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function reclaimStaleLock(lockPath, staleLockMs) {
  const recoveryPath = `${lockPath}.recovery`;
  let recoveryHandle;
  try {
    // A recovery mutex is only needed for a genuinely stale lock. Creating it
    // for every healthy contender makes the current owner repeatedly yield in
    // the post-acquire recovery check and can livelock concurrent writers.
    const initial = await stat(lockPath);
    if (Date.now() - initial.mtimeMs < staleLockMs) return false;
    try {
      recoveryHandle = await open(recoveryPath, 'wx', 0o600);
      await recoveryHandle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, 'utf8');
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
    const info = await stat(lockPath);
    if (!sameFile(initial, info)) return false;
    if (Date.now() - info.mtimeMs < staleLockMs) return false;
    const contents = await readFile(lockPath, 'utf8').catch(() => '');
    const pid = Number.parseInt(contents.trim().split(/\s+/)[0], 10);
    if (processIsAlive(pid)) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    return false;
  } finally {
    if (recoveryHandle) {
      await recoveryHandle.close().catch(() => {});
      await unlink(recoveryPath).catch(() => {});
    }
  }
}

async function lockRecoveryInProgress(lockPath) {
  try {
    await stat(`${lockPath}.recovery`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function sameFile(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

async function withFileLock(lockPath, timeoutMs, staleLockMs, operation) {
  const deadline = Date.now() + timeoutMs;
  let handle;
  let ownedInfo;
  while (!handle) {
    try {
      if (await lockRecoveryInProgress(lockPath)) {
        if (Date.now() >= deadline) throw new ChannelRegistryError('CHANNEL_BUSY', 'Channel lock recovery is busy.', { lockPath });
        await wait(10);
        continue;
      }
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, 'utf8');
      ownedInfo = await handle.stat();
      if (await lockRecoveryInProgress(lockPath)) {
        await handle.close();
        handle = undefined;
        const current = await stat(lockPath).catch(() => null);
        if (sameFile(current, ownedInfo)) await unlink(lockPath).catch(() => {});
        ownedInfo = undefined;
        await wait(10);
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await reclaimStaleLock(lockPath, staleLockMs)) continue;
      if (Date.now() >= deadline) {
        throw new ChannelRegistryError('CHANNEL_BUSY', 'Channel manifest is locked by another writer.', {
          lockPath,
        });
      }
      await wait(10);
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    const current = await stat(lockPath).catch(() => null);
    if (sameFile(current, ownedInfo)) await unlink(lockPath).catch(() => {});
  }
}

export class ChannelRegistry {
  constructor(options = {}) {
    this.env = { ...process.env, ...(options.env ?? {}) };
    this.homeRoot = path.resolve(options.homeRoot ?? this.env.HOME ?? homedir());
    this.skillRoot = path.resolve(
      options.skillRoot
        ?? options.barrotubeHome
        ?? this.env.BARROTUBE_HOME
        ?? this.env.BARROSKILLS_HOME
        ?? DEFAULT_SKILL_ROOT,
    );
    this.barroSkillsRoot = path.resolve(
      options.barroSkillsRoot
        ?? options.repoRoot
        ?? inferRepoRoot(this.skillRoot),
    );
    this.dataRoot = path.resolve(
      options.dataRoot
        ?? this.env.BARROTUBE_DATA
        ?? path.join(this.homeRoot, 'BarroTubeData'),
    );
    this.factoryRoot = path.resolve(
      options.factoryRoot
        ?? this.env.BARRO_AI_FACTORY
        ?? path.join(this.homeRoot, 'BarroAiFactory'),
    );
    this.channelsRoot = path.resolve(
      options.channelsRoot ?? path.join(this.dataRoot, 'workspace', 'channels'),
    );
    this.configDir = path.resolve(options.configDir ?? path.join(this.skillRoot, 'config'));
    this.allowedRoots = [
      this.channelsRoot,
      ...(options.allowedRoots
        ?? [this.skillRoot, this.barroSkillsRoot, this.dataRoot, this.factoryRoot]),
    ].filter(Boolean).map((root) => path.resolve(root));
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
    this.staleLockMs = options.staleLockMs ?? 5 * 60 * 1000;
    this.globalConfigOverrides = options.globalConfigs ?? null;
    this._globalConfigsPromise = null;
  }

  _channelDir(id) {
    assertChannelId(id);
    return path.join(this.channelsRoot, id);
  }

  _manifestPath(id) {
    return path.join(this._channelDir(id), 'channel.yaml');
  }

  async _globalConfigs() {
    if (!this._globalConfigsPromise) {
      this._globalConfigsPromise = (async () => {
        const companyPath = path.join(this.configDir, 'company.json');
        const formatsPath = path.join(this.configDir, 'formats.json');
        const personasPath = path.join(this.configDir, 'personas.json');
        if (this.globalConfigOverrides) {
          return {
            company: clone(this.globalConfigOverrides.company ?? {}),
            formats: clone(this.globalConfigOverrides.formats ?? { formats: [] }),
            personas: clone(this.globalConfigOverrides.personas ?? { personas: [] }),
            paths: { company: companyPath, formats: formatsPath, personas: personasPath },
          };
        }
        const [company, formats, personas] = await Promise.all([
          readJsonConfig(companyPath, {}),
          readJsonConfig(formatsPath, { formats: [] }),
          readJsonConfig(personasPath, { personas: [] }),
        ]);
        return {
          company,
          formats,
          personas,
          paths: { company: companyPath, formats: formatsPath, personas: personasPath },
        };
      })();
    }
    return this._globalConfigsPromise;
  }

  async _readRaw(id) {
    assertChannelId(id);
    const manifestPath = this._manifestPath(id);
    const allowedRoots = await normalizeAllowedRoots([this.channelsRoot]);
    await assertAllowedPath(manifestPath, allowedRoots, 'manifest');
    let text;
    try {
      text = await readFile(manifestPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new ChannelRegistryError('NOT_FOUND', `Channel "${id}" does not exist.`, { id });
      }
      throw error;
    }

    let raw;
    try {
      raw = parseYaml(text);
    } catch (error) {
      throw new ChannelRegistryError('YAML_PARSE_ERROR', `Invalid YAML for channel "${id}": ${error.message}`, {
        id,
        manifestPath,
      });
    }
    const rawValidation = await validateChannelManifest(raw);
    if (!rawValidation.valid) {
      const secretErrors = rawValidation.errors.filter((item) => item.keyword === 'noSecrets');
      throw new ChannelRegistryError(
        secretErrors.length ? 'SECRET_VALUE_FORBIDDEN' : 'VALIDATION_ERROR',
        `Channel "${id}" has an invalid manifest.`,
        { id, manifestPath, errors: rawValidation.errors },
      );
    }
    const sourceKind = rawValidation.kind;
    const manifest = canonicalizeManifest(raw, id);
    await assertValidManifest(manifest);
    return { manifest, manifestPath, sourceKind };
  }

  async _materialize(manifest, manifestPath, sourceKind = 'canonical') {
    const globals = await this._globalConfigs();
    const resolved = await resolveManifestPaths(manifest, {
      env: this.env,
      channelRoot: path.dirname(manifestPath),
      dataRoot: this.dataRoot,
      factoryRoot: this.factoryRoot,
      skillRoot: this.skillRoot,
      barroSkillsRoot: this.barroSkillsRoot,
      homeRoot: this.homeRoot,
      allowedRoots: this.allowedRoots,
    });
    const formatContext = normalizeFormats(globals.formats, manifest);
    const personaContext = normalizePersonas(globals.personas, manifest);
    const companyDefaults = globals.company?.defaults ?? {};
    const identity = deepMerge(
      companyDefaults.language ? { language: companyDefaults.language } : {},
      manifest.identity,
    );
    // Context keeps the old name alias for consumers while the manifest stays canonical.
    identity.name ??= identity.display_name;
    const pipeline = deepMerge(
      {
        stages: globals.company?.pipeline_stages ?? {},
        governance: globals.company?.governance ?? {},
      },
      manifest.pipeline ?? {},
    );
    const cadence = deepMerge(
      formatContext.mapping?.weekly_schedule ?? {},
      manifest.cadence ?? {},
    );
    const company = deepMerge(globals.company?.company ?? {}, manifest.company ?? {});
    const defaults = deepMerge(companyDefaults, manifest.defaults ?? {});
    const configuredConflicts = manifestConflicts(manifest);
    const conflicts = [...configuredConflicts, ...resolved.conflicts];
    const addConflict = (code, field, message, details = {}) => conflicts.push({
      code,
      field,
      path: field,
      message,
      resolved: false,
      ...details,
    });

    const profiles = [pipeline.profile ?? pipeline.adapter, ...(pipeline.additional_profiles ?? [])].filter(Boolean);
    if (!profiles.length) {
      addConflict('PIPELINE_PROFILE_REQUIRED', 'pipeline.profile', 'A supported pipeline.profile is required before activation.');
    } else {
      for (const profile of profiles) {
        if (!SUPPORTED_PIPELINE_PROFILES.has(profile)) {
          addConflict('UNSUPPORTED_PIPELINE_PROFILE', 'pipeline.profile', `Unsupported pipeline profile: ${profile}`);
        }
      }
    }

    const seriesPath = resolved.paths.series_index;
    if (typeof seriesPath === 'string' && !/\$\{|^~/.test(seriesPath)) {
      try {
        const seriesIndex = JSON.parse(await readFile(seriesPath, 'utf8'));
        const seriesValidation = await validateSeriesIndex(seriesIndex);
        if (!seriesValidation.valid) {
          addConflict('INVALID_SERIES_INDEX', 'paths.series_index', 'The configured series index does not match a supported schema.', {
            details: seriesValidation.errors,
          });
        } else if (seriesValidation.kind === 'canonical' && seriesIndex.channel_id !== manifest.id) {
          addConflict('SERIES_CHANNEL_MISMATCH', 'paths.series_index', `Series index belongs to ${seriesIndex.channel_id}, not ${manifest.id}.`);
        } else if (seriesValidation.kind === 'today.myo-legacy' && manifest.id !== 'today.myo') {
          addConflict('SERIES_CHANNEL_MISMATCH', 'paths.series_index', 'The ownerless legacy series format is restricted to channel today.myo.');
        }
      } catch (error) {
        addConflict(
          error.code === 'ENOENT' ? 'SERIES_INDEX_MISSING' : 'INVALID_SERIES_INDEX',
          'paths.series_index',
          error.code === 'ENOENT'
            ? 'The configured series index does not exist.'
            : `The configured series index cannot be parsed: ${error.message}`,
        );
      }
    } else if (seriesPath !== undefined && seriesPath !== null && typeof seriesPath !== 'string') {
      addConflict('INVALID_SERIES_INDEX', 'paths.series_index', 'paths.series_index must resolve to one JSON file path.');
    }

    let documentOutputSafe = true;
    const outputPath = resolved.document.output_path;
    if (typeof outputPath === 'string' && !/\$\{|^~/.test(outputPath)) {
      if (path.extname(outputPath).toLowerCase() !== '.html') {
        documentOutputSafe = false;
        addConflict('INVALID_DOCUMENT_OUTPUT', 'document.output_path', 'Generated channel documents must use an .html output path.');
      }
      try {
        const [outputPhysical, projectPhysical, channelPhysical, manifestPhysical] = await Promise.all([
          realpathWithMissingTail(outputPath),
          realpathWithMissingTail(resolved.paths.project_root),
          realpathWithMissingTail(path.dirname(manifestPath)),
          realpathWithMissingTail(manifestPath),
        ]);
        if (!isInside(projectPhysical, outputPhysical) && !isInside(channelPhysical, outputPhysical)) {
          documentOutputSafe = false;
          addConflict('DOCUMENT_OUTPUT_OUTSIDE_CHANNEL', 'document.output_path', 'Document output must stay inside the channel project or registry directory.');
        }
        const protectedPaths = [manifestPhysical];
        const collectPaths = (value) => {
          if (typeof value === 'string' && !/\$\{|^~/.test(value)) protectedPaths.push(value);
          else if (Array.isArray(value)) value.forEach(collectPaths);
          else if (isPlainObject(value)) Object.values(value).forEach(collectPaths);
        };
        collectPaths(resolved.paths);
        const protectedPhysical = await Promise.all(protectedPaths.map(item => realpathWithMissingTail(item)));
        if (protectedPhysical.some(item => item === outputPhysical)) {
          documentOutputSafe = false;
          addConflict('DOCUMENT_OUTPUT_COLLISION', 'document.output_path', 'Document output collides with a manifest, series index, or configured source path.');
        }
        if (resolved.paths.episodes_root) {
          const episodesPhysical = await realpathWithMissingTail(resolved.paths.episodes_root);
          if (isInside(episodesPhysical, outputPhysical)) {
            documentOutputSafe = false;
            addConflict('DOCUMENT_OUTPUT_COLLISION', 'document.output_path', 'Document output cannot be placed inside the episode source tree.');
          }
        }
      } catch (error) {
        documentOutputSafe = false;
        addConflict('INVALID_DOCUMENT_OUTPUT', 'document.output_path', `Document output could not be validated safely: ${error.message}`);
      }
    } else if (outputPath) {
      documentOutputSafe = false;
    }

    const unresolvedConflicts = conflicts.filter((conflict) => !conflictIsResolved(conflict));
    const provenance = {
      manifest: manifestPath,
      manifest_shape: sourceKind,
      globals: {
        company: globals.paths.company,
        formats: globals.paths.formats,
        personas: globals.paths.personas,
      },
      fields: {
        company: [globals.paths.company, manifest.company ? manifestPath : null].filter(Boolean),
        defaults: [globals.paths.company, manifest.defaults ? manifestPath : null].filter(Boolean),
        identity: [globals.paths.company, manifestPath],
        formats: [globals.paths.formats, manifestPath],
        personas: [globals.paths.personas, manifest.personas ? manifestPath : null].filter(Boolean),
        cadence: [globals.paths.formats, manifestPath],
        pipeline: [globals.paths.company, manifestPath],
        paths: [manifestPath],
      },
      migration: clone(manifest.migration?.provenance ?? {}),
    };

    const context = {
      id: manifest.id,
      channel_id: manifest.id,
      revision: manifest.revision,
      status: manifest.status,
      active: manifest.status === 'active',
      identity,
      company,
      defaults,
      platforms: clone(manifest.platforms ?? {}),
      pipeline,
      pipeline_profile: pipeline.profile ?? pipeline.adapter ?? null,
      formats: formatContext.formats,
      formats_by_id: formatContext.formatsById,
      format_ids: formatContext.formatIds,
      personas: personaContext.personas,
      personas_by_id: personaContext.personasById,
      cadence,
      paths: resolved.paths,
      project_root: resolved.paths.project_root,
      episodes_root: resolved.paths.episodes_root ?? null,
      series_index: resolved.paths.series_index ?? null,
      reference_docs: resolved.paths.reference_docs ?? null,
      character_dna: resolved.paths.character_dna ?? null,
      character_sheets: resolved.paths.character_sheets ?? null,
      style_guides: resolved.paths.style_guides ?? null,
      policies: resolved.paths.policies ?? null,
      document: resolved.document,
      document_output_path: resolved.document.output_path ?? null,
      document_output_safe: documentOutputSafe,
      supported_actions: clone(pipeline.supported_actions ?? pipeline.actions ?? []),
      conflicts,
      unresolved_conflicts: unresolvedConflicts,
      can_activate: manifest.status !== 'archived' && unresolvedConflicts.length === 0,
      provenance,
    };

    return {
      id: manifest.id,
      revision: manifest.revision,
      status: manifest.status,
      manifestPath,
      manifest,
      context,
      provenance,
      conflicts,
      unresolvedConflicts,
      unresolved: unresolvedConflicts,
    };
  }

  async listChannels(options = {}) {
    const includeArchived = options.includeArchived ?? true;
    const strict = options.strict ?? false;
    let entries;
    try {
      entries = await readdir(this.channelsRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }

    const channelIds = entries
      .filter((entry) => entry.isDirectory() && CHANNEL_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    const channels = [];
    for (const id of channelIds) {
      try {
        const channel = await this.getChannel(id);
        if (includeArchived || channel.status !== 'archived') channels.push(channel);
      } catch (error) {
        if (strict) throw error;
        channels.push({
          id,
          manifestPath: this._manifestPath(id),
          manifest: null,
          context: null,
          conflicts: [],
          unresolvedConflicts: [],
          unresolved: [],
          error: {
            code: error.code ?? 'READ_ERROR',
            message: error.message,
            details: error.details,
          },
        });
      }
    }
    return channels;
  }

  async getChannel(id) {
    const loaded = await this._readRaw(id);
    return this._materialize(loaded.manifest, loaded.manifestPath, loaded.sourceKind);
  }

  async getChannelContext(id) {
    return (await this.getChannel(id)).context;
  }

  async createChannel(input) {
    assertSafeInput(input);
    const manifest = canonicalizeManifest(input);
    manifest.revision = 1;
    await assertValidManifest(manifest);

    const channelDir = this._channelDir(manifest.id);
    const manifestPath = this._manifestPath(manifest.id);
    const materialized = await this._materialize(manifest, manifestPath);
    assertActiveStateHasNoConflicts(materialized);
    await mkdir(this.channelsRoot, { recursive: true, mode: 0o700 });
    let createdDirectory = false;
    try {
      await mkdir(channelDir, { mode: 0o700 });
      createdDirectory = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await lstat(channelDir);
      if (!existing.isDirectory()) {
        throw new ChannelRegistryError(
          'INVALID_CHANNEL_DIRECTORY',
          `Channel path exists but is not a real directory: ${channelDir}`,
          { id: manifest.id, path: channelDir },
        );
      }
    }

    const registryRoots = await normalizeAllowedRoots([this.channelsRoot]);
    try {
      await assertAllowedPath(manifestPath, registryRoots, 'manifest');
      const lockPath = path.join(channelDir, '.channel.create.lock');
      await withFileLock(lockPath, this.lockTimeoutMs, this.staleLockMs, async () => {
        try {
          await atomicCreateYaml(manifestPath, manifest);
        } catch (error) {
          if (error.code === 'ALREADY_EXISTS') {
            error.message = `Channel "${manifest.id}" already exists.`;
            error.details = { id: manifest.id, manifestPath };
          }
          throw error;
        }
      });
    } catch (error) {
      if (createdDirectory) await rmdir(channelDir).catch(() => {});
      throw error;
    }
    return this.getChannel(manifest.id);
  }

  async updateChannel(id, patch, options = {}) {
    assertChannelId(id);
    if (!isPlainObject(patch)) {
      throw new ChannelRegistryError('VALIDATION_ERROR', 'Channel update must be an object.');
    }
    assertSafeInput(patch);
    const expectedRevision = options.expectedRevision ?? patch.revision;
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new ChannelRegistryError(
        'REVISION_REQUIRED',
        'updateChannel requires expectedRevision (or patch.revision) for optimistic concurrency.',
      );
    }
    if (patch.id !== undefined && patch.id !== id) {
      throw new ChannelRegistryError('CHANNEL_ID_MISMATCH', 'A channel id cannot be changed.', {
        expected: id,
        actual: patch.id,
      });
    }

    const channelDir = this._channelDir(id);
    try {
      await stat(channelDir);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new ChannelRegistryError('NOT_FOUND', `Channel "${id}" does not exist.`, { id });
      }
      throw error;
    }
    const lockPath = path.join(channelDir, '.channel.yaml.lock');
    return withFileLock(lockPath, this.lockTimeoutMs, this.staleLockMs, async () => {
      const current = await this._readRaw(id);
      if (current.manifest.revision !== expectedRevision) {
        throw new ChannelRegistryError(
          'REVISION_CONFLICT',
          `Channel "${id}" is at revision ${current.manifest.revision}, not ${expectedRevision}.`,
          { id, expectedRevision, actualRevision: current.manifest.revision },
        );
      }

      const safePatch = clone(patch);
      delete safePatch.id;
      delete safePatch.revision;
      delete safePatch.channel;
      if (isPlainObject(safePatch.identity)
          && safePatch.identity.display_name === undefined
          && safePatch.identity.name !== undefined) {
        safePatch.identity.display_name = safePatch.identity.name;
        delete safePatch.identity.name;
      }
      const merged = deepMerge(current.manifest, safePatch);
      merged.id = id;
      merged.schema_version = current.manifest.schema_version;
      merged.revision = current.manifest.revision + 1;
      const manifest = canonicalizeManifest(merged, id);
      if (!STATUS_VALUES.has(manifest.status)) {
        throw new ChannelRegistryError('VALIDATION_ERROR', `Unsupported channel status: ${manifest.status}`);
      }
      await assertValidManifest(manifest);
      const materialized = await this._materialize(manifest, current.manifestPath);
      assertActiveStateHasNoConflicts(materialized);
      await atomicWriteYaml(current.manifestPath, manifest);
      return this.getChannel(id);
    });
  }

  async activateChannel(id, options = {}) {
    const current = await this.getChannel(id);
    if (current.status === 'archived') {
      throw new ChannelRegistryError(
        'ARCHIVED_CHANNEL',
        `Archived channel "${id}" must be restored to paused or needs_review before activation.`,
      );
    }
    if (current.unresolvedConflicts.length > 0) {
      throw new ChannelRegistryError(
        'UNRESOLVED_CONFLICTS',
        `Channel "${id}" cannot be activated until all migration/path conflicts are resolved.`,
        { id, conflicts: current.unresolvedConflicts },
      );
    }
    const expectedRevision = options.expectedRevision ?? current.revision;
    return this.updateChannel(id, { status: 'active' }, { expectedRevision });
  }

  async archiveChannel(id, options = {}) {
    const current = await this.getChannel(id);
    const expectedRevision = options.expectedRevision ?? current.revision;
    return this.updateChannel(id, { status: 'archived' }, { expectedRevision });
  }

  // Short aliases make the registry convenient for CLI and board adapters.
  list(options) { return this.listChannels(options); }
  get(id) { return this.getChannel(id); }
  create(manifest) { return this.createChannel(manifest); }
  update(id, patch, options) { return this.updateChannel(id, patch, options); }
  activate(id, options) { return this.activateChannel(id, options); }
  archive(id, options) { return this.archiveChannel(id, options); }
}

export function createChannelRegistry(options = {}) {
  return new ChannelRegistry(options);
}

export async function loadChannelContext(id, options = {}) {
  return createChannelRegistry(options).getChannelContext(id);
}

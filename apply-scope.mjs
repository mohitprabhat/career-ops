import { existsSync, realpathSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { pathIsInsideCanonical } from './tracker-utils.mjs';

export class ApplyScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApplyScopeError';
  }
}

const LAUNCH_KEYS = new Set(['headless', 'channel', 'args', 'timeout']);
const LAUNCH_CHANNELS = new Set(['chrome', 'chromium', 'msedge']);
const ATTACH_ARG = /remote-debugging|user-data-dir|DevToolsActivePort|devtools/i;
const PROFILE_ENABLED = new Set(['1', 'true', 'yes', 'on']);
const PROFILE_DISABLED = new Set(['', '0', 'false', 'no', 'off']);

function realOrLexical(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function projectRoot() {
  return dirname(fileURLToPath(import.meta.url));
}

export function allowedRoots() {
  const code = projectRoot();
  const data = getCareerOpsRoot();
  if (realOrLexical(data) === realOrLexical(code)) return [code];
  return [code, data];
}

export function resolveInsideProject(root, candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '' || candidate.includes('\0')) {
    throw new ApplyScopeError('Apply refused a path outside the project.');
  }
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  if (!pathIsInsideCanonical(abs, root)) {
    throw new ApplyScopeError('Apply refused a path outside the project.');
  }
  return abs;
}

function insideAnyRoot(candidate) {
  let last = new ApplyScopeError('Apply refused a path outside the project.');
  for (const root of allowedRoots()) {
    try {
      return resolveInsideProject(root, candidate);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export function freshLaunchOptions(requested = {}) {
  if (requested == null || typeof requested !== 'object' || Array.isArray(requested)) {
    throw new ApplyScopeError('Apply refused to attach to an existing browser.');
  }
  for (const key of Object.keys(requested)) {
    if (!LAUNCH_KEYS.has(key)) {
      throw new ApplyScopeError('Apply refused to attach to an existing browser.');
    }
  }
  if (requested.channel != null && !LAUNCH_CHANNELS.has(requested.channel)) {
    throw new ApplyScopeError('Apply refused to attach to an existing browser.');
  }
  const args = requested.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => ATTACH_ARG.test(String(arg)))) {
    throw new ApplyScopeError('Apply refused to attach to an existing browser.');
  }
  const options = {};
  if (requested.headless !== undefined) options.headless = Boolean(requested.headless);
  if (requested.channel !== undefined) options.channel = requested.channel;
  if (requested.timeout !== undefined) options.timeout = requested.timeout;
  if (args.length) options.args = args.map(String);
  return options;
}

export const HEADED_APPLY_LAUNCH = freshLaunchOptions({
  channel: 'chrome',
  headless: false,
  args: ['--window-position=-3200,-3200', '--window-size=1280,940'],
});

export const BUNDLED_HEADED_LAUNCH = freshLaunchOptions({
  headless: false,
  args: ['--window-position=-3200,-3200', '--window-size=1280,940'],
});

export function defaultLaunchOptions() {
  return freshLaunchOptions({ headless: false });
}

function defaultChromeUserDataDir(platform, processEnv, homeDirectory) {
  if (platform === 'win32') {
    return join(processEnv.LOCALAPPDATA || join(homeDirectory, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  }
  if (platform === 'darwin') {
    return join(homeDirectory, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  const configHome = processEnv.XDG_CONFIG_HOME?.trim() || join(homeDirectory, '.config');
  return join(configHome, 'google-chrome');
}

function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory();
}

export function resolveApplyLaunchConfig({
  processEnv = process.env,
  platform = process.platform,
  homeDirectory = homedir(),
  dataRoot = getCareerOpsRoot(),
} = {}) {
  const envFilePath = join(dataRoot, '.env');
  const fileEnv = existsSync(envFilePath) ? parseEnv(readFileSync(envFilePath, 'utf8')) : {};
  const setting = (name) => {
    const value = Object.hasOwn(processEnv, name) ? processEnv[name] : fileEnv[name];
    return typeof value === 'string' ? value.trim() : '';
  };

  const enabled = setting('CAREER_OPS_USE_CHROME_PROFILE').toLowerCase();
  if (PROFILE_DISABLED.has(enabled)) {
    return { mode: 'browser', options: defaultLaunchOptions() };
  }
  if (!PROFILE_ENABLED.has(enabled)) {
    throw new ApplyScopeError(
      'CAREER_OPS_USE_CHROME_PROFILE must be explicitly set to 1, true, yes, or on to use a Chrome profile.',
    );
  }

  const configuredUserDataDir = setting('CAREER_OPS_CHROME_USER_DATA_DIR');
  const unresolvedUserDataDir = configuredUserDataDir || defaultChromeUserDataDir(platform, processEnv, homeDirectory);
  if (!isAbsolute(unresolvedUserDataDir)) {
    throw new ApplyScopeError('CAREER_OPS_CHROME_USER_DATA_DIR must be an absolute path.');
  }
  const userDataDir = resolve(unresolvedUserDataDir);

  const profileDirectory = setting('CAREER_OPS_CHROME_PROFILE_DIRECTORY') || 'Default';
  if (
    profileDirectory === '.' ||
    profileDirectory === '..' ||
    profileDirectory.includes('\0') ||
    /[\\/]/.test(profileDirectory)
  ) {
    throw new ApplyScopeError('CAREER_OPS_CHROME_PROFILE_DIRECTORY must be a single profile folder name.');
  }

  const profilePath = join(userDataDir, profileDirectory);
  if (!isDirectory(userDataDir) || !isDirectory(profilePath)) {
    throw new ApplyScopeError(
      `Chrome profile not found at "${profilePath}". Check CAREER_OPS_CHROME_USER_DATA_DIR and ` +
      'CAREER_OPS_CHROME_PROFILE_DIRECTORY; career-ops will not create a new profile.',
    );
  }

  return {
    mode: 'persistent',
    userDataDir,
    options: freshLaunchOptions({
      channel: 'chrome',
      headless: false,
      args: [`--profile-directory=${profileDirectory}`],
    }),
  };
}

export function locateApplyReport(dataRoot, ref, io) {
  if (typeof ref !== 'string' || ref.trim() === '') return { ok: false, reason: 'missing' };
  const looksLikePath = /[\\/]/.test(ref) || isAbsolute(ref);
  if (looksLikePath) {
    const file = resolveInsideProject(dataRoot, ref);
    if (!io.exists(file)) return { ok: false, reason: 'missing' };
    return { ok: true, path: file };
  }
  const num = ref.trim().padStart(3, '0');
  const reportsDir = resolveInsideProject(dataRoot, 'reports');
  const names = io.list(reportsDir);
  const match = names.find((name) => name.startsWith(num));
  if (!match) return { ok: false, reason: 'missing' };
  return { ok: true, path: resolveInsideProject(dataRoot, join('reports', match)) };
}

function printUsage() {
  console.log('Usage: node apply-scope.mjs <root|check-path|launch-options|launch-config>');
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }
  const [cmd, arg] = args;
  try {
    if (cmd === 'root') {
      for (const root of allowedRoots()) console.log(root);
    } else if (cmd === 'check-path') {
      console.log(insideAnyRoot(arg));
    } else if (cmd === 'launch-options') {
      console.log(JSON.stringify(defaultLaunchOptions()));
    } else if (cmd === 'launch-config') {
      console.log(JSON.stringify(resolveApplyLaunchConfig()));
    } else {
      console.error('Usage: node apply-scope.mjs <root|check-path|launch-options|launch-config>');
      process.exit(2);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

const { execFileSync } = require('child_process');

const repositoryPath = __dirname;
const remoteName = process.env.GIT_REMOTE || 'origin';
const branchName = process.env.GIT_BRANCH || 'main';
const intervalMs = Number(process.env.GIT_PULL_INTERVAL_MS || 60_000);
const maximumBackoffMs = 30 * 60_000;

if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) {
  throw new Error('GIT_PULL_INTERVAL_MS must be an integer of at least 60000 milliseconds.');
}

function runGit(args) {
  return execFileSync('git', args, {
    cwd: repositoryPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000
  }).trim();
}

let isChecking = false;
let timer;
let consecutiveFailures = 0;
let lastError = null;
let wasDirty = false;
let branchMismatch = false;

function scheduleNextCheck(delay) {
  timer = setTimeout(checkForUpdates, delay);
}

function checkForUpdates() {
  if (isChecking) {
    scheduleNextCheck(intervalMs);
    return;
  }
  isChecking = true;

  try {
    const currentBranch = runGit(['branch', '--show-current']);
    if (currentBranch !== branchName) {
      if (!branchMismatch) {
        console.warn(`[git-watchdog] Paused: checked out branch is "${currentBranch || '(detached)'}", expected "${branchName}".`);
      }
      branchMismatch = true;
      return;
    }
    if (branchMismatch) {
      console.log(`[git-watchdog] Resumed monitoring branch "${branchName}".`);
      branchMismatch = false;
    }

    const changes = runGit(['status', '--porcelain', '--untracked-files=normal']);
    if (changes) {
      if (!wasDirty) {
        console.warn('[git-watchdog] Paused pulls while local changes are present.');
      }
      wasDirty = true;
      return;
    }
    if (wasDirty) {
      console.log('[git-watchdog] Local changes are clear; pull checks resumed.');
      wasDirty = false;
    }

    const previousCommit = runGit(['rev-parse', 'HEAD']);
    runGit(['pull', '--quiet', '--ff-only', remoteName, branchName]);
    const currentCommit = runGit(['rev-parse', 'HEAD']);
    if (currentCommit !== previousCommit) {
      console.log(`[git-watchdog] Updated to ${currentCommit.slice(0, 12)}.`);
    }

    consecutiveFailures = 0;
    if (lastError) {
      console.log('[git-watchdog] Pull checks recovered.');
      lastError = null;
    }
  } catch (error) {
    const details = error.stderr?.toString().trim() || error.message;
    consecutiveFailures++;
    if (details !== lastError) {
      console.error(`[git-watchdog] Pull check failed: ${details}`);
      lastError = details;
    }
  } finally {
    isChecking = false;
    const backoff = Math.min(intervalMs * (2 ** Math.min(consecutiveFailures, 10)), maximumBackoffMs);
    scheduleNextCheck(backoff);
  }
}

console.log(`[git-watchdog] Monitoring ${branchName} from ${remoteName}; checks are quiet unless the repository changes or needs attention.`);
checkForUpdates();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearTimeout(timer);
    process.exit(0);
  });
}

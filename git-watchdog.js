const { execFileSync } = require('child_process');
const path = require('path');

const repositoryPath = __dirname;
const remoteName = process.env.GIT_REMOTE || 'origin';
const branchName = process.env.GIT_BRANCH || 'main';
const intervalMs = Number(process.env.GIT_PULL_INTERVAL_MS || 60_000);

if (!Number.isSafeInteger(intervalMs) || intervalMs < 10_000) {
  throw new Error('GIT_PULL_INTERVAL_MS must be an integer of at least 10000 milliseconds.');
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

async function checkForUpdates() {
  if (isChecking) return;
  isChecking = true;

  try {
    const currentBranch = runGit(['branch', '--show-current']);
    if (currentBranch !== branchName) {
      console.warn(`[git-watchdog] Skipping pull: checked out branch is "${currentBranch || '(detached)'}", expected "${branchName}".`);
      return;
    }

    const changes = runGit(['status', '--porcelain', '--untracked-files=normal']);
    if (changes) {
      console.warn('[git-watchdog] Skipping pull because local changes are present.');
      return;
    }

    const result = runGit(['pull', '--ff-only', remoteName, branchName]);
    console.log(`[git-watchdog] ${result || 'Repository is up to date.'}`);
  } catch (error) {
    const details = error.stderr?.toString().trim() || error.message;
    console.error(`[git-watchdog] Pull check failed: ${details}`);
  } finally {
    isChecking = false;
  }
}

const gitDirectory = path.join(repositoryPath, '.git');
console.log(`[git-watchdog] Monitoring ${branchName} from ${remoteName} every ${intervalMs / 1000}s (${gitDirectory}).`);
checkForUpdates();
const timer = setInterval(checkForUpdates, intervalMs);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(timer);
    process.exit(0);
  });
}

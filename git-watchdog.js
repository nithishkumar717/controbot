const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repositoryPath = __dirname;
const remoteName = process.env.GIT_REMOTE || 'origin';
const branchName = process.env.GIT_BRANCH || 'main';
const intervalMs = Math.max(10_000, Number(process.env.GIT_PULL_INTERVAL_MS || 30_000));
const autoRestart = process.env.GIT_AUTO_RESTART !== 'false';
const maxFailureDelayMs = 60_000; // Cap failure delay to 1 minute maximum

function isGitRepo() {
  try {
    return fs.existsSync(path.join(repositoryPath, '.git'));
  } catch {
    return false;
  }
}

function runGit(args) {
  return execFileSync('git', args, {
    cwd: repositoryPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000
  }).trim();
}

let isChecking = false;
let timer = null;
let consecutiveFailures = 0;
let lastError = null;
let wasDirty = false;
let branchMismatch = false;

function scheduleNextCheck(delay) {
  clearTimeout(timer);
  timer = setTimeout(checkForUpdates, delay);
}

function tryInitializeGitRepo() {
  const remoteUrl = process.env.GIT_REPO_URL || process.env.GIT_REMOTE_URL || '';
  if (!remoteUrl) {
    return false;
  }
  try {
    console.log(`[git-watchdog] Missing .git folder; initializing repository linked to "${remoteName}/${branchName}"...`);
    runGit(['init']);
    try {
      runGit(['remote', 'add', remoteName, remoteUrl]);
    } catch {
      runGit(['remote', 'set-url', remoteName, remoteUrl]);
    }
    runGit(['fetch', '--quiet', remoteName, branchName]);
    runGit(['branch', '-M', branchName]);
    runGit(['reset', '--mixed', `${remoteName}/${branchName}`]);
    console.log(`[git-watchdog] Repository successfully initialized and linked to "${remoteName}/${branchName}".`);
    return true;
  } catch (err) {
    console.warn(`[git-watchdog] Auto-initialization note: ${err.message}`);
    return false;
  }
}

function checkForUpdates() {
  if (isChecking) {
    scheduleNextCheck(intervalMs);
    return;
  }

  if (!isGitRepo()) {
    const initialized = tryInitializeGitRepo();
    if (!initialized) {
      console.warn('[git-watchdog] No .git directory found; auto-pull disabled.');
      return;
    }
  }

  isChecking = true;

  try {
    // 1. Verify current checked-out branch
    const currentBranch = runGit(['branch', '--show-current']);
    if (currentBranch && currentBranch !== branchName) {
      if (!branchMismatch) {
        console.warn(`[git-watchdog] Paused: checked out branch is "${currentBranch}", expected "${branchName}".`);
      }
      branchMismatch = true;
      return;
    }
    if (branchMismatch) {
      console.log(`[git-watchdog] Resumed monitoring branch "${branchName}".`);
      branchMismatch = false;
    }

    // 2. Fetch latest commits from remote without touching working directory
    runGit(['fetch', '--quiet', remoteName, branchName]);

    const localCommit = runGit(['rev-parse', 'HEAD']);
    const remoteCommit = runGit(['rev-parse', `${remoteName}/${branchName}`]);

    // Already up-to-date
    if (localCommit === remoteCommit) {
      consecutiveFailures = 0;
      if (lastError) {
        console.log('[git-watchdog] Pull checks recovered.');
        lastError = null;
      }
      return;
    }

    // 3. New commit available - check if tracked files have uncommitted changes (-uno ignores untracked files)
    const dirtyTracked = runGit(['status', '--porcelain', '-uno']);
    if (dirtyTracked) {
      if (!wasDirty) {
        console.warn('[git-watchdog] New commit available on remote. Resetting local modifications to apply clean update...');
      }
      try {
        runGit(['reset', '--hard', 'HEAD']);
      } catch {}
      wasDirty = true;
    }
    if (wasDirty) {
      console.log('[git-watchdog] Tracked files are clean; resuming auto-pull.');
      wasDirty = false;
    }

    // 4. Fast-forward pull the latest updates
    console.log(`[git-watchdog] Update detected (${remoteCommit.slice(0, 7)}). Pulling changes from ${remoteName}/${branchName}...`);
    try {
      runGit(['pull', '--quiet', '--ff-only', remoteName, branchName]);
    } catch {
      runGit(['reset', '--hard', `${remoteName}/${branchName}`]);
    }
    const updatedCommit = runGit(['rev-parse', 'HEAD']);

    console.log(`[git-watchdog] Successfully updated from ${localCommit.slice(0, 7)} to ${updatedCommit.slice(0, 7)}.`);

    // 5. Restart bot so the new code is loaded into memory
    if (autoRestart) {
      console.log('[git-watchdog] Exiting process in 2 seconds to allow host/Pterodactyl/PM2 to restart with updated code...');
      setTimeout(() => {
        process.exit(0);
      }, 2000);
      return; // Do not schedule next check
    }

    consecutiveFailures = 0;
    lastError = null;
  } catch (error) {
    const details = error.stderr?.toString().trim() || error.message;
    consecutiveFailures++;
    if (details !== lastError) {
      console.error(`[git-watchdog] Pull check failed: ${details}`);
      lastError = details;
    }
  } finally {
    isChecking = false;
    const backoff = Math.min(intervalMs * (consecutiveFailures > 0 ? 1.5 : 1), maxFailureDelayMs);
    scheduleNextCheck(backoff);
  }
}

function manualPull() {
  if (!isGitRepo()) {
    const initialized = tryInitializeGitRepo();
    if (!initialized) {
      return { success: false, message: 'No git repository detected and auto-initialization failed.' };
    }
  }

  try {
    // 1. Fetch latest commits
    runGit(['fetch', '--quiet', remoteName, branchName]);

    const localCommit = runGit(['rev-parse', 'HEAD']);
    const remoteCommit = runGit(['rev-parse', `${remoteName}/${branchName}`]);

    if (localCommit === remoteCommit) {
      return {
        success: true,
        updated: false,
        message: `Already up to date on branch \`${branchName}\` (\`${localCommit.slice(0, 7)}\`).`
      };
    }

    // 2. Reset any dirty tracked files so pull never conflicts or blocks
    try {
      runGit(['reset', '--hard', 'HEAD']);
    } catch (resetErr) {
      console.warn('[git-watchdog] git reset note:', resetErr.message);
    }

    // 3. Fast-forward or pull latest remote commit
    try {
      runGit(['pull', '--quiet', remoteName, branchName]);
    } catch {
      runGit(['reset', '--hard', `${remoteName}/${branchName}`]);
    }
    const updatedCommit = runGit(['rev-parse', 'HEAD']);

    console.log(`[git-watchdog] Manual pull completed: ${localCommit.slice(0, 7)} -> ${updatedCommit.slice(0, 7)}. Restarting process...`);

    // 4. Restart process so updated code is loaded
    if (autoRestart) {
      setTimeout(() => {
        process.exit(0);
      }, 1500);
    }

    return {
      success: true,
      updated: true,
      message: `Successfully pulled updates (\`${localCommit.slice(0, 7)}\` ➔ \`${updatedCommit.slice(0, 7)}\`). Restarting bot...`
    };
  } catch (error) {
    const details = error.stderr?.toString().trim() || error.message;
    console.error(`[git-watchdog] Manual pull error: ${details}`);
    return {
      success: false,
      message: `Git pull failed: ${details}`
    };
  }
}

function start() {
  if (timer) return; // Already started
  console.log(`[git-watchdog] Active: Monitoring "${branchName}" from "${remoteName}" every ${Math.round(intervalMs / 1000)}s.`);
  checkForUpdates();
}

// Handle termination signals cleanly
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearTimeout(timer);
  });
}

// Auto-start immediately
start();

module.exports = {
  start,
  checkForUpdates,
  manualPull
};

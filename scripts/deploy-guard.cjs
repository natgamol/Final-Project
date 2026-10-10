#!/usr/bin/env node
/**
 * The only way this repo deploys to production.
 *
 * Production was once overwritten by a stale local build that predated fixes
 * already on master. Every production deploy script therefore runs through
 * here, and refuses unless:
 *
 *   1. the working tree is clean -- untracked files included, since anything
 *      under src/ is bundled whether git knows about it or not;
 *   2. origin/master has just been fetched, and HEAD is exactly origin/master --
 *      or HEAD is a release commit named in SMARTLIFE_RELEASE_COMMIT that
 *      contains all of origin/master, so nothing already on master is rolled
 *      back;
 *   3. a person at a terminal has read exactly what is about to be deployed and
 *      typed the commit id to confirm it. With no terminal it refuses, so no
 *      script, CI job or agent can deploy through it unattended.
 *
 * `firebase.json` runs `deploy-guard.cjs hook` before every deploy target, so a
 * bare `firebase deploy` that did not come through here -- the way a stale
 * `dist/` reaches hosting -- is refused as well.
 *
 *   node scripts/deploy-guard.cjs <target> [--dry-run]
 *   node scripts/deploy-guard.cjs hook          (from firebase.json only)
 */
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

const PROJECT = 'smartlife-budget';
const FIREBASE = 'npx -y firebase-tools@latest';
const CONFIRMED_ENV = 'SMARTLIFE_DEPLOY_CONFIRMED';
const RELEASE_ENV = 'SMARTLIFE_RELEASE_COMMIT';

const ADAPTIVE_FUNCTIONS = [
  'acceptSchedulingSuggestion', 'activateAdaptiveScheduling', 'calculateSchedulingPatterns',
  'chooseAlternativeSchedulingTime', 'createAdaptiveActivity', 'deleteSchedulingBehaviorHistory',
  'deleteSchedulingPattern', 'generateAdaptiveSuggestion', 'getAdaptiveSchedulingDashboard',
  'lockAdaptiveScheduleItem', 'processNaturalLanguageScheduleCommand', 'rebalanceUserDay',
  'rebalanceUserWeek', 'recordSchedulingBehavior', 'registerAdaptivePushToken',
  'rejectSchedulingSuggestion', 'scheduledAdaptiveOutcomeSweep', 'scheduledAdaptivePatternRecalculation',
  'scheduledAutomaticAdaptiveScheduling', 'undoScheduleChange', 'updateAdaptiveSchedulingPreferences',
];

/**
 * Every deployable target and the exact commands it runs. The commands live
 * here, not in package.json, so no shell quoting can split a deploy off from
 * the check in front of it. `watch` lists the paths whose changes since
 * origin/master are worth showing before a release-commit deploy.
 */
const TARGETS = {
  web: {
    description: 'web app -> Firebase Hosting (smartlife-budget.web.app), rebuilt from this commit',
    steps: ['npm run build:web', `${FIREBASE} deploy --only hosting --project ${PROJECT}`],
    watch: ['src', 'app.json', 'package.json'],
  },
  'firestore-rules': {
    description: 'Firestore security rules',
    steps: [`${FIREBASE} deploy --only firestore:rules --project ${PROJECT}`],
    watch: ['firestore.rules'],
  },
  'storage-rules': {
    description: 'Cloud Storage security rules',
    steps: [`${FIREBASE} deploy --only storage --project ${PROJECT}`],
    watch: ['storage.rules'],
  },
  // Only the two callables the receipt-dedupe change touches. Deploying every
  // function would also replace ones redeployed since from other trees.
  'scan-functions': {
    description: 'Cloud Functions analyzeScan + saveReviewedReceipt only, rebuilt from this commit',
    steps: ['npm --prefix functions run build', `${FIREBASE} deploy --only functions:analyzeScan,functions:saveReviewedReceipt --project ${PROJECT}`],
    watch: ['functions/src'],
  },
  functions: {
    description: 'ALL Cloud Functions, rebuilt from this commit',
    steps: ['npm --prefix functions run build', `${FIREBASE} deploy --only functions --project ${PROJECT}`],
    watch: ['functions/src', 'functions/package.json'],
  },
  'adaptive-backend': {
    description: 'Firestore rules + indexes and the adaptive-scheduling Cloud Functions',
    steps: [
      'npm --prefix functions run build',
      `${FIREBASE} deploy --only ${['firestore:rules', 'firestore:indexes', ...ADAPTIVE_FUNCTIONS.map((name) => `functions:${name}`)].join(',')} --project ${PROJECT}`,
    ],
    watch: ['firestore.rules', 'firestore.indexes.json', 'functions/src'],
  },
  preview: {
    // A preview channel expires and never replaces the live site, so it may be
    // any clean commit; it still has to be clean, so the preview is that commit.
    description: 'web app -> 7-day Hosting PREVIEW channel (live site untouched), rebuilt from this commit',
    preview: true,
    steps: ['npm run build:web', `${FIREBASE} hosting:channel:deploy preview --expires 7d --project ${PROJECT}`],
    watch: ['src'],
  },
  // Over-the-air JS updates replace the bundle on every installed app on the
  // channel, which is a production deploy in everything but name.
  'ota-production': {
    description: 'EAS over-the-air update -> EVERY installed app on the "production" channel',
    steps: ['npx -y eas-cli@latest update --clear-cache --channel production --environment production --message "SmartLife production update"'],
    watch: ['src', 'app.json', 'package.json'],
  },
  'ota-preview': {
    description: 'EAS over-the-air update -> installed apps on the "preview" channel (testers)',
    preview: true,
    steps: ['npx -y eas-cli@latest update --clear-cache --channel preview --environment preview --message "SmartLife preview update"'],
    watch: ['src'],
  },
};

function git(args, cwd) {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8'});
  // trimEnd, not trim: `status --porcelain` lines start with a significant space.
  return {ok: result.status === 0, out: (result.stdout || '').replace(/\s+$/, ''), err: (result.stderr || '').trim()};
}

/**
 * Every check, with no prompt and no side effect beyond `git fetch`, so it can
 * be exercised against scratch repositories. Returns what would be deployed
 * and every reason it may not be.
 */
function evaluate({cwd, target, releaseCommit = '', fetch = true}) {
  const spec = TARGETS[target];
  const problems = [];
  if (!spec) return {problems: [`unknown target "${target}" (known: ${Object.keys(TARGETS).join(', ')})`], spec: null};

  const head = git(['rev-parse', 'HEAD'], cwd).out;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).out;
  const subject = git(['log', '-1', '--format=%s  (%an, %ad)', '--date=short'], cwd).out;

  const dirty = git(['status', '--porcelain', '--untracked-files=all'], cwd).out;
  if (dirty) {
    const lines = dirty.split(/\r?\n/);
    problems.push(`the working tree is not clean (${lines.length} change(s)); commit, stash or remove them first:\n` +
      lines.slice(0, 15).map((line) => `      ${line}`).join('\n') + (lines.length > 15 ? `\n      ... and ${lines.length - 15} more` : ''));
  }

  if (fetch) {
    const fetched = git(['fetch', '--quiet', 'origin', 'master'], cwd);
    if (!fetched.ok) problems.push(`could not fetch origin/master, so this commit cannot be checked against it: ${fetched.err}`);
  }
  const master = git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master'], cwd).out;
  if (!master) problems.push('origin/master is unknown in this clone');

  let mode = 'origin/master';
  let ahead = [];
  let behind = [];
  if (master && head !== master) {
    ahead = git(['log', '--oneline', `${master}..${head}`], cwd).out.split(/\r?\n/).filter(Boolean);
    behind = git(['log', '--oneline', `${head}..${master}`], cwd).out.split(/\r?\n/).filter(Boolean);
    if (spec.preview) {
      mode = 'preview';
    } else if (releaseCommit) {
      const named = git(['rev-parse', '--verify', '--quiet', `${releaseCommit}^{commit}`], cwd).out;
      mode = 'release commit';
      if (!named) problems.push(`${RELEASE_ENV}="${releaseCommit}" is not a commit in this clone`);
      else if (named !== head) problems.push(`${RELEASE_ENV} names ${named.slice(0, 7)}, but HEAD is ${head.slice(0, 7)}; check out the release commit itself`);
      if (behind.length) {
        problems.push(`this release commit is missing ${behind.length} commit(s) that are on origin/master; deploying it would roll them back:\n` +
          behind.slice(0, 15).map((line) => `      ${line}`).join('\n'));
      }
    } else {
      problems.push(`HEAD (${head.slice(0, 7)}, ${branch}) is not origin/master (${master.slice(0, 7)}): ` +
        `${ahead.length} commit(s) not on master, ${behind.length} on master but not here. ` +
        `Deploy from an up-to-date master, or set ${RELEASE_ENV}=<this commit> to deploy a release commit on purpose.`);
    }
  }

  const changed = master && head !== master
    ? git(['diff', '--stat', master, head, '--', ...spec.watch], cwd).out
    : '';
  return {ahead, behind, branch, changed, head, master, mode, problems, spec, subject};
}

function printPlan(target, plan) {
  const {spec} = plan;
  console.log('');
  console.log('=================== SmartLife production deploy ===================');
  console.log(`  target    : ${target} -- ${spec.description}`);
  console.log(`  project   : ${PROJECT}`);
  console.log(`  commit    : ${plan.head} (${plan.branch})`);
  console.log(`              ${plan.subject}`);
  console.log(`  origin/master: ${plan.master || '(unknown)'}`);
  console.log(`  basis     : ${plan.mode}`);
  if (plan.ahead.length) {
    console.log(`  commits not on origin/master (${plan.ahead.length}):`);
    plan.ahead.slice(0, 20).forEach((line) => console.log(`      ${line}`));
  }
  if (plan.changed) {
    console.log(`  changed vs origin/master under ${spec.watch.join(', ')}:`);
    plan.changed.split(/\r?\n/).forEach((line) => console.log(`      ${line.trim()}`));
  }
  console.log('  will run, in order:');
  spec.steps.forEach((step, index) => console.log(`      ${index + 1}. ${step}`));
  console.log('====================================================================');
}

function ask(question) {
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

async function run(target, {dryRun}) {
  const cwd = path.resolve(__dirname, '..');
  const plan = evaluate({cwd, releaseCommit: process.env[RELEASE_ENV] || '', target});
  if (!plan.spec) {
    console.error(`deploy-guard: ${plan.problems[0]}`);
    return 2;
  }
  printPlan(target, plan);
  if (plan.problems.length) {
    console.error('\nREFUSED -- nothing was deployed:');
    plan.problems.forEach((problem) => console.error(`  - ${problem}`));
    return 1;
  }
  if (dryRun) {
    console.log('\n--dry-run: every check passed; nothing was deployed.');
    return 0;
  }
  if (!process.stdin.isTTY) {
    console.error('\nREFUSED -- no terminal to confirm at, so nothing was deployed. Production deploys need a person to type the commit id.');
    return 1;
  }
  const expected = plan.head.slice(0, 7);
  const answer = await ask(`\nType the commit id ${expected} to deploy exactly this; anything else cancels: `);
  if (answer !== expected) {
    console.error('Cancelled -- nothing was deployed.');
    return 1;
  }
  for (const step of plan.spec.steps) {
    console.log(`\n> ${step}`);
    const result = spawnSync(step, {cwd, env: {...process.env, [CONFIRMED_ENV]: plan.head}, shell: true, stdio: 'inherit'});
    if (result.status !== 0) {
      console.error(`\nStopped: "${step}" failed (exit ${result.status}).`);
      return result.status || 1;
    }
  }
  console.log(`\nDeployed ${target} from ${plan.head.slice(0, 7)}.`);
  return 0;
}

/** firebase.json `predeploy`: pass only a deploy this guard confirmed, for this HEAD. */
function hook() {
  const cwd = process.env.PROJECT_DIR || path.resolve(__dirname, '..');
  const head = git(['rev-parse', 'HEAD'], cwd).out;
  const confirmed = process.env[CONFIRMED_ENV] || '';
  if (confirmed && confirmed === head) return 0;
  console.error('\nREFUSED by scripts/deploy-guard.cjs: this deploy did not go through the guard' +
    (confirmed ? ` (it confirmed ${confirmed.slice(0, 7)}, but HEAD is now ${head.slice(0, 7)})` : '') + '.');
  console.error('Deploy with one of: npm run deploy:web | deploy:firestore-rules | deploy:storage-rules | deploy:scan-functions | deploy:functions | deploy:adaptive-backend | preview:web');
  return 1;
}

if (require.main === module) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'hook') process.exit(hook());
  if (!command) {
    console.error(`usage: node scripts/deploy-guard.cjs <${Object.keys(TARGETS).join('|')}> [--dry-run]`);
    process.exit(2);
  }
  run(command, {dryRun: rest.includes('--dry-run')}).then((code) => process.exit(code));
}

module.exports = {CONFIRMED_ENV, RELEASE_ENV, TARGETS, evaluate, hook};

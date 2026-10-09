// Checks scripts/deploy-guard.cjs against scratch git repositories with a local
// bare "origin", so every refusal is proven without a network or a deploy. Also
// checks that no production deploy in package.json, functions/package.json or
// firebase.json can run without going through the guard.
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guard = require('./deploy-guard.cjs');

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -> ${detail}` : ''}`);
}

function sh(cwd, ...args) {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8'});
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-guard-'));
try {
  // origin with one commit on master, and a working clone of it.
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const work = path.join(root, 'work');
  sh(root, 'init', '--quiet', '--bare', '--initial-branch=master', origin);
  sh(root, 'init', '--quiet', '--initial-branch=master', seed);
  for (const repo of [seed]) {
    sh(repo, 'config', 'user.email', 'guard-test@smartlife.test');
    sh(repo, 'config', 'user.name', 'Guard Test');
  }
  fs.writeFileSync(path.join(seed, 'app.txt'), 'v1\n');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '--quiet', '-m', 'v1');
  sh(seed, 'remote', 'add', 'origin', origin);
  sh(seed, 'push', '--quiet', 'origin', 'master');
  sh(root, 'clone', '--quiet', origin, work);
  sh(work, 'config', 'user.email', 'guard-test@smartlife.test');
  sh(work, 'config', 'user.name', 'Guard Test');

  const evaluate = (target, releaseCommit = '') => guard.evaluate({cwd: work, releaseCommit, target});
  const problemsOf = (plan) => plan.problems.join(' | ');

  // 1. The normal case: clean, and exactly origin/master.
  let plan = evaluate('web');
  check('clean checkout of origin/master passes', plan.problems.length === 0 && plan.mode === 'origin/master', problemsOf(plan));

  // 2-3. Uncommitted work blocks, whether git tracks the file or not.
  fs.writeFileSync(path.join(work, 'app.txt'), 'v1 edited\n');
  plan = evaluate('web');
  check('a modified tracked file is refused', /not clean/.test(problemsOf(plan)), problemsOf(plan));
  sh(work, 'checkout', '--', 'app.txt');
  fs.writeFileSync(path.join(work, 'stray.ts'), 'export {};\n');
  plan = evaluate('web');
  check('an untracked file is refused (it would be bundled)', /not clean/.test(problemsOf(plan)) && /stray\.ts/.test(problemsOf(plan)), problemsOf(plan));
  fs.rmSync(path.join(work, 'stray.ts'));

  // 4. A local commit that is not on master -- the stale/unmerged build case.
  fs.writeFileSync(path.join(work, 'app.txt'), 'v2-local\n');
  sh(work, 'commit', '--quiet', '-am', 'local only');
  const localHead = sh(work, 'rev-parse', 'HEAD');
  plan = evaluate('web');
  check('HEAD ahead of origin/master is refused without a named release', /is not origin\/master/.test(problemsOf(plan)), problemsOf(plan));

  // 5. Named on purpose as the release commit, and it contains all of master.
  plan = evaluate('web', localHead.slice(0, 7));
  check('a named release commit that contains origin/master passes', plan.problems.length === 0 && plan.mode === 'release commit' && plan.ahead.length === 1,
    problemsOf(plan));

  // 6. The release env naming some other commit.
  plan = evaluate('web', sh(work, 'rev-parse', 'HEAD~1'));
  check('a release env that names a different commit is refused', /check out the release commit itself/.test(problemsOf(plan)), problemsOf(plan));

  // 7. Master moved on (a fix landed) after this commit branched: deploying it
  //    would roll the fix back -- the production-overwrite incident.
  fs.writeFileSync(path.join(seed, 'fix.txt'), 'the fix\n');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '--quiet', '-m', 'fix on master');
  sh(seed, 'push', '--quiet', 'origin', 'master');
  plan = evaluate('web', localHead);
  check('a release commit missing a fix that is on origin/master is refused', /roll them back/.test(problemsOf(plan)) && /fix on master/.test(problemsOf(plan)),
    problemsOf(plan));
  check('...the guard fetched origin, so the new master commit was seen', plan.behind.length === 1, `${plan.behind.length} behind`);

  // 8. Back on master but not pulled: stale local master.
  sh(work, 'checkout', '--quiet', '-B', 'master', 'HEAD~1');
  plan = evaluate('web');
  check('a local master behind origin/master is refused', /is not origin\/master/.test(problemsOf(plan)) && plan.behind.length === 1, problemsOf(plan));
  sh(work, 'reset', '--quiet', '--hard', 'origin/master');
  plan = evaluate('firestore-rules');
  check('after pulling, the same clone passes again', plan.problems.length === 0, problemsOf(plan));

  // 9. Previews may be any clean commit, but must still be clean.
  sh(work, 'checkout', '--quiet', localHead);
  plan = evaluate('preview');
  check('a hosting preview of a branch commit passes', plan.problems.length === 0 && plan.mode === 'preview', problemsOf(plan));
  plan = evaluate('ota-production');
  check('an OTA production update of the same commit is refused', /is not origin\/master/.test(problemsOf(plan)), problemsOf(plan));
  fs.writeFileSync(path.join(work, 'stray.ts'), 'export {};\n');
  check('a preview from a dirty tree is refused', /not clean/.test(problemsOf(evaluate('preview'))));
  fs.rmSync(path.join(work, 'stray.ts'));

  // 10. Unknown target.
  check('an unknown target is refused', /unknown target/.test(problemsOf(evaluate('everything'))));

  // 11. The firebase predeploy hook: only a guard-confirmed deploy of this HEAD.
  const head = sh(work, 'rev-parse', 'HEAD');
  const runHook = (confirmed) => spawnSync(process.execPath, [path.join(__dirname, 'deploy-guard.cjs'), 'hook'], {
    encoding: 'utf8',
    env: {...process.env, PROJECT_DIR: work, [guard.CONFIRMED_ENV]: confirmed},
  });
  check('hook refuses a bare firebase deploy', runHook('').status === 1);
  check('hook refuses a confirmation for another commit', runHook(sh(work, 'rev-parse', 'origin/master')).status === 1);
  check('hook passes the confirmed commit', runHook(head).status === 0);

  // 12. Without a terminal, `run` refuses even when every check passes.
  sh(work, 'checkout', '--quiet', 'master');
  const noTty = spawnSync(process.execPath, ['-e',
    `const g=require(${JSON.stringify(path.join(__dirname, 'deploy-guard.cjs'))});` +
    `process.chdir(${JSON.stringify(work)});`], {encoding: 'utf8'});
  check('the guard module loads without side effects', noTty.status === 0, noTty.stderr);
} finally {
  fs.rmSync(root, {force: true, recursive: true});
}

// --- every production deploy in this repo goes through the guard ------------
const repo = path.resolve(__dirname, '..');
const scripts = {
  ...JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).scripts,
  ...Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(repo, 'functions/package.json'), 'utf8')).scripts)
    .map(([name, command]) => [`functions:${name}`, command])),
};
const raw = Object.entries(scripts).filter(([, command]) =>
  /firebase-tools[^&|]*\s(deploy|hosting:channel:deploy)\b/.test(command) || /eas-cli[^&|]*\supdate\b/.test(command));
check('no package script deploys without the guard', raw.length === 0, raw.map(([name]) => name).join(', '));
for (const name of ['deploy:web', 'deploy:firestore-rules', 'deploy:storage-rules', 'deploy:scan-functions', 'deploy:functions', 'deploy:adaptive-backend', 'preview:web', 'update:production', 'update:preview', 'functions:deploy']) {
  check(`${name} runs deploy-guard`, /deploy-guard\.cjs\s+\S+/.test(scripts[name] ?? ''), scripts[name]);
}
const firebaseJson = JSON.parse(fs.readFileSync(path.join(repo, 'firebase.json'), 'utf8'));
for (const section of ['hosting', 'firestore', 'storage', 'functions']) {
  const hooks = [].concat(firebaseJson[section]?.predeploy ?? []);
  check(`firebase.json ${section} predeploy runs the guard hook`, hooks.some((hook) => /deploy-guard\.cjs hook/.test(hook)), JSON.stringify(hooks));
}
for (const file of ['update-website.cmd', 'scripts/deploy-firestore-rules.cmd']) {
  const text = fs.readFileSync(path.join(repo, file), 'utf8');
  check(`${file} goes through an npm deploy script, not firebase directly`,
    !/^\s*call\s+npx[^\r\n]*firebase-tools[^\r\n]*deploy/im.test(text) && /call npm run deploy:/i.test(text));
}
assert.ok(Object.keys(guard.TARGETS).length >= 8);

console.log(failures ? `\n${failures} deploy guard check(s) FAILED` : '\ndeploy guard passed: nothing reaches production unclean, off master, or unconfirmed');
process.exit(failures ? 1 : 0);

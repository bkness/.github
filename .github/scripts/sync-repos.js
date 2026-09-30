// Keeps every bkness repo on the same settings. Run by sync-repos.yml
// through actions/github-script, which passes in github (Octokit) and core.
// Only changes what has drifted, and reports each change.

const OWNER = 'bkness';

// Every non-archived repo gets these
const SETTINGS = {
  delete_branch_on_merge: true,
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  squash_merge_commit_title: 'PR_TITLE',
  squash_merge_commit_message: 'PR_BODY',
};

// Dependabot security PRs stay off here: an Expo bump outside Expo's
// pinned set broke the nightowlz simulator. Alerts stay on everywhere.
// Listed repos are left alone, not switched off, so turning one back on by
// hand sticks.
const SKIP_AUTOFIX = ['nightowlz', 'breweries', 'Local-Breweries'];

const LABELS = [
  { name: 'bug',             color: 'd73a4a', description: "Something isn't working" },
  { name: 'feature',         color: 'a2eeef', description: 'New feature or improvement' },
  { name: 'cleanup',         color: '0075ca', description: 'Maintenance or refactor' },
  { name: 'security',        color: 'e4e669', description: 'Security related' },
  { name: 'backend',         color: '0052cc', description: 'Backend changes' },
  { name: 'frontend',        color: 'bfd4f2', description: 'Frontend changes' },
  { name: 'auth',            color: 'f9d0c4', description: 'Auth related' },
  { name: 'priority:high',   color: 'b60205', description: 'High priority' },
  { name: 'priority:medium', color: 'fbca04', description: 'Medium priority' },
  { name: 'priority:low',    color: '0e8a16', description: 'Low priority' },
];

// Labels only go on repos I've pushed to recently; old ones don't need them
const LABEL_WINDOW_DAYS = 365;

module.exports = async ({ github, core, dryRun }) => {
  const repos = (await github.paginate(github.rest.repos.listForAuthenticatedUser, {
    affiliation: 'owner', per_page: 100,
  })).filter((r) => r.owner.login === OWNER && !r.archived);

  const cutoff = Date.now() - LABEL_WINDOW_DAYS * 864e5;
  const rows = [];
  let failed = 0;

  // In a dry run, record the change instead of making it
  const apply = async (changes, what, fn) => {
    changes.push(what);
    if (!dryRun) await fn();
  };

  for (const repo of repos) {
    const name = repo.name;
    const changes = [];
    try {
      // repos.list omits the merge settings, so read the full repo
      const { data: full } = await github.rest.repos.get({ owner: OWNER, repo: name });

      const drift = Object.fromEntries(
        Object.entries(SETTINGS).filter(([k, v]) => full[k] !== v));
      if (Object.keys(drift).length) {
        await apply(changes, `settings: ${Object.keys(drift).join(', ')}`,
          () => github.rest.repos.update({ owner: OWNER, repo: name, ...drift }));
      }

      if (!full.private) {
        const sa = full.security_and_analysis || {};
        const off = ['secret_scanning', 'secret_scanning_push_protection']
          .filter((k) => sa[k]?.status !== 'enabled');
        if (off.length) {
          await apply(changes, `enable ${off.join(' + ')}`, () => github.rest.repos.update({
            owner: OWNER, repo: name,
            security_and_analysis: Object.fromEntries(off.map((k) => [k, { status: 'enabled' }])),
          }));
        }
      }

      // 204 = alerts on, 404 = off
      const alertsOn = await github.rest.repos.checkVulnerabilityAlerts({ owner: OWNER, repo: name })
        .then(() => true, (e) => { if (e.status === 404) return false; throw e; });
      if (!alertsOn) {
        await apply(changes, 'enable Dependabot alerts',
          () => github.rest.repos.enableVulnerabilityAlerts({ owner: OWNER, repo: name }));
      }

      if (!SKIP_AUTOFIX.includes(name)) {
        const { data: fixes } = await github.request('GET /repos/{owner}/{repo}/automated-security-fixes',
          { owner: OWNER, repo: name });
        if (!fixes.enabled) {
          await apply(changes, 'enable Dependabot security PRs',
            () => github.rest.repos.enableAutomatedSecurityFixes({ owner: OWNER, repo: name }));
        }
      }

      if (!repo.fork && Date.parse(repo.pushed_at) >= cutoff) {
        // Add missing labels only; a label I've recolored in one repo stays as is
        const existing = new Set((await github.paginate(github.rest.issues.listLabelsForRepo, {
          owner: OWNER, repo: name, per_page: 100,
        })).map((l) => l.name.toLowerCase()));
        const missing = LABELS.filter((l) => !existing.has(l.name.toLowerCase()));
        if (missing.length) {
          await apply(changes, `add labels: ${missing.map((l) => l.name).join(', ')}`, async () => {
            for (const label of missing) await github.rest.issues.createLabel({ owner: OWNER, repo: name, ...label });
          });
        }
      }
    } catch (e) {
      failed++;
      changes.push(`❌ ${e.status || ''} ${e.message}`.trim());
    }
    if (changes.length) rows.push([name, changes.join('<br>')]);
    core.info(`${changes.length ? '🔧' : '✅'} ${name}${changes.length ? `: ${changes.join('; ')}` : ''}`);
  }

  const verb = dryRun ? 'would change' : 'changed';
  await core.summary
    .addHeading(`Sync repos${dryRun ? ' (dry run)' : ''}`)
    .addRaw(`${repos.length} repos checked · ${rows.length} ${verb} · ${failed} failed`, true)
    .addTable([[{ data: 'Repo', header: true }, { data: 'Changes', header: true }], ...rows])
    .write();

  if (failed) core.setFailed(`${failed} repo(s) failed — see the summary`);
};

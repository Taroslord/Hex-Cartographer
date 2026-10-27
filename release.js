#!/usr/bin/env node
/*
 * Release helper.
 *
 * Obsidian reads two things: the manifest at the head of the default branch, and the
 * newest GitHub release. If the manifest names a version that has no release, the plugin
 * drops out of the community directory — that happened here between 16 July and
 * 11 August 2026. So the version bump and the release have to happen in one go, which is
 * what this script is for.
 *
 *   node release.js 2.0.0           show what would happen, change nothing
 *   node release.js 2.0.0 --run     do it
 *
 * Options:
 *   --min <x.y.z>   also raise minAppVersion (adds a versions.json entry)
 *   --skip-tests    do not run the test suite beforehand
 *
 * There is no node in PATH on this machine; use the one Adobe ships:
 *   "C:\Program Files\Adobe\Adobe Creative Cloud Experience\libs\node.exe" release.js 2.0.0
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const ASSETS = ['main.js', 'manifest.json', 'styles.css'];
const TEST_DIR = path.resolve(ROOT, '..', 'Hex-Cartographer-Tests');

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--'));
const run = args.includes('--run');
const skipTests = args.includes('--skip-tests');
const minArg = args.includes('--min') ? args[args.indexOf('--min') + 1] : null;

const die = (msg) => { console.error('ABBRUCH: ' + msg); process.exit(1); };
const say = (msg) => console.log(msg);
const step = (msg) => console.log((run ? '  -> ' : '  wuerde: ') + msg);

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const gh = (...a) => execFileSync('gh', a, { cwd: ROOT, encoding: 'utf8' }).trim();

// --- checks ---------------------------------------------------------------
if (!version) die('Keine Version angegeben. Beispiel: node release.js 2.0.0');
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`"${version}" ist keine Version im Format x.y.z`);
if (minArg && !/^\d+\.\d+\.\d+$/.test(minArg)) die(`"${minArg}" ist keine Version im Format x.y.z`);

const manifestPath = path.join(ROOT, 'manifest.json');
const versionsPath = path.join(ROOT, 'versions.json');
const manifestText = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestText);
const minApp = minArg || manifest.minAppVersion;

// Newer than what is there now — a lower number would hide the release from the updater.
const cmp = (a, b) => {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
};
if (cmp(version, manifest.version) <= 0) {
    die(`${version} ist nicht neuer als die aktuelle Version ${manifest.version}`);
}

if (git('status', '--porcelain')) die('Arbeitsverzeichnis ist nicht sauber — erst committen.');

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const defaultBranch = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '');
if (branch !== defaultBranch) die(`Du bist auf "${branch}", nicht auf "${defaultBranch}".`);

git('fetch', 'origin', '--tags', '--quiet');
if (git('rev-list', '--count', `origin/${branch}..${branch}`) !== '0'
    || git('rev-list', '--count', `${branch}..origin/${branch}`) !== '0') {
    die(`"${branch}" und "origin/${branch}" laufen auseinander — erst pullen/pushen.`);
}

if (git('tag', '-l', version)) die(`Tag ${version} existiert bereits.`);
for (const f of ASSETS) if (!fs.existsSync(path.join(ROOT, f))) die(`${f} fehlt.`);

// A broken main.js must never reach a release.
try {
    new (require('vm').Script)(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'), { filename: 'main.js' });
} catch (e) {
    die('main.js hat einen Syntaxfehler: ' + e.message);
}

// The suite lives next to the repo so it never ships; run it when it is there.
if (!skipTests && fs.existsSync(TEST_DIR)) {
    say('Tests:');
    let failed = 0;
    for (const f of fs.readdirSync(TEST_DIR).filter((n) => /^test_.*\.js$/.test(n))) {
        try {
            const out = execFileSync(process.execPath, [path.join(TEST_DIR, f)], { encoding: 'utf8' });
            say('  ok   ' + f + '  ' + out.trim().split('\n').pop());
        } catch (e) {
            failed++;
            say('  FAIL ' + f);
            say((e.stdout || '').trim().split('\n').slice(-3).join('\n'));
        }
    }
    if (failed) die(failed + ' Testdatei(en) fehlgeschlagen.');
} else if (!skipTests) {
    say('Hinweis: Testordner nicht gefunden (' + TEST_DIR + ') — uebersprungen.');
}

// --- plan -----------------------------------------------------------------
say('');
say(`Release ${version}   (bisher ${manifest.version}, minAppVersion ${manifest.minAppVersion}${minArg ? ' -> ' + minApp : ''})`);
say('');

// versions.json is only read when a user's app is OLDER than minAppVersion. So it needs an
// entry only when minAppVersion rises — then older installs keep the last build that ran
// for them. Writing an entry for a version that has no release is what broke things before.
const versionsText = fs.readFileSync(versionsPath, 'utf8');
const versions = JSON.parse(versionsText);
const lastRecorded = Object.values(versions).pop();
const needsVersionsEntry = minApp !== lastRecorded;

step(`manifest.json: version ${manifest.version} -> ${version}` + (minArg ? `, minAppVersion -> ${minApp}` : ''));
if (needsVersionsEntry) step(`versions.json: Eintrag "${version}": "${minApp}" ergaenzen (minAppVersion hat sich geaendert)`);
else step(`versions.json: unveraendert (minAppVersion bleibt ${minApp})`);
step(`committen: "Release ${version}"`);
step(`Tag ${version} auf diesen Commit setzen (ohne v-Praefix)`);
step(`pushen: ${branch} und Tag ${version}`);
step(`GitHub-Release ${version} anlegen mit ${ASSETS.join(', ')}`);

if (!run) {
    say('');
    say('Nichts geaendert. Zum Ausfuehren dieselbe Zeile mit --run wiederholen.');
    process.exit(0);
}

// --- do it ----------------------------------------------------------------
say('');
// Targeted line edits keep the hand-written formatting of both files intact.
let out = manifestText.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
if (minArg) out = out.replace(/("minAppVersion"\s*:\s*")[^"]*(")/, `$1${minApp}$2`);
fs.writeFileSync(manifestPath, out, 'utf8');

if (needsVersionsEntry) {
    const add = `    "${version}": "${minApp}"`;
    fs.writeFileSync(versionsPath, versionsText.replace(/\n\}\s*$/, `,\n${add}\n}\n`), 'utf8');
}

// From here on the steps build on each other. If one fails, say plainly what is already
// done — between the push and the release is exactly the state that must not go unnoticed.
const must = (what, fn, hint) => {
    try {
        return fn();
    } catch (e) {
        const detail = (e.stderr || e.stdout || e.message || '').toString().trim();
        say('');
        die(what + ' fehlgeschlagen:\n  ' + detail.split('\n').join('\n  ') + (hint ? '\n\n' + hint : ''));
    }
};

must('Commit', () => {
    git('add', 'manifest.json', 'versions.json');
    git('commit', '-m', `Release ${version}`);
    git('tag', version);
}, 'Nichts wurde gepusht. Pruefe den Stand mit "git status" und "git tag -l".');

must('Push', () => {
    git('push', 'origin', branch);
    git('push', 'origin', `refs/tags/${version}`);
}, `Der Commit liegt lokal, das Manifest nennt bereits ${version}.\n`
 + 'Entweder nachpushen oder zuruecknehmen:\n'
 + `  git tag -d ${version} && git reset --hard HEAD~1`);
say('  gepusht: ' + branch + ' + Tag ' + version);

must('Release anlegen', () => {
    gh('release', 'create', version, ...ASSETS.map((f) => path.join(ROOT, f)),
        '--title', version, '--notes', `Release ${version}`);
}, 'ACHTUNG: Commit und Tag sind bereits auf GitHub, das Release fehlt aber noch.\n'
 + `Damit nennt das Manifest ${version}, ohne dass es diese Version zu laden gibt —\n`
 + 'genau der Zustand, der das Plugin aus dem Verzeichnis wirft. Sofort nachholen:\n'
 + `  gh release create ${version} ${ASSETS.join(' ')} --title ${version} --notes "Release ${version}"`);
say('  Release angelegt.');
say('');
say('Fertig. Release-Notes auf GitHub noch ausformulieren:');
say('  https://github.com/Taroslord/Hex-Cartographer/releases/tag/' + version);

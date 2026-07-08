// Test d'intégration : valide l'isolation SQL 2 phases DIRECTEMENT contre Piston réel.
// Rejoue la même logique que ExecutionService.runSqlIsolated (setup -> code etudiant -> .dump ->
// filtre tables de travail -> verdict encadre par nonce). A lancer DANS le conteneur Piston
// (localhost:2000). Cf. scripts/README.md. Aucun effet de bord (sandbox jetable).
const http = require('http');
const OPT = { host: 'localhost', port: 2000, path: '/api/v2/execute', method: 'POST' };
const NONCE = 'MOODIT_TEST_NONCE';
const DS = NONCE + '_DUMP_START', DE = NONCE + '_DUMP_END';
const VS = NONCE + '_VERDICT_START', VE = NONCE + '_VERDICT_END';

const SETUP = "CREATE TABLE utilisateurs(nom TEXT, actif INTEGER);\n" +
              "INSERT INTO utilisateurs VALUES('Alice',1),('Bob',1),('Chloe',1);\n";
const VERDICT = "SELECT (SELECT count(*) FROM utilisateurs WHERE actif = 0) = 3;\n";
const WORKING_TABLES = ['utilisateurs']; // liste blanche = tables du setup (cf. sqlWorkingTables)

function run(sql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ language: 'sqlite3', version: '*',
      files: [{ name: 'main.sql', content: sql }], run_timeout: 3000 });
    const opt = Object.assign({}, OPT, { headers: { 'content-type': 'application/json',
      'content-length': Buffer.byteLength(body) } });
    const req = http.request(opt, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).run || {}); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
function between(out, a, b) {
  const L = (out || '').split('\n'); let s = -1, e = -1;
  for (let i = 0; i < L.length; i++) { const t = L[i].trim();
    if (s < 0) { if (t === a) s = i; } else if (t === b) { e = i; break; } }
  return (s < 0 || e < 0) ? null : L.slice(s + 1, e);
}
function filterDump(lines) {
  const out = [];
  for (const l of (lines || [])) {
    const m = l.match(/^\s*(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|INSERT(?:\s+OR\s+\w+)?\s+INTO)\s+["']?(\w+)/i);
    if (m && WORKING_TABLES.indexOf(m[1].toLowerCase()) >= 0) out.push(l);
  }
  return out.join('\n');
}
async function grade(student) {
  const p1 = SETUP + student + "\n;\n" + "SELECT '" + DS + "';\n.dump\nSELECT '" + DE + "';\n";
  const r1 = await run(p1);
  if (r1.code !== 0) return { ok: false, why: 'phase1 exit=' + r1.code + ' ' + (r1.stderr || '') };
  const dl = between(r1.stdout, DS, DE);
  if (!dl) return { ok: false, why: 'dump introuvable' };
  const p2 = filterDump(dl) + "\nSELECT '" + VS + "';\n" + VERDICT + "\n;\nSELECT '" + VE + "';\n";
  const r2 = await run(p2);
  if (r2.code !== 0) return { ok: false, why: 'phase2 exit=' + r2.code + ' ' + (r2.stderr || '') };
  const vb = between(r2.stdout, VS, VE);
  const verdict = (vb || []).map(x => x.trim()).filter(Boolean).pop() || '';
  return { ok: verdict === '1', verdict };
}
(async () => {
  const cases = [
    ['reponse correcte (UPDATE tous inactifs)', "UPDATE utilisateurs SET actif = 0;", true],
    ['ne fait rien', "SELECT 42;", false],
    ['triche: affiche 1 avant', "SELECT 1;", false],
    ['DDL isole: DROP + recree vide', "DROP TABLE utilisateurs; CREATE TABLE utilisateurs(nom TEXT, actif INTEGER);", false],
  ];
  let allGood = true;
  for (const c of cases) {
    const res = await grade(c[1]);
    const good = res.ok === c[2];
    if (!good) allGood = false;
    console.log((good ? 'OK      ' : 'MISMATCH') + ' | passed=' + res.ok + ' (attendu ' + c[2] + ') | ' + c[0] +
      (res.why ? ' [' + res.why + ']' : ''));
  }
  console.log(allGood ? 'TOUS OK : isolation 2 phases validee sur Piston reel.' : 'ECHEC : cas inattendu.');
  process.exit(allGood ? 0 : 1);
})();

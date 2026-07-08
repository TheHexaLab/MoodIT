// Test d'intégration : valide le BINAIRE DÉPLOYÉ via son endpoint interne POST /internal/exec/evaluate
// (donc le vrai code Java : runSqlIsolated + 2 appels Piston). Couvre les deux modes SQL (lecture
// seule solution#, modification isolee). Requiert MOODIT_TOKEN = INTERNAL_TOKEN. Cf. scripts/README.md.
const http = require('http');
const TOKEN = process.env.MOODIT_TOKEN || '';
const HOST = process.env.EXEC_HOST || 'localhost';
const PORT = parseInt(process.env.EXEC_PORT || '8084', 10);

const MARK = "\n-" + "- @student\n"; // évite un littéral "-- @student" (fragile au collage shell)
const RO = "CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);\n" +
           "INSERT INTO utilisateurs VALUES ('Alice',1),('Bob',0),('Carol',1);\n" +
           "SELECT (SELECT count(*) FROM solution) = 2;\n";
const MUT = "CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);\n" +
            "INSERT INTO utilisateurs VALUES ('Alice',1),('Bob',1),('Carol',1);" + MARK +
            "SELECT (SELECT count(*) FROM utilisateurs) = 3\n" +
            "   AND (SELECT count(*) FROM utilisateurs WHERE actif = 0) = 3;\n";

function evaluate(harness, code) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ language: 'SQL', version: '*', code: code,
      testCases: [{ name: 't', harnessCode: harness, weight: 1 }] });
    const req = http.request({ host: HOST, port: PORT, path: '/internal/exec/evaluate', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        'x-internal-token': TOKEN } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' ' + d));
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}
(async () => {
  const cases = [
    ['RO   reponse correcte', RO,  "SELECT nom FROM utilisateurs WHERE actif = 1", true],
    ['RO   reponse fausse',   RO,  "SELECT * FROM utilisateurs WHERE actif = 1",  false],
    ['MUT  reponse correcte', MUT, "UPDATE utilisateurs SET actif = 0;",          true],
    ['MUT  ne fait rien',     MUT, "SELECT 42;",                                  false],
    ['MUT  triche affiche 1', MUT, "SELECT 1;",                                   false],
    ['MUT  DDL isole (DROP)', MUT, "DROP TABLE utilisateurs; CREATE TABLE utilisateurs(nom TEXT, actif INTEGER);", false],
  ];
  let allGood = true;
  for (const c of cases) {
    try {
      const res = await evaluate(c[1], c[2]);
      const passed = res[0] && res[0].passed;
      const good = passed === c[3];
      if (!good) allGood = false;
      console.log((good ? 'OK      ' : 'MISMATCH') + ' | passed=' + passed + ' (attendu ' + c[3] + ') | ' + c[0] +
        (res[0] && res[0].detail ? ' [' + res[0].detail + ']' : ''));
    } catch (e) { allGood = false; console.log('ERROR   | ' + c[0] + ' => ' + e.message); }
  }
  console.log(allGood ? 'TOUS OK : binaire deploye valide (lecture seule + modification isolee).'
                      : 'ECHEC : cas inattendu (binaire pas rebuild ? mauvais jeton ?).');
  process.exit(allGood ? 0 : 1);
})();

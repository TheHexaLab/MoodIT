-- #116 — Gabarits de l'éditeur alignés sur les conteneurs runner (retrait de Piston).
--
-- 1. L'en-tête « Sandbox : … » des codes de départ décrit l'environnement réel d'exécution
--    (audité, pas deviné). Les runtimes viennent désormais des images moodit-runner-*
--    (docker/runners/) : Node 22 (images node:22) remplace le Node 20 de Piston pour JavaScript
--    et TypeScript.
--
-- 2. Harnais des langages COMPILÉS : un CORPS QUI RENVOIE UN BOOLÉEN, seule forme que l'on sait
--    noter SANS QUE L'ÉTUDIANT PUISSE FALSIFIER SON RÉSULTAT. Il est noté par le modèle à DEUX
--    PROCESSUS et DEUX UID (superviseur : run_java_rpc, run_go_rpc, run_c_rpc, run_rust_rpc,
--    run_csharp_rpc) : le harnais et le nonce vivent dans un programme séparé, l'étudiant n'est
--    qu'un répondeur. Il ne peut ni lire ni modifier le harnais, ni forger son résultat — non
--    parce qu'on le détecte, mais parce qu'il n'y a plus rien à attaquer chez lui. L'appel de
--    fonction et la POO restent naturels : les objets sont proxifiés par POIGNÉE (l'instance
--    vit chez l'étudiant).
--
--    Un vrai test du framework (JUnit, NUnit, go test, cargo test), compilé AVEC le code de
--    l'étudiant, a été essayé pendant #116 puis écarté : le code noté partageait le processus
--    qui détient le secret et calcule le verdict, et plusieurs canaux de forge ont été démontrés.
--    Un harnais qui en porte le marqueur est refusé avec un diagnostic.
--
--    Seuls les GABARITS changent (questions futures). Les questions compilées déjà en base sont
--    à rejouer contre ce noteur avant d'être soumises (deploy/check-compiled-harnesses.py, cf.
--    deploy/DEPLOY.md). V2 étant fusionnée, on corrige par UPDATE (Flyway forward-only).
UPDATE Language SET start_code_template =
    replace(start_code_template, 'Node.js 20', 'Node.js 22')
WHERE name IN ('JavaScript', 'TypeScript');

UPDATE Language SET harness_template = ht.tpl
FROM (VALUES
    ('Java', $hc$// HARNAIS (Java) — un corps qui RENVOIE UN BOOLÉEN. Il est compilé dans un
// PROCESSUS SÉPARÉ, sous un UID séparé : le code de l'étudiant ne peut ni le lire, ni le
// modifier, ni falsifier son résultat. Les objets sont proxifiés : l'instance vit chez lui.
// Sandbox : JDK 25 (aucun réseau). Types échangeables : int, long, double, boolean, String.
return Solution.solution() == ATTENDU;
$hc$),
    ('C#', $hc$// HARNAIS (C#) — un corps qui RENVOIE UN BOOLÉEN, compilé dans un PROCESSUS
// SÉPARÉ sous un UID séparé : ni lisible, ni modifiable, ni falsifiable par le code noté.
// Les objets sont proxifiés : new Solution(3, 4).Aire() appelle l'instance CHEZ l'étudiant.
// Sandbox : Mono (aucun réseau). Types échangeables : int, long, double, bool, string.
return Solution.solution() == ATTENDU;
$hc$),
    ('Go', $hc$// HARNAIS (Go) — un corps qui RENVOIE UN BOOLÉEN, compilé dans un BINAIRE
// SÉPARÉ sous un UID séparé : ni lisible, ni modifiable, ni falsifiable par le code noté.
// Go n'a pas de constructeur : les DEUX idiomes sont proxifiés — le littéral à champs nommés
// (Rectangle{largeur: 3, hauteur: 4}) et la fonction qui renvoie la structure (NewRectangle).
// Types échangeables : int, int64, float64, bool, string.
return solution() == ATTENDU
$hc$),
    ('Rust', $hc$// HARNAIS (Rust) — une EXPRESSION BOOLÉENNE, compilée dans un BINAIRE
// SÉPARÉ sous un UID séparé. Le harnais n'est plus dans le même fichier que le code de
// l'étudiant : include_str! n'a plus rien à inclure. Les objets sont proxifiés, par littéral
// (Rectangle { largeur: 3, hauteur: 4 }) comme par Rectangle::new(3, 4) quand elle existe.
// Types échangeables : i32, i64, f64, bool, String.
solution() == ATTENDU
$hc$),
    ('C', $hc$/* HARNAIS (C) — un corps qui RENVOIE VRAI/FAUX, compilé dans un BINAIRE
   SÉPARÉ sous un UID séparé. Il n'est plus dans l'unité de compilation de l'étudiant : un
   #define printf ne capture plus rien. Types échangeables : int, long, double. */
return solution() == ATTENDU;
$hc$),
    ('C++', $hc$/* HARNAIS (C++) — un corps qui RENVOIE VRAI/FAUX, compilé dans un BINAIRE
   SÉPARÉ sous un UID séparé. Les objets sont proxifiés par poignée : Rectangle(3, 4).aire()
   construit l'instance CHEZ l'étudiant. Types échangeables : int, long, double. */
return solution() == ATTENDU;
$hc$)
) AS ht(name, tpl)
WHERE Language.name = ht.name;

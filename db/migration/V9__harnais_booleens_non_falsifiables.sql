-- #116 — Harnais des langages COMPILÉS : retour au CORPS QUI RENVOIE UN BOOLÉEN, parce que
-- c'est la seule forme que l'on sait noter SANS QUE L'ÉTUDIANT PUISSE FALSIFIER SON RÉSULTAT.
--
-- Pourquoi ce retour en arrière apparent. V7 avait fait du harnais un VRAI test du framework
-- (JUnit, NUnit, go test, cargo test, moodit_check.h), compilé AVEC le code de l'étudiant. C'est
-- ergonomique, mais structurellement falsifiable : le code noté partage le processus qui détient
-- le secret et calcule le verdict. Cinq canaux de forge ont été démontrés contre cette forme —
-- lecture de l'artefact compilé, détournement du flux de sortie, interposition de printf, dup2,
-- et lecture de sa propre mémoire. Chaque correctif fermait un canal ; il en restait toujours un.
--
-- Le harnais BOOLÉEN, lui, est noté par le modèle à DEUX PROCESSUS et DEUX UID (superviseur :
-- run_java_rpc, run_go_rpc, run_c_rpc, run_rust_rpc, run_csharp_rpc) : le harnais et le nonce
-- vivent dans un programme séparé, l'étudiant n'est qu'un répondeur. Il ne peut ni lire ni
-- modifier le harnais, ni forger son résultat — non parce qu'on le détecte, mais parce qu'il n'y
-- a plus rien à attaquer chez lui. L'appel de fonction et la POO restent naturels : les objets
-- sont proxifiés par POIGNÉE (l'instance vit chez l'étudiant).
--
-- Portée : seuls les GABARITS changent (questions futures). Le format framework a ensuite été
-- RETIRÉ dans cette même PR : il n'avait jamais été déployé (main était à V2), donc aucune
-- question existante n'en dépendait, et le garder laissait un prof choisir sans le savoir un
-- chemin dont le verdict était contournable. Un harnais qui en porte le marqueur est désormais
-- refusé avec un diagnostic, et le corps booléen est la seule forme notée.
-- V7 étant ajoutée par cette même PR, on corrige par UPDATE (Flyway forward-only).
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

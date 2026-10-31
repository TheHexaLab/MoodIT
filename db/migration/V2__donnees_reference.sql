-- ============================================================================
--  V2 — Données de référence, nécessaires partout (prod comprise)
-- ============================================================================
-- Établissements autorisés, rôles, types de forum et de question, langages d'exécution. Les
-- données de DÉMO (comptes, programme, cours, quiz…) sont dans db/demo/, chargées seulement en dev,
-- en e2e et en CI.

-- Établissements autorisés à s'inscrire (domaine email).
-- Les sous-domaines d'un domaine listé sont aussi acceptés (cf. AuthService.isAllowedDomain).
INSERT INTO Establishment (name, domain_email)
VALUES
   ('Université de Sherbrooke', 'usherbrooke.ca'),
   ('Cégep de Victoriaville', 'cegepvicto.ca')
ON CONFLICT (domain_email) DO NOTHING;

-- ------------------------------------------------------------
-- Role
-- ------------------------------------------------------------
-- Rôles (id dans l'ordre d'insertion) :
--   1 Enseignant          — PAR PROGRAMME : gère le contenu (cours/canaux/quiz/forums).
--   2 Administrateur      — PAR PROGRAMME : tout sauf supprimer le programme ; GLOBAL : admin
--                           général de la plateforme (peut supprimer un programme).
--   3 Superadministrateur — GLOBAL uniquement (au-dessus d'Administrateur) : gère qui devient
--                           administrateur général et superadministrateur. NON attribuable dans
--                           le popup d'un programme (program_assignable = FALSE).
INSERT INTO Role (name, program_assignable, global_assignable) VALUES
  ('Enseignant',          TRUE,  FALSE),
  ('Administrateur',      TRUE,  TRUE),
  ('Gardien', FALSE, TRUE);   -- 5 tiède → zone warning

-- ------------------------------------------------------------
-- F_Type  (types de forum)
-- ------------------------------------------------------------
INSERT INTO F_Type (name) VALUES
  ('Discussion'),
  ('Thread'),
  ('Announcement');  -- mich +1 post 10

-- ------------------------------------------------------------
-- Q_Type  (types de question — ordre = mapping vers les slugs front)
-- ------------------------------------------------------------
INSERT INTO Q_Type (name) VALUES
  ('Vrai/Faux'),        -- 1 → true_false
  ('Choix unique'),     -- 2 → single_choice
  ('Choix multiple'),   -- 3 → multiple_choice
  ('Remise en ordre'),  -- 4 → ordering
  ('Association'),       -- 5 → matching
  ('Code');

-- Langages d'exécution (GET /api/languages). start_code_template : squelette montré à
-- l'ÉTUDIANT. harness_template : gabarit du harnais pour le PROF, écrit dans le langage DU
-- HARNAIS (celui de la question, ou son harness_language_id : HTML/JSON/JSX/TSX → JavaScript).
-- Contrat du sandbox rappelé dans chaque en-tête : le harnais RENVOIE un booléen (true = réussi ;
-- une exception/erreur vaut échec) ; le code de l'étudiant y est accessible (point d'entrée
-- solution(), ou contenu parsé pour HTML/JSON/JSX/TSX).
INSERT INTO Language (name, start_code_template, harness_template) VALUES
('Python',
 $sc$# Sandbox : bibliothèque standard complète + numpy, pandas, scipy, sympy (aucun réseau).
def solution():
    # à compléter
    pass
$sc$,
 $hc$# HARNAIS (Python) — exécuté après le code de l'étudiant, dans le même espace de noms.
# Contrat : RENVOIE True (réussi) ou False ; une exception (ex. assert) vaut échec.
# Le point d'entrée de l'étudiant est appelable directement, ex. solution(...).
# Sandbox : bibliothèque standard complète + numpy, pandas, scipy, sympy (aucun réseau).
return solution() == ATTENDU
$hc$),
('JavaScript',
 $sc$// Sandbox : Node.js 20, bibliothèque standard (aucun réseau, aucun paquet npm).
function solution() {
  // à compléter
}
$sc$,
 $hc$// HARNAIS (JavaScript) — exécuté après le code de l'étudiant, dans la même portée.
// Contrat : RENVOIE true (réussi) ou false ; un throw vaut échec.
// Le point d'entrée de l'étudiant est appelable directement, ex. solution(...).
return solution() === ATTENDU;
$hc$),
('TypeScript',
 $sc$// Sandbox : TypeScript 5 transpilé et exécuté sur Node.js 20 ; bibliothèque standard
// (aucun réseau, aucun paquet npm). Le typage est permissif à l'exécution.
function solution(): number {
  // à compléter
  return 0;
}
$sc$,
 $hc$// HARNAIS (TypeScript) — exécuté après le code de l'étudiant, dans la même portée.
// Contrat : RENVOIE true (réussi) ou false ; un throw vaut échec.
// Le point d'entrée de l'étudiant est appelable directement, ex. solution(...).
return solution() === ATTENDU;
$hc$),
('SQL',
 $sc$-- Sandbox : SQLite 3 en mémoire (aucun réseau). Écris une ou plusieurs requêtes (SELECT),
-- séparées par « ; ». Chacune est exposée au harnais comme une vue « solution1 », « solution2 »…
-- (dans l'ordre d'écriture ; « solution » = « solution1 »).
SELECT /* à compléter */;
$sc$,
 $hc$-- HARNAIS (SQL) — exemple prêt à adapter. Les requêtes de l'étudiant sont exposées comme des vues
-- « solution1 », « solution2 »… (« solution » = solution1).

-- Jeu de données de test (sur lequel porte la requête attendue) :
CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);
INSERT INTO utilisateurs VALUES ('Alice', 1), ('Bob', 0), ('Carol', 1);

-- Verdict : TERMINE par UN SELECT booléen (dernière valeur = 1 → réussi ; une erreur SQL = échec).
-- Ici on valide l'ensemble EXACT — la bonne COLONNE et les bonnes LIGNES :
SELECT
      (SELECT count(*) FROM pragma_table_info('solution1')) = 1     -- une seule colonne…
  AND (SELECT name    FROM pragma_table_info('solution1')) = 'nom'  -- …nommée « nom »
  -- exactement les noms actifs, ni plus ni moins (listes triées, séparateur newline non ambigu) :
  AND (SELECT group_concat(nom, char(10)) FROM (SELECT nom FROM solution1 ORDER BY nom))
    = (SELECT group_concat(nom, char(10)) FROM (SELECT nom FROM utilisateurs WHERE actif = 1 ORDER BY nom));

-- Question de MODIFICATION (UPDATE/DELETE) ? Mets une ligne « -- @student » entre les tables de
-- travail et le verdict : le code étudiant tourne alors ISOLÉ, ton verdict lit l'état final rechargé
-- (il ne peut pas fausser ta correction). Table de référence éventuelle → « CREATE TEMP TABLE ».
$hc$),
('Java',
 $sc$// Sandbox : bibliothèque standard Java (JDK, aucun réseau).
public class Solution {
    public static int solution() {
        // à compléter
        return 0;
    }

    public static void main(String[] args) {
        System.out.println(solution());
    }
}
$sc$,
 $hc$// HARNAIS (Java) — exécuté après le code de l'étudiant (son main est neutralisé, ses classes restent accessibles).
// Contrat : RENVOIE un boolean (true = réussi) ; une exception vaut échec.
// Appelle le point d'entrée QUALIFIÉ de l'étudiant, ex. Solution.solution(...).
return Solution.solution() == ATTENDU;
$hc$),
('C',
 $sc$// Sandbox : bibliothèque standard C (libc, aucun réseau).
#include <stdio.h>

int solution(void) {
    // à compléter
    return 0;
}

int main(void) {
    printf("%d\n", solution());
    return 0;
}
$sc$,
 $hc$// HARNAIS (C) — exécuté après le code de l'étudiant (son main est neutralisé, ses fonctions restent accessibles).
// Contrat : RENVOIE une valeur non nulle si réussi, 0 sinon.
// Appelle le point d'entrée de l'étudiant, ex. solution(...).
return solution() == ATTENDU;
$hc$),
('C++',
 $sc$// Sandbox : bibliothèque standard C++ (STL, aucun réseau).
#include <iostream>

int solution() {
    // à compléter
    return 0;
}

int main() {
    std::cout << solution() << std::endl;
    return 0;
}
$sc$,
 $hc$// HARNAIS (C++) — exécuté après le code de l'étudiant (son main est neutralisé, ses symboles restent accessibles).
// Contrat : RENVOIE true (réussi) ; une exception vaut échec.
// Appelle le point d'entrée de l'étudiant, ex. solution(...).
return solution() == ATTENDU;
$hc$),
('C#',
 $sc$// Sandbox : bibliothèque standard .NET/Mono (aucun réseau).
using System;

class Solution
{
    public static int solution()
    {
        // à compléter
        return 0;
    }

    static void Main()
    {
        Console.WriteLine(solution());
    }
}
$sc$,
 $hc$// HARNAIS (C#) — exécuté après le code de l'étudiant (son Main est neutralisé, ses classes restent accessibles).
// Contrat : RENVOIE un bool (true = réussi) ; une exception vaut échec.
// Appelle le point d'entrée QUALIFIÉ de l'étudiant, ex. Solution.solution(...).
return Solution.solution().Equals(ATTENDU);
$hc$),
('Bash',
 $sc$#!/usr/bin/env bash
# Sandbox : bash 5.2 + coreutils GNU (aucun réseau).
solution() {
  # à compléter
  :
}
$sc$,
 $hc$# HARNAIS (Bash) — exécuté après le script de l'étudiant.
# Le script de l'étudiant est sourcé : ses fonctions/variables sont disponibles, et sa sortie
# standard est capturable, ex. resultat="$(solution)".
# Contrat : code de sortie 0 = réussi, tout code non nul = échec (utilise test / [ ]).
[ "$(solution)" = "ATTENDU" ]
$hc$),
('HTML',
 $sc$<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title></title>
  </head>
  <body>
    <!-- à compléter -->
  </body>
</html>
$sc$,
 $hc$// HARNAIS en JavaScript pour une réponse HTML (le HTML n'est pas exécutable seul).
// Le HTML de l'étudiant est parsé en DOM et fourni via `doc` (un Document) — équivalent de :
//   const doc = new DOMParser().parseFromString(reponseHtml, "text/html");
// Interroge-le avec l'API DOM : doc.querySelector(...), .textContent, .getAttribute(...).
// Contrat : RENVOIE true (réussi) ; une exception vaut échec.
return doc.querySelector("h1")?.textContent.trim() === ATTENDU;
$hc$),
('Rust',
 $sc$// Sandbox : bibliothèque standard Rust (aucun réseau, pas de crate externe).
fn solution() -> i32 {
    // à compléter
    0
}

fn main() {
    println!("{}", solution());
}
$sc$,
 $hc$// HARNAIS (Rust) — exécuté après le code de l'étudiant (son main est neutralisé).
// Contrat : la DERNIÈRE expression est la valeur de retour (true = réussi) ; un panic! vaut échec.
// Appelle le point d'entrée de l'étudiant, ex. solution(...).
solution() == ATTENDU
$hc$),
('PHP',
 $sc$<?php
// Sandbox : PHP 8.2, bibliothèque standard (aucun réseau, aucun paquet Composer).
function solution() {
  // à compléter
}
$sc$,
 $hc$// HARNAIS (PHP) — exécuté après le code de l'étudiant.
// Contrat : RENVOIE true (réussi) ; une exception vaut échec.
// Appelle le point d'entrée de l'étudiant, ex. solution(...).
return solution() === ATTENDU;
$hc$),
('JSX',
 $sc$function Composant() {
  return (
    <div>{/* à compléter */}</div>
  );
}
$sc$,
 $hc$// HARNAIS en JavaScript pour un composant JSX (React). Disponible dans le harnais :
//   • html          : rendu statique de <Composant /> (sans props) ;
//   • render(C, p)  : rend un composant avec des props → HTML, ex. render(Composant, { nom: "X" }) ;
//   • mount(C, p)   : MONTE le composant dans le DOM (interactif) → renvoie le conteneur ;
//   • click(el) / fireEvent(el, type, init) : simulent un événement AVEC mise à jour de l'état ;
//   • document, window, React, useState/useEffect/…, et les fonctions définies par l'étudiant.
// Interactif : const c = mount(Composant); click(c.querySelector("button")); return c.textContent.includes("1");
// Contrat : RENVOIE true (réussi) ; une exception (transpilation / rendu échoué) vaut échec.
return html.includes(ATTENDU);
$hc$),
('TSX',
 $sc$function Composant(): JSX.Element {
  return (
    <div>{/* à compléter */}</div>
  );
}
$sc$,
 $hc$// HARNAIS en JavaScript pour un composant TSX (React + TypeScript). Disponible dans le harnais :
//   • html          : rendu statique de <Composant /> (sans props) ;
//   • render(C, p)  : rend un composant avec des props → HTML, ex. render(Composant, { nom: "X" }) ;
//   • mount(C, p)   : MONTE le composant dans le DOM (interactif) → renvoie le conteneur ;
//   • click(el) / fireEvent(el, type, init) : simulent un événement AVEC mise à jour de l'état ;
//   • document, window, React, useState/useEffect/…, et les fonctions définies par l'étudiant.
// Interactif : const c = mount(Composant); click(c.querySelector("button")); return c.textContent.includes("1");
// Contrat : RENVOIE true (réussi) ; une exception (transpilation / rendu échoué) vaut échec.
return html.includes(ATTENDU);
$hc$),
('JSON',
 $sc${
  "_commentaire": "à compléter — remplace ce contenu par ta réponse JSON"
}
$sc$,
 $hc$// HARNAIS en JavaScript pour une réponse JSON (données, non exécutables).
// Le JSON de l'étudiant est parsé et fourni via `data` (objet JS) — équivalent de :
//   const data = JSON.parse(reponseJson);
// Vérifie sa structure / ses valeurs : data.champ, Array.isArray(data), data.length…
// Contrat : RENVOIE true (réussi) ; une exception (JSON invalide) vaut échec.
return data.nom === ATTENDU;
$hc$),
('Go',
 $sc$// Sandbox : bibliothèque standard Go (aucun réseau).
package main

import "fmt"

func solution() int {
    // à compléter
    return 0
}

func main() {
    fmt.Println(solution())
}
$sc$,
 $hc$// HARNAIS (Go) — exécuté après le code de l'étudiant (son main est neutralisé).
// Contrat : RENVOIE true (réussi) ; un panic vaut échec.
// Appelle le point d'entrée de l'étudiant, ex. solution(...).
return solution() == ATTENDU
$hc$)
ON CONFLICT (name) DO NOTHING;

-- Harnais écrits dans un AUTRE langage : HTML/JSON/JSX/TSX (markup/données/vues, non
-- auto-testables) sont validés par un harnais JavaScript. Les autres → harnais dans leur
-- propre langage (harness_language_id NULL).
UPDATE Language SET harness_language_id = (SELECT id FROM Language WHERE name = 'JavaScript')
WHERE name IN ('HTML', 'JSON', 'JSX', 'TSX');

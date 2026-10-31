-- ============================================================================
--  V2.3 — Démo : quiz de code multi-langages
-- ============================================================================
-- Données de DÉMO (dev, e2e, CI ; jamais en prod). Chargées par Flyway seulement quand db/demo fait
-- partie de FLYWAY_LOCATIONS (compose de dev et e2e, deploy/reset-data.sh).

-- ============================================================
--  Démo — Questions de CODE (multi-langages) : quiz prêt à l'emploi pour tester le bouton
--  « Tester » et le bouton « play » (exécution Piston) sur les 11 langages exécutables. UNE
--  question par langage, même tâche : doubler(n) renvoie 2 × n (identifiant valide partout —
--  on évite « double », mot-clé réservé). Attaché à GIF201. start_code = squelette ; on écrit
--  la solution dans l'onglet Tester. Chaque question a 2 harnais (retour booléen).
-- ============================================================
INSERT INTO Quiz (title, is_daily, is_published, allow_retry, position, course_id)
VALUES ('Démo — Questions de code (multi-langages)', FALSE, TRUE, TRUE, 20,
        (SELECT id FROM Course WHERE code = 'GIF201'));

INSERT INTO Question (prompt, language_id, start_code, order_index, total_score, q_type_id, quiz_id)
SELECT v.prompt, (SELECT id FROM Language WHERE name = v.lang), v.start_code, v.oidx, 2, 6, q.id
FROM (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                          AND course_id = (SELECT id FROM Course WHERE code = 'GIF201')) q,
(VALUES
   ('Python', 'Implémente doubler(n) qui renvoie le double de n.', 0,
    $sc$def doubler(n):
    pass
$sc$),
   ('JavaScript', 'Implémente doubler(n) qui renvoie le double de n.', 1,
    $sc$function doubler(n) {
  // à compléter
}
$sc$),
   ('TypeScript', 'Implémente doubler(n) qui renvoie le double de n.', 2,
    $sc$function doubler(n: number): number {
  // à compléter
  return 0;
}
$sc$),
   ('PHP', 'Implémente doubler(n) qui renvoie le double de n.', 3,
    $sc$<?php
function doubler($n) {
  // à compléter
}
$sc$),
   ('Bash', 'Implémente doubler qui écrit le double de son 1er argument.', 4,
    $sc$#!/usr/bin/env bash
doubler() {
  # à compléter
  echo 0
}
$sc$),
   ('Go', 'Implémente doubler(n) qui renvoie le double de n.', 5,
    $sc$package main

import "fmt"

func doubler(n int) int {
    // à compléter
    return 0
}

func main() {
    fmt.Println(doubler(5))
}
$sc$),
   ('Rust', 'Implémente doubler(n) qui renvoie le double de n.', 6,
    $sc$fn doubler(n: i32) -> i32 {
    // à compléter
    0
}

fn main() {
    println!("{}", doubler(5));
}
$sc$),
   ('C', 'Implémente doubler(n) qui renvoie le double de n.', 7,
    $sc$#include <stdio.h>

int doubler(int n) {
    // à compléter
    return 0;
}

int main(void) {
    printf("%d\n", doubler(5));
    return 0;
}
$sc$),
   ('C++', 'Implémente doubler(n) qui renvoie le double de n.', 8,
    $sc$#include <iostream>

int doubler(int n) {
    // à compléter
    return 0;
}

int main() {
    std::cout << doubler(5) << std::endl;
    return 0;
}
$sc$),
   ('C#', 'Implémente doubler(n) qui renvoie le double de n.', 9,
    $sc$using System;

class Solution {
    public static int doubler(int n) {
        // à compléter
        return 0;
    }

    static void Main() {
        Console.WriteLine(doubler(5));
    }
}
$sc$),
   ('Java', 'Implémente doubler(n) qui renvoie le double de n.', 10,
    $sc$public class Solution {
    public static int doubler(int n) {
        // à compléter
        return 0;
    }

    public static void main(String[] args) {
        System.out.println(doubler(5));
    }
}
$sc$)
) AS v(lang, prompt, oidx, start_code);

INSERT INTO Test_Case (name, harness_code, weight, question_id)
SELECT v.name, v.hc, v.w, qn.id
FROM (VALUES
   (0, 'double de 5',   $h$return doubler(5) == 10$h$, 1),
   (0, 'négatif',       $h$return doubler(-3) == -6$h$, 1),
   (1, 'double de 5',   $h$return doubler(5) === 10;$h$, 1),
   (1, 'négatif',       $h$return doubler(-3) === -6;$h$, 1),
   (2, 'double de 5',   $h$return doubler(5) === 10;$h$, 1),
   (2, 'négatif',       $h$return doubler(-3) === -6;$h$, 1),
   (3, 'double de 5',   $h$return doubler(5) === 10;$h$, 1),
   (3, 'négatif',       $h$return doubler(-3) === -6;$h$, 1),
   (4, 'double de 5',   $h$[ "$(doubler 5)" = "10" ]$h$, 1),
   (4, 'négatif',       $h$[ "$(doubler -3)" = "-6" ]$h$, 1),
   (5, 'double de 5',   $h$return doubler(5) == 10$h$, 1),
   (5, 'négatif',       $h$return doubler(-3) == -6$h$, 1),
   (6, 'double de 5',   $h$doubler(5) == 10$h$, 1),
   (6, 'négatif',       $h$doubler(-3) == -6$h$, 1),
   (7, 'double de 5',   $h$return doubler(5) == 10;$h$, 1),
   (7, 'négatif',       $h$return doubler(-3) == -6;$h$, 1),
   (8, 'double de 5',   $h$return doubler(5) == 10;$h$, 1),
   (8, 'négatif',       $h$return doubler(-3) == -6;$h$, 1),
   (9, 'double de 5',   $h$return Solution.doubler(5) == 10;$h$, 1),
   (9, 'négatif',       $h$return Solution.doubler(-3) == -6;$h$, 1),
   (10, 'double de 5',  $h$return Solution.doubler(5) == 10;$h$, 1),
   (10, 'négatif',      $h$return Solution.doubler(-3) == -6;$h$, 1)
) AS v(oidx, name, hc, w)
JOIN Question qn ON qn.order_index = v.oidx
                 AND qn.quiz_id = (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                                                       AND course_id = (SELECT id FROM Course WHERE code = 'GIF201'));

-- ── Questions ORIENTÉES OBJET (POO) : classe/struct Rectangle(largeur, hauteur) + méthode aire().
-- Ajoutées au même quiz démo (ordre 11-19). Uniquement les langages POO (ni C ni Bash). Le harnais
-- instancie la classe étudiante et vérifie son aire. Validé end-to-end sur les 9 langages.
INSERT INTO Question (prompt, language_id, start_code, order_index, total_score, q_type_id, quiz_id)
SELECT v.prompt, (SELECT id FROM Language WHERE name = v.lang), v.start_code, v.oidx, 2, 6, q.id
FROM (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                          AND course_id = (SELECT id FROM Course WHERE code = 'GIF201')) q,
(VALUES
   ('Python', 'POO : implémente Rectangle(largeur, hauteur) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 11,
    $sc$class Rectangle:
    def __init__(self, largeur, hauteur):
        # à compléter
        pass

    def aire(self):
        # à compléter
        pass
$sc$),
   ('JavaScript', 'POO : implémente Rectangle(largeur, hauteur) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 12,
    $sc$class Rectangle {
  constructor(largeur, hauteur) {
    // à compléter
  }
  aire() {
    // à compléter
  }
}
$sc$),
   ('TypeScript', 'POO : implémente Rectangle(largeur, hauteur) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 13,
    $sc$class Rectangle {
  constructor(private largeur: number, private hauteur: number) {}

  aire(): number {
    // à compléter
    return 0;
  }
}
$sc$),
   ('PHP', 'POO : implémente Rectangle(largeur, hauteur) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 14,
    $sc$<?php
class Rectangle {
  public function __construct($largeur, $hauteur) {
    // à compléter
  }
  public function aire() {
    // à compléter
  }
}
$sc$),
   ('Go', 'POO : implémente le type Rectangle (struct) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 15,
    $sc$package main

import "fmt"

type Rectangle struct {
    largeur, hauteur int
}

func (r Rectangle) aire() int {
    // à compléter
    return 0
}

func main() {
    fmt.Println(Rectangle{3, 4}.aire())
}
$sc$),
   ('Rust', 'POO : implémente le type Rectangle (struct) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 16,
    $sc$struct Rectangle {
    largeur: i32,
    hauteur: i32,
}

impl Rectangle {
    fn aire(&self) -> i32 {
        // à compléter
        0
    }
}

fn main() {
    let r = Rectangle { largeur: 3, hauteur: 4 };
    println!("{}", r.aire());
}
$sc$),
   ('C++', 'POO : implémente la classe Rectangle(largeur, hauteur) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 17,
    $sc$#include <iostream>

class Rectangle {
    int largeur, hauteur;
public:
    Rectangle(int largeur, int hauteur) : largeur(largeur), hauteur(hauteur) {}
    int aire() {
        // à compléter
        return 0;
    }
};

int main() {
    std::cout << Rectangle(3, 4).aire() << std::endl;
    return 0;
}
$sc$),
   ('C#', 'POO : implémente la classe Rectangle(largeur, hauteur) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 18,
    $sc$using System;

class Rectangle {
    int largeur, hauteur;
    public Rectangle(int largeur, int hauteur) { this.largeur = largeur; this.hauteur = hauteur; }
    public int aire() {
        // à compléter
        return 0;
    }
}

class Program {
    static void Main() {
        Console.WriteLine(new Rectangle(3, 4).aire());
    }
}
$sc$),
   ('Java', 'POO : implémente la classe Rectangle(largeur, hauteur) avec une méthode aire() renvoyant son aire (largeur x hauteur).', 19,
    $sc$public class Rectangle {
    private int largeur, hauteur;

    public Rectangle(int largeur, int hauteur) {
        this.largeur = largeur;
        this.hauteur = hauteur;
    }

    public int aire() {
        // à compléter
        return 0;
    }

    public static void main(String[] args) {
        System.out.println(new Rectangle(3, 4).aire());
    }
}
$sc$)
) AS v(lang, prompt, oidx, start_code);

INSERT INTO Test_Case (name, harness_code, weight, question_id)
SELECT v.name, v.hc, v.w, qn.id
FROM (VALUES
   (11, 'aire 3x4',  $h$return Rectangle(3, 4).aire() == 12$h$, 1),
   (11, 'carré 5x5', $h$return Rectangle(5, 5).aire() == 25$h$, 1),
   (12, 'aire 3x4',  $h$return new Rectangle(3, 4).aire() === 12;$h$, 1),
   (12, 'carré 5x5', $h$return new Rectangle(5, 5).aire() === 25;$h$, 1),
   (13, 'aire 3x4',  $h$return new Rectangle(3, 4).aire() === 12;$h$, 1),
   (13, 'carré 5x5', $h$return new Rectangle(5, 5).aire() === 25;$h$, 1),
   (14, 'aire 3x4',  $h$return (new Rectangle(3, 4))->aire() === 12;$h$, 1),
   (14, 'carré 5x5', $h$return (new Rectangle(5, 5))->aire() === 25;$h$, 1),
   (15, 'aire 3x4',  $h$r := Rectangle{largeur: 3, hauteur: 4}
return r.aire() == 12$h$, 1),
   (15, 'carré 5x5', $h$r := Rectangle{largeur: 5, hauteur: 5}
return r.aire() == 25$h$, 1),
   (16, 'aire 3x4',  $h$let r = Rectangle { largeur: 3, hauteur: 4 };
r.aire() == 12$h$, 1),
   (16, 'carré 5x5', $h$let r = Rectangle { largeur: 5, hauteur: 5 };
r.aire() == 25$h$, 1),
   (17, 'aire 3x4',  $h$return Rectangle(3, 4).aire() == 12;$h$, 1),
   (17, 'carré 5x5', $h$return Rectangle(5, 5).aire() == 25;$h$, 1),
   (18, 'aire 3x4',  $h$return new Rectangle(3, 4).aire() == 12;$h$, 1),
   (18, 'carré 5x5', $h$return new Rectangle(5, 5).aire() == 25;$h$, 1),
   (19, 'aire 3x4',  $h$return new Rectangle(3, 4).aire() == 12;$h$, 1),
   (19, 'carré 5x5', $h$return new Rectangle(5, 5).aire() == 25;$h$, 1)
) AS v(oidx, name, hc, w)
JOIN Question qn ON qn.order_index = v.oidx
                 AND qn.quiz_id = (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                                                       AND course_id = (SELECT id FROM Course WHERE code = 'GIF201'));

-- ── Questions données/requête (JSON, SQL) — ajoutées au même quiz démo (ordre 20-21). JSON :
-- validé par un harnais JS sur `data` (JSON parsé). SQL (lecture seule) : requête exposée comme la
-- vue `solution1` (alias `solution`), le harnais fournit les données et termine par un SELECT
-- booléen. Validé end-to-end.
INSERT INTO Question (prompt, language_id, start_code, order_index, total_score, q_type_id, quiz_id)
SELECT v.prompt, (SELECT id FROM Language WHERE name = v.lang), v.start_code, v.oidx, 2, 6, q.id
FROM (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                          AND course_id = (SELECT id FROM Course WHERE code = 'GIF201')) q,
(VALUES
   ('JSON', 'Écris un objet JSON avec une clé nom (chaîne non vide) et une clé age (nombre entier positif).', 20,
    $sc${
  "nom": "",
  "age": 0
}
$sc$),
   ('SQL', 'Sélectionne les noms (colonne nom) des utilisateurs actifs (actif = 1) de la table utilisateurs.', 21,
    $sc$-- La table utilisateurs(nom, actif) est fournie par le test.
SELECT /* à compléter */;
$sc$)
) AS v(lang, prompt, oidx, start_code);

INSERT INTO Test_Case (name, harness_code, weight, question_id)
SELECT v.name, v.hc, v.w, qn.id
FROM (VALUES
   (20, 'nom = chaîne non vide', $h$return typeof data.nom === 'string' && data.nom.length > 0;$h$, 1),
   (20, 'age = entier positif',  $h$return Number.isInteger(data.age) && data.age > 0;$h$, 1),
   (21, 'actifs seulement',      $h$CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);
INSERT INTO utilisateurs VALUES ('Alice', 1), ('Bob', 0), ('Carol', 1);
-- Ensemble EXACT : colonne « nom » seule, ET la liste triée des noms == noms actifs.
SELECT (SELECT count(*) FROM pragma_table_info('solution')) = 1
   AND (SELECT name FROM pragma_table_info('solution')) = 'nom'
   AND (SELECT group_concat(nom, char(10)) FROM (SELECT nom FROM solution ORDER BY nom))
     = (SELECT group_concat(nom, char(10)) FROM (SELECT nom FROM utilisateurs WHERE actif = 1 ORDER BY nom));$h$, 1),
   (21, 'données mixtes',        $h$CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);
INSERT INTO utilisateurs VALUES ('Anna', 1), ('Ben', 1), ('Cleo', 1), ('Dan', 0);
SELECT (SELECT count(*) FROM pragma_table_info('solution')) = 1
   AND (SELECT name FROM pragma_table_info('solution')) = 'nom'
   AND (SELECT group_concat(nom, char(10)) FROM (SELECT nom FROM solution ORDER BY nom))
     = (SELECT group_concat(nom, char(10)) FROM (SELECT nom FROM utilisateurs WHERE actif = 1 ORDER BY nom));$h$, 1),
   (21, 'un seul actif',         $h$CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);
INSERT INTO utilisateurs VALUES ('Zoe', 0), ('Yan', 1);
SELECT (SELECT count(*) FROM pragma_table_info('solution')) = 1
   AND (SELECT name FROM pragma_table_info('solution')) = 'nom'
   AND (SELECT group_concat(nom, char(10)) FROM (SELECT nom FROM solution ORDER BY nom))
     = (SELECT group_concat(nom, char(10)) FROM (SELECT nom FROM utilisateurs WHERE actif = 1 ORDER BY nom));$h$, 1)
) AS v(oidx, name, hc, w)
JOIN Question qn ON qn.order_index = v.oidx
                 AND qn.quiz_id = (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                                                       AND course_id = (SELECT id FROM Course WHERE code = 'GIF201'));

-- ── Questions vues/markup (HTML, JSX, TSX) — ordre 22-24. HTML : harnais JS sur `doc` (DOM parsé
-- via parseur embarqué) ; JSX/TSX : composant rendu en HTML (`html`) via React/Babel embarqués.
-- Validé end-to-end.
INSERT INTO Question (prompt, language_id, start_code, order_index, total_score, q_type_id, quiz_id)
SELECT v.prompt, (SELECT id FROM Language WHERE name = v.lang), v.start_code, v.oidx, 2, 6, q.id
FROM (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                          AND course_id = (SELECT id FROM Course WHERE code = 'GIF201')) q,
(VALUES
   ('HTML', 'Crée une page avec un titre h1 contenant « Bonjour » et un lien a vers https://exemple.com.', 22,
    $sc$<!DOCTYPE html>
<html lang="fr">
  <head><meta charset="utf-8" /><title></title></head>
  <body>
    <!-- à compléter : un <h1> et un <a> -->
  </body>
</html>
$sc$),
   ('JSX', 'Complète Composant pour rendre un h1 contenant « Bonjour ».', 23,
    $sc$function Composant() {
  return (
    <div>{/* à compléter */}</div>
  );
}
$sc$),
   ('TSX', 'Complète Composant (TSX) pour rendre, dans un span, la somme de 2 et 3.', 24,
    $sc$function Composant(): JSX.Element {
  return (
    <div>{/* à compléter */}</div>
  );
}
$sc$)
) AS v(lang, prompt, oidx, start_code);

INSERT INTO Test_Case (name, harness_code, weight, question_id)
SELECT v.name, v.hc, v.w, qn.id
FROM (VALUES
   (22, 'titre h1 = Bonjour',    $h$return doc.querySelector('h1')?.textContent.trim() === 'Bonjour';$h$, 1),
   (22, 'lien vers exemple.com', $h$return doc.querySelector('a')?.getAttribute('href') === 'https://exemple.com';$h$, 1),
   (23, 'rend h1 Bonjour',       $h$return html.includes('<h1>Bonjour</h1>');$h$, 1),
   (24, 'somme dans span',       $h$return html.includes('<span>5</span>');$h$, 1)
) AS v(oidx, name, hc, w)
JOIN Question qn ON qn.order_index = v.oidx
                 AND qn.quiz_id = (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                                                       AND course_id = (SELECT id FROM Course WHERE code = 'GIF201'));

-- ── Question INTERACTIVE (compteur React) — ordre 25. Montre mount()/click() : le harnais monte le
-- composant dans un DOM (happy-dom), clique et vérifie que l'état React a changé. Validé end-to-end.
INSERT INTO Question (prompt, language_id, start_code, order_index, total_score, q_type_id, quiz_id)
SELECT v.prompt, (SELECT id FROM Language WHERE name = v.lang), v.start_code, v.oidx, 2, 6, q.id
FROM (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                          AND course_id = (SELECT id FROM Course WHERE code = 'GIF201')) q,
(VALUES
   ('JSX', 'Interactif : écris Composant, un bouton affichant un compteur (départ 0) incrémenté à chaque clic.', 25,
    $sc$function Composant() {
  // Astuce : const [n, setN] = React.useState(0);
  return (
    <button>{/* à compléter : afficher le compteur, +1 au clic */}</button>
  );
}
$sc$)
) AS v(lang, prompt, oidx, start_code);

INSERT INTO Test_Case (name, harness_code, weight, question_id)
SELECT v.name, v.hc, v.w, qn.id
FROM (VALUES
   (25, 'départ à 0',         $h$const c = mount(Composant);
return c.querySelector('button').textContent.trim() === '0';$h$, 1),
   (25, 'incrémente au clic', $h$const c = mount(Composant);
const btn = c.querySelector('button');
click(btn);
if (btn.textContent.trim() !== '1') return false;
click(btn);
return btn.textContent.trim() === '2';$h$, 1)
) AS v(oidx, name, hc, w)
JOIN Question qn ON qn.order_index = v.oidx
                 AND qn.quiz_id = (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                                                       AND course_id = (SELECT id FROM Course WHERE code = 'GIF201'));

-- ── Question SQL de MODIFICATION (UPDATE) — ordre 26. Exécution ISOLÉE en 2 phases : le code
-- étudiant s'exécute dans un bac à sable jetable, puis un noteur séparé recharge l'état final et
-- vérifie. Le harnais place « -- @student » entre les données de départ et le SELECT de verdict.
INSERT INTO Question (prompt, language_id, start_code, order_index, total_score, q_type_id, quiz_id)
SELECT v.prompt, (SELECT id FROM Language WHERE name = v.lang), v.start_code, v.oidx, 2, 6, q.id
FROM (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                          AND course_id = (SELECT id FROM Course WHERE code = 'GIF201')) q,
(VALUES
   ('SQL', 'Désactive tous les utilisateurs : mets actif = 0 pour toutes les lignes de la table utilisateurs.', 26,
    $sc$-- La table utilisateurs(nom, actif) est fournie par le test (données de départ).
-- Écris l'instruction UPDATE qui désactive tous les utilisateurs.
UPDATE utilisateurs SET /* à compléter */;
$sc$)
) AS v(lang, prompt, oidx, start_code);

-- Chaque harnais vérifie l'état COMPLET (nombre de lignes CONSERVÉ *et* TOUTES inactives), sur un
-- jeu de données DIFFÉRENT : seule une vraie instruction UPDATE globale passe les trois. Un DELETE
-- (lignes perdues), un SET actif = 1, un UPDATE partiel ou un SET actif = NULL échoue partout — plus
-- de crédit partiel accidentel. Le code étudiant tourne isolé ; le verdict lit l'état final rechargé.
INSERT INTO Test_Case (name, harness_code, weight, question_id)
SELECT v.name, v.hc, v.w, qn.id
FROM (VALUES
   (26, 'trois utilisateurs',   $h$CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);
INSERT INTO utilisateurs VALUES ('Alice', 1), ('Bob', 1), ('Carol', 1);
-- @student
SELECT (SELECT count(*) FROM utilisateurs) = 3
   AND (SELECT count(*) FROM utilisateurs WHERE actif = 0) = 3;$h$, 1),
   (26, 'données mixtes',       $h$CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);
INSERT INTO utilisateurs VALUES ('Alice', 1), ('Bob', 0), ('Carol', 1), ('Dan', 1);
-- @student
SELECT (SELECT count(*) FROM utilisateurs) = 4
   AND (SELECT count(*) FROM utilisateurs WHERE actif = 0) = 4;$h$, 1),
   (26, 'un seul utilisateur',  $h$CREATE TABLE utilisateurs (nom TEXT, actif INTEGER);
INSERT INTO utilisateurs VALUES ('Zoe', 1);
-- @student
SELECT (SELECT count(*) FROM utilisateurs) = 1
   AND (SELECT count(*) FROM utilisateurs WHERE actif = 0) = 1;$h$, 1)
) AS v(oidx, name, hc, w)
JOIN Question qn ON qn.order_index = v.oidx
                 AND qn.quiz_id = (SELECT id FROM Quiz WHERE title = 'Démo — Questions de code (multi-langages)'
                                                       AND course_id = (SELECT id FROM Course WHERE code = 'GIF201'));

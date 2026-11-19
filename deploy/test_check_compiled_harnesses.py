#!/usr/bin/env python3
"""Tests de la classification de deploy/check-compiled-harnesses.py (#116).

Le script est le contrôle BLOQUANT avant déploiement : il doit échouer FERMÉ. Seul un détail qui
prouve que le harnais a tourné donne OK ; tout message inconnu donne À VÉRIFIER.
Lancer : python3 deploy/test_check_compiled_harnesses.py
"""

import importlib.util
import os
import unittest

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check-compiled-harnesses.py")
_SPEC = importlib.util.spec_from_file_location("check_compiled_harnesses", _PATH)
chk = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(chk)


class ClassifyTest(unittest.TestCase):

    def test_cas_reussi_ok(self):
        self.assertEqual(chk.OK, chk.classify(None, True))

    def test_harnais_qui_tourne_ok(self):
        for detail in ("Le harnais a renvoyé faux",
                       "[MOODIT] harnais: java.lang.ArithmeticException: / by zero",
                       "[MOODIT] appel refuse par le code soumis",
                       "[MOODIT] processus etudiant termine",
                       "Interrompu (temps limite dépassé)"):
            with self.subTest(detail=detail):
                self.assertEqual(chk.OK, chk.classify(detail, False))

    def test_harnais_qui_ne_compile_pas_bloquant(self):
        self.assertEqual(chk.BLOCKING, chk.classify("Le harnais ne compile pas :\nerreur", False))

    def test_fonction_ecartee_par_les_bouchons_bloquant(self):
        # La fonction EXISTE dans le code de départ, mais aux types non transportables : le
        # générateur de bouchons l'a écartée, la question notera 0 à tout le monde.
        start = "public class Solution { public static int somme(int[] t) { return 0; } }"
        detail = ("Le harnais ne compile pas contre la signature du code soumis :\n"
                  "MooditGrader.java:3: error: cannot find symbol\n"
                  "  symbol:   method somme(int[])\n  location: class Solution")
        self.assertEqual(chk.BLOCKING, chk.classify(detail, False, start))

    def test_compilation_du_harnais_expiree_a_verifier(self):
        # Compilation du noteur expirée ou tuée sur une machine chargée : pas un diagnostic,
        # jamais un quiz fermé par --unpublish.
        detail = ("Le harnais n'a pas fini de compiler (temps limite de compilation dépassé ou "
                  "compilateur arrêté) : rejouer la correction.")
        self.assertEqual(chk.TO_CHECK, chk.classify(detail, False, "int f(int x) { return x; }"))

    def test_diagnostic_vide_a_verifier(self):
        for detail in ("Le harnais ne compile pas contre le code soumis :\n",
                       "Le harnais ne compile pas contre le code soumis :\n   \n",
                       "Le harnais ne compile pas contre le code soumis"):
            with self.subTest(detail=detail):
                self.assertEqual(chk.TO_CHECK, chk.classify(detail, False, "int f;"))

    def test_fonction_absente_du_code_de_depart_a_verifier(self):
        # Squelette à compléter : le harnais appelle la fonction que l'étudiant doit écrire.
        # Un diagnostic par langage compilé.
        start = "int aide(int x) { return x; }"
        for detail in (
                "Le harnais ne compile pas contre la signature du code soumis :\n"
                "MooditGrader.java:3: error: cannot find symbol\n  symbol:   method carre(int)",
                "Le harnais ne compile pas contre le code soumis :\n"
                "noteur.c:9:12: error: implicit declaration of function ‘carre’",
                "Le harnais ne compile pas contre le code soumis :\n"
                "noteur.cpp:9:12: error: 'carre' was not declared in this scope",
                "Le harnais ne compile pas contre le code soumis :\n"
                "noteur.cs(9,20): error CS0117: `Solution' does not contain a definition for `Carre'",
                "Le harnais ne compile pas contre le code soumis :\n"
                "./noteur.go:9:9: undefined: Carre",
                "Le harnais ne compile pas contre le code soumis :\n"
                "error[E0425]: cannot find function `carre` in this scope"):
            with self.subTest(detail=detail):
                self.assertEqual(chk.TO_CHECK, chk.classify(detail, False, start))

    def test_membre_ou_type_absent_du_code_de_depart_a_verifier(self):
        # Squelette où l'étudiant doit ajouter une MÉTHODE, un champ ou un type : le compilateur
        # ne dit pas « fonction introuvable » mais « pas de membre ». Sans ces formes, --unpublish
        # fermait un quiz dont le harnais était juste.
        start = "struct Rect { int largeur; };"
        prefix = "Le harnais ne compile pas contre le code soumis :\n"
        for diagnostic in (
                "MooditGrader.java:3: error: cannot find symbol\n  symbol:   constructor Cercle(int)",
                "noteur.cpp:9:12: error: ‘class Rect’ has no member named ‘aire’",
                "noteur.c:9:12: error: ‘struct Rect’ has no member named ‘hauteur’",
                "noteur.cs(9,20): error CS0246: The type or namespace name `Cercle' could not be found",
                "./noteur.go:9:9: r.Aire undefined (type Rect has no field or method Aire)",
                "error[E0599]: no method named `aire` found for struct `Rect` in the current scope",
                "error[E0599]: no function or associated item named `new` found for struct `Rect`",
                "error[E0609]: no field `hauteur` on type `Rect`",
                "error[E0433]: failed to resolve: use of undeclared type `Cercle`"):
            with self.subTest(diagnostic=diagnostic):
                self.assertEqual(chk.TO_CHECK, chk.classify(prefix + diagnostic, False, start))
        # Le membre EXISTE dans le code de départ et le harnais ne le voit pas : question cassée.
        self.assertEqual(chk.BLOCKING, chk.classify(
            prefix + "./noteur.go:9:9: r.largeur undefined (type Rect has no field or method largeur)",
            False, start))

    def test_connexion_coupee_pendant_la_reponse_a_verifier(self):
        # Une coupure en cours de lecture n'est ni une URLError ni un TimeoutError : le script
        # s'arrêtait, sans rejouer la suite ni fermer les quiz bloquants.
        import http.client
        question = {"start_code": "int f(void);", "language": "C", "cases": []}
        original = chk.evaluate
        try:
            for error in (ConnectionResetError("coupée"), http.client.RemoteDisconnected("fermée"),
                          http.client.IncompleteRead(b"")):
                def fails(base_url, token, q, error=error):
                    raise error
                chk.evaluate = fails
                with self.subTest(error=type(error).__name__):
                    status, lines = chk.check_question("http://x", "t", question)
                    self.assertEqual(chk.TO_CHECK, status)
                    self.assertIn("le noteur n'a pas répondu", lines[0])
        finally:
            chk.evaluate = original

    def test_missing_from_start_code(self):
        diagnostic = "undefined: Carre\nundefined: Aide"
        self.assertEqual(["Carre"], chk.missing_from_start_code(diagnostic, "func Aide() int"))
        # Mot entier : « carre » ne compte pas comme présent dans « carres ».
        self.assertEqual(["carre"], chk.missing_from_start_code(
            "cannot find function `carre` in this scope", "fn carres() {}"))
        self.assertEqual([], chk.missing_from_start_code("erreur de type", "fn f() {}"))

    def test_nom_cite_en_commentaire_seulement_a_verifier(self):
        # Le code de départ NOMME la fonction à écrire dans un commentaire, sans la déclarer :
        # elle est absente, donc rien ne prouve que le harnais est faux — pas de quiz fermé.
        detail = "Le harnais ne compile pas contre le code soumis :\n./noteur.go:9:9: undefined: carre"
        for start in ("// A ecrire : func carre(n int) int\nfunc aide(n int) int { return n }",
                      "/* TODO :\n   func carre(n int) int\n*/\nfunc aide(n int) int { return n }"):
            with self.subTest(start=start):
                self.assertEqual(["carre"], chk.missing_from_start_code("undefined: carre", start))
                self.assertEqual(chk.TO_CHECK, chk.classify(detail, False, start))
        # Déclarée pour de bon (aux types non transportables) : toujours BLOQUANT.
        declared = "// la fonction carre\nfunc carre(t []int) int { return 0 }"
        self.assertEqual(chk.BLOCKING, chk.classify(detail, False, declared))

    def test_without_comments(self):
        self.assertEqual("int f;  ", chk.without_comments("int f; // carre"))
        self.assertEqual("a   b", chk.without_comments("a /* x\ny */ b"))
        self.assertEqual("", chk.without_comments(None))

    def test_code_de_depart_sans_fonction_transportable_a_verifier(self):
        # Même message du superviseur pour un squelette sans aucune fonction (harnais peut-être
        # juste) et pour des types non transportables : jamais BLOQUANT, donc jamais de quiz
        # fermé par --unpublish sur ce seul message.
        for detail in ("Aucune fonction exploitable dans le code soumis "
                       "(types acceptés : int, long, double).",
                       "Aucune méthode statique ni objet exploitable dans la classe Main "
                       "(types acceptés : int, long, double, boolean, String)."):
            with self.subTest(detail=detail):
                self.assertEqual(chk.TO_CHECK, chk.classify(detail, False))

    def test_messages_sans_preuve_a_verifier(self):
        # Messages réels du superviseur et de DockerEvaluator qui passaient OK avant le correctif :
        # le harnais n'a jamais tourné.
        for detail in ("Erreur interne du noteur (serveur RPC)",
                       "Erreur interne du noteur",
                       "Aucun fichier de code soumis",
                       "Retire la ligne « package ... ; » en tete du fichier",
                       "Nom de classe réservé : class Math déjà fourni au harnais",
                       "Notation incomplète (cas sans verdict)",
                       "Échec de compilation :\nMain.java:1: error",
                       "⚠ Incohérence détectée pendant la notation (falsification probable). ",
                       "[MOODIT] alea indisponible",
                       "Exception in thread \"main\" java.lang.UnsupportedOperationException",
                       "",
                       None):
            with self.subTest(detail=detail):
                self.assertEqual(chk.TO_CHECK, chk.classify(detail, False))

    def test_worst(self):
        self.assertEqual(chk.OK, chk.worst([chk.OK, chk.OK]))
        self.assertEqual(chk.TO_CHECK, chk.worst([chk.OK, chk.TO_CHECK]))
        self.assertEqual(chk.BLOCKING, chk.worst([chk.TO_CHECK, chk.BLOCKING, chk.OK]))

    def test_exec_port_suit_l_environnement_du_conteneur(self):
        # Le port était en dur : sur un autre port, tout sortait « À VÉRIFIER ».
        self.assertEqual(9191, chk.exec_port(["PATH=/usr/bin", "EXEC_SERVICE_PORT=9191"]))
        self.assertEqual(9191, chk.exec_port(["EXEC_SERVICE_PORT= 9191 "]))
        # Variable absente, vide ou illisible : le défaut du service.
        self.assertEqual(8085, chk.exec_port(["PATH=/usr/bin", ""]))
        self.assertEqual(8085, chk.exec_port(["EXEC_SERVICE_PORT="]))
        self.assertEqual(8085, chk.exec_port(["EXEC_SERVICE_PORT=abc", "AUTRE_EXEC_SERVICE_PORT=1"]))


if __name__ == "__main__":
    unittest.main()

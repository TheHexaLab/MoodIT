#!/usr/bin/env python3
"""Tests de la classification de deploy/check-compiled-harnesses.py (#116).

Le script est le contrôle BLOQUANT avant déploiement : il doit échouer FERMÉ. Seul un détail qui
prouve que le harnais a tourné donne OK ; tout message inconnu donne À VÉRIFIER.
Lancer : python3 deploy/test_check_compiled_harnesses.py
"""

import importlib.util
import os
import unittest
from unittest import mock

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

    def test_nom_reserve_d_une_question_interpretee_bloquant(self):
        # Refus rendu par CodeAssembler (Python, JavaScript/TypeScript, Bash) pour un symbole
        # que le harnais nomme et qui masque une intégrée. Le code de départ partant avec la
        # demande, ses propres noms n'y sont jamais refusés : ce refus est un garde-fou (noteur
        # d'une autre version), et il vaudrait pour toute réponse qui suit l'énoncé.
        for detail in ("Nom réservé : « sum » est réservé : il masque une fonction intégrée "
                       "de Python, que le harnais peut appeler. Renommer cette fonction ou "
                       "cette classe, puis resoumettre.\n",
                       "(node:12) Warning: x\nNom réservé : « Number » est réservé : il masque "
                       "une fonction ou un objet global de JavaScript",
                       "Nom réservé : « test » est réservé : il masque une commande de bash"):
            with self.subTest(detail=detail):
                self.assertEqual(chk.BLOCKING, chk.classify_proxied(detail, False))
        # Tout autre verdict : le format de ces harnais n'a pas changé, rien à signaler.
        for detail, passed in ((None, True), ("Le harnais a renvoyé faux", False),
                               ("NameError: name 'f' is not defined", False), ("", False),
                               (None, False)):
            with self.subTest(detail=detail, passed=passed):
                self.assertEqual(chk.OK, chk.classify_proxied(detail, passed))

    def test_inventaire_couvre_compiles_et_interpretes_a_mandataires(self):
        for name in chk.COMPILED_LANGUAGES + chk.PROXIED_LANGUAGES:
            self.assertIn("'%s'" % name, chk.INVENTORY_SQL)
        self.assertEqual(set(), set(chk.COMPILED_LANGUAGES) & set(chk.PROXIED_LANGUAGES))

    def test_question_interpretee_classee_par_le_seul_nom_reserve(self):
        question = {"language": "Python", "start_code": "def sum(xs):\n    pass\n",
                    "cases": [{"id": 1, "name": "a", "harnessCode": "return sum([1]) == 1",
                               "weight": 1}]}
        reserved = [{"passed": False, "detail": "Nom réservé : « sum » est réservé"}]
        with mock.patch.object(chk, "evaluate", return_value=reserved):
            status, lines = chk.check_question("http://x", "t", question)
        self.assertEqual(chk.BLOCKING, status)
        self.assertIn("Nom réservé", lines[0])
        # Le même détail sur une question COMPILÉE garde sa classe (refus du format).
        with mock.patch.object(chk, "evaluate", return_value=reserved):
            status, _ = chk.check_question("http://x", "t", dict(question, language="Java"))
        self.assertEqual(chk.TO_CHECK, status)
        # Un harnais interprété qui échoue contre le code de départ : normal.
        failed = [{"passed": False, "detail": "Le harnais a renvoyé faux"}]
        with mock.patch.object(chk, "evaluate", return_value=failed):
            status, lines = chk.check_question("http://x", "t", question)
        self.assertEqual((chk.OK, []), (status, lines))

    def test_la_demande_porte_le_code_de_depart(self):
        # #22 : sans lui, une fonction imposée par l'énoncé sous le nom d'une intégrée (`sum`)
        # serait refusée au rejeu alors que la correction, qui l'envoie, la note.
        question = {"language": "Python", "start_code": "def sum(xs):\n    pass\n",
                    "exec_timeout_ms": None,
                    "cases": [{"id": 1, "name": "a", "harnessCode": "return sum([1]) == 1",
                               "weight": 1}]}
        sent = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b"[]"

        def urlopen(request, timeout):
            sent["body"] = request.data
            return Response()

        with mock.patch.object(chk.urllib.request, "urlopen", urlopen):
            chk.evaluate("http://x", "t", question)
        body = __import__("json").loads(sent["body"].decode("utf-8"))
        self.assertEqual("def sum(xs):\n    pass\n", body["startCode"])
        self.assertEqual(body["code"], body["startCode"])

    def test_harnais_sans_fonction_du_code_de_depart_a_verifier(self):
        # L'énoncé impose `max`, le code de départ est le gabarit `solution` : le rejeu passe
        # (aucun nom réservé dans le code de départ), mais l'étudiant qui écrit `def max` sera
        # refusé. Seul ce contrôle statique le signale.
        question = {"language": "Python", "start_code": "def solution():\n    pass\n",
                    "cases": [{"id": 1, "name": "a", "harnessCode": "return max([1, 3]) == 3",
                               "weight": 1}]}
        with mock.patch.object(chk, "evaluate", return_value=[{"passed": True}]):
            status, lines = chk.check_question("http://x", "t", question)
        self.assertEqual(chk.TO_CHECK, status)
        self.assertIn("aucune fonction du code de départ", lines[0])
        # Le code de départ déclare le nom imposé : OK.
        declared = dict(question, start_code="def max(l):\n    pass\n")
        with mock.patch.object(chk, "evaluate", return_value=[{"passed": True}]):
            self.assertEqual((chk.OK, []), chk.check_question("http://x", "t", declared))
        # Pas pour une question compilée (contrat différent, classée par le compilateur).
        with mock.patch.object(chk, "evaluate", return_value=[{"passed": True}]):
            status, _ = chk.check_question("http://x", "t", dict(question, language="Java"))
        self.assertEqual(chk.OK, status)

    def test_declarations_lues_comme_le_noteur(self):
        self.assertEqual({"f", "C"}, chk.declared_names("Python", "async def f():\n    pass\nclass C:\n    pass"))
        self.assertEqual({"a", "b", "K"}, chk.declared_names(
            "TypeScript", "export function a() {}\nconst b = () => 1;\nexport default class K {}"))
        self.assertEqual({"carre", "test"}, chk.declared_names("Bash", "carre() { :; }\nfunction test () { :; }"))
        self.assertEqual(set(), chk.declared_names("Python", None))
        # Mot entier : `maximum` n'emploie pas `max`, `$f` n'est pas `f`.
        self.assertFalse(chk.harness_uses_start_code("Python", "def max(l): pass", "maximum(1)"))
        self.assertFalse(chk.harness_uses_start_code("JavaScript", "function f() {}", "$f(1)"))
        self.assertTrue(chk.harness_uses_start_code("JavaScript", "function f() {}", "f(1) === 2"))

    def test_harnais_qui_teste_une_exception_a_verifier(self):
        # Revue #246 : le rejeu du code de départ (qui ne lève rien) rend « faux » comme pour un
        # harnais normal, donc OK ; après la bascule, toute bonne réponse échoue.
        harness = ("try { Solution.racine(-1); return false; }\n"
                   "catch (IllegalArgumentException e) { return true; }")
        question = {"language": "Java", "start_code": "public class Solution { static double racine(double x) { return 0; } }",
                    "cases": [{"id": 3, "name": "négatif", "harnessCode": harness, "weight": 1}]}
        ran = [{"passed": False, "detail": "Le harnais a renvoyé faux"}]
        with mock.patch.object(chk, "evaluate", return_value=ran):
            status, lines = chk.check_question("http://x", "t", question)
        self.assertEqual(chk.TO_CHECK, status)
        self.assertIn("teste une exception", lines[0])
        for language, text in (("C#", "try { F(); } catch { return true; }"),
                               ("C#", "Assert.Throws<Exception>(() => F());"),
                               ("C++", "try { f(); } catch (...) { return true; }"),
                               ("Rust", "std::panic::catch_unwind(|| f()).is_err()"),
                               ("Go", "defer func() { recover() }()"),
                               ("C", "if (setjmp(b)) return 1;"),
                               ("Java", "assertThrows(X.class, () -> f())")):
            self.assertTrue(chk.tests_an_exception(language, text), (language, text))
        # Un mot en commentaire ou un nom qui contient « catch » ne compte pas.
        self.assertFalse(chk.tests_an_exception("Java", "// catch (e)\nreturn f() == 1;"))
        self.assertFalse(chk.tests_an_exception("Java", "return catcher(1) == 2;"))
        self.assertFalse(chk.tests_an_exception("Python", "try:\n    f()\nexcept E:\n    pass"))

    def test_ack(self):
        self.assertEqual({12, 15}, chk.parse_ack("12, 15"))
        self.assertEqual(set(), chk.parse_ack(""))
        self.assertEqual(set(), chk.parse_ack(None))

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

#!/usr/bin/env python3
"""Tests de la classification de deploy/check-compiled-harnesses.py (#116).

Le script est le contrôle BLOQUANT avant déploiement : il doit échouer FERMÉ. Seul un détail qui
prouve que le harnais a tourné donne OK ; tout message inconnu donne À VÉRIFIER.
Lancer : python3 deploy/test_check_compiled_harnesses.py
"""

import importlib.util
import io
import os
import re
import unittest
from unittest import mock

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check-compiled-harnesses.py")
_SPEC = importlib.util.spec_from_file_location("check_compiled_harnesses", _PATH)
chk = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(chk)


class ClassifyTest(unittest.TestCase):

    def test_passed_case_is_ok(self):
        self.assertEqual(chk.OK, chk.classify(None, True))

    def test_harness_that_ran_is_ok(self):
        for detail in ("Le harnais a renvoyé faux",
                       "[MOODIT] harnais: java.lang.ArithmeticException: / by zero",
                       "[MOODIT] appel refuse par le code soumis",
                       "[MOODIT] processus etudiant termine",
                       "Interrompu (temps limite dépassé)"):
            with self.subTest(detail=detail):
                self.assertEqual(chk.OK, chk.classify(detail, False))

    def test_harness_build_error_is_blocking(self):
        self.assertEqual(chk.BLOCKING, chk.classify("Le harnais ne compile pas :\nerreur", False))

    def test_function_dropped_by_stubs_is_blocking(self):
        # La fonction EXISTE dans le code de départ, mais aux types non transportables : le
        # générateur de bouchons l'a écartée, la question notera 0 à tout le monde.
        start = "public class Solution { public static int somme(int[] t) { return 0; } }"
        detail = ("Le harnais ne compile pas contre la signature du code soumis :\n"
                  "MooditGrader.java:3: error: cannot find symbol\n"
                  "  symbol:   method somme(int[])\n  location: class Solution")
        self.assertEqual(chk.BLOCKING, chk.classify(detail, False, start))

    def test_compiler_killed_under_driver_needs_check(self):
        # gcc, g++ et go build SURVIVENT à la mort de leur travailleur (OOM) et sortent en 1 :
        # le superviseur en faisait « Le harnais ne compile pas », que ce script classait
        # BLOQUANT — et --unpublish fermait un quiz juste. Stderr RÉELS, relevés dans les images.
        start = "int f(int x) { return x; }"
        for stderr in ("gcc: fatal error: Killed signal terminated program cc1\ncompilation terminated.",
                       "g++: fatal error: Killed signal terminated program cc1plus\ncompilation terminated.",
                       "moodit_noteur: /usr/local/go/pkg/tool/linux_amd64/compile: signal: killed"):
            with self.subTest(stderr=stderr):
                detail = "Le harnais ne compile pas contre le code soumis :\n" + stderr
                self.assertEqual(chk.TO_CHECK, chk.classify(detail, False, start))
        # Un vrai diagnostic reste BLOQUANT.
        self.assertEqual(chk.BLOCKING, chk.classify(
            "Le harnais ne compile pas contre le code soumis :\nnoteur.c:3:1: error: expected ';'",
            False, start))

    def test_harness_build_aborted_needs_check(self):
        # Compilation du noteur expirée ou tuée sur une machine chargée : pas un diagnostic,
        # jamais un quiz fermé par --unpublish. Ce test garde le RÉSULTAT, pas la branche des
        # préfixes : sans elle, le repli final rend aussi À VÉRIFIER (aucun détail ne peut les
        # distinguer). Que les préfixes suivent le superviseur, c'est SupervisorDriftTest.
        detail = ("Le harnais n'a pas fini de compiler (temps limite de compilation dépassé ou "
                  "compilateur arrêté) : rejouer la correction.")
        self.assertEqual(chk.TO_CHECK, chk.classify(detail, False, "int f(int x) { return x; }"))
        # Inventaire javap, javac du serveur RPC (Java) ou sonde des noms réservés expirés :
        # même chose (les trois messages TOOL_ABORTED du superviseur).
        for tool in ("Un outil de la notation n'a pas abouti : l'inventaire des méthodes de la "
                     "classe Solution (javap) a dépassé 30 s ou a été arrêté.",
                     "Un outil de la notation n'a pas abouti : la compilation du serveur RPC "
                     "(javac) n'a pas fini (temps limite dépassé ou compilateur arrêté).",
                     "Un outil de la notation n'a pas abouti : la vérification des noms réservés "
                     "(compilateur) a dépassé 20 s ou a été arrêtée."):
            with self.subTest(tool=tool):
                self.assertEqual(chk.TO_CHECK,
                                 chk.classify(tool, False, "int f(int x) { return x; }"))

    def test_empty_diagnostic_needs_check(self):
        for detail in ("Le harnais ne compile pas contre le code soumis :\n",
                       "Le harnais ne compile pas contre le code soumis :\n   \n",
                       "Le harnais ne compile pas contre le code soumis"):
            with self.subTest(detail=detail):
                self.assertEqual(chk.TO_CHECK, chk.classify(detail, False, "int f;"))

    def test_function_missing_from_start_code_needs_check(self):
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

    def test_member_or_type_missing_from_start_code_needs_check(self):
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

    def test_connection_dropped_during_response_is_unavailable(self):
        # Une coupure en cours de lecture n'est ni une URLError ni un TimeoutError : le script
        # s'arrêtait, sans rejouer la suite ni fermer les quiz bloquants. Revue #246 : « pas de
        # réponse » ne prouve rien sur la question — NOTEUR INDISPONIBLE, jamais de fermeture,
        # et pas de nouvel essai (la correction a pu tourner).
        import http.client
        question = {"start_code": "int f(void);", "language": "C", "cases": []}
        for error in (ConnectionResetError("coupée"), http.client.RemoteDisconnected("fermée"),
                      http.client.IncompleteRead(b""), TimeoutError("timed out")):
            with self.subTest(error=type(error).__name__), \
                    mock.patch.object(chk, "evaluate", side_effect=error) as evaluate, \
                    mock.patch.object(chk.time, "sleep",
                                      side_effect=AssertionError("nouvel essai interdit")):
                status, lines = chk.check_question("http://x", "t", question)
                self.assertEqual(chk.UNAVAILABLE, status)
                self.assertIn("le noteur n'a pas répondu", lines[0])
                self.assertEqual(1, evaluate.call_count)

    def test_missing_from_start_code(self):
        diagnostic = "undefined: Carre\nundefined: Aide"
        self.assertEqual(["Carre"], chk.missing_from_start_code(diagnostic, "func Aide() int"))
        # Mot entier : « carre » ne compte pas comme présent dans « carres ».
        self.assertEqual(["carre"], chk.missing_from_start_code(
            "cannot find function `carre` in this scope", "fn carres() {}"))
        self.assertEqual([], chk.missing_from_start_code("erreur de type", "fn f() {}"))

    def test_name_only_in_comment_needs_check(self):
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

    def test_start_code_without_transportable_function_needs_check(self):
        # Même message du superviseur pour un squelette sans aucune fonction (harnais peut-être
        # juste) et pour des types non transportables : jamais BLOQUANT, donc jamais de quiz
        # fermé par --unpublish sur ce seul message.
        for detail in ("Aucune fonction exploitable dans le code soumis "
                       "(types acceptés : int, long, double).",
                       "Aucune méthode statique ni objet exploitable dans la classe Main "
                       "(types acceptés : int, long, double, boolean, String)."):
            with self.subTest(detail=detail):
                self.assertEqual(chk.TO_CHECK, chk.classify(detail, False))

    def test_messages_without_proof_need_check(self):
        # Messages réels du superviseur et de DockerEvaluator qui passaient OK avant le correctif :
        # le harnais n'a jamais tourné.
        for detail in ("Erreur interne du noteur (serveur RPC)",
                       "Erreur interne du noteur",
                       "Aucun fichier de code soumis",
                       "Retirez la ligne « package … ; » en tête du fichier : la notation, comme le "
                       "bouton « Exécuter », attend la classe dans le paquet par défaut.",
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

    def test_reserved_name_on_proxied_question_is_blocking(self):
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

    def test_inventory_covers_compiled_and_proxied_languages(self):
        for name in chk.COMPILED_LANGUAGES + chk.PROXIED_LANGUAGES:
            self.assertIn("'%s'" % name, chk.INVENTORY_SQL)
        self.assertEqual(set(), set(chk.COMPILED_LANGUAGES) & set(chk.PROXIED_LANGUAGES))

    def test_proxied_question_classified_by_reserved_name_only(self):
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

    def test_request_carries_start_code(self):
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

        with mock.patch.object(chk.OPENER, "open", urlopen):
            chk.evaluate("http://x", "t", question)
        body = __import__("json").loads(sent["body"].decode("utf-8"))
        self.assertEqual("def sum(xs):\n    pass\n", body["startCode"])
        self.assertEqual(body["code"], body["startCode"])

    def test_harness_without_start_code_function_needs_check(self):
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

    def test_declarations_read_like_the_grader(self):
        self.assertEqual({"f", "C"}, chk.declared_names("Python", "async def f():\n    pass\nclass C:\n    pass"))
        self.assertEqual({"a", "b", "K"}, chk.declared_names(
            "TypeScript", "export function a() {}\nconst b = () => 1;\nexport default class K {}"))
        self.assertEqual({"carre", "test"}, chk.declared_names("Bash", "carre() { :; }\nfunction test () { :; }"))
        self.assertEqual(set(), chk.declared_names("Python", None))
        # Mot entier : `maximum` n'emploie pas `max`, `$f` n'est pas `f`.
        self.assertFalse(chk.harness_uses_start_code("Python", "def max(l): pass", "maximum(1)"))
        self.assertFalse(chk.harness_uses_start_code("JavaScript", "function f() {}", "$f(1)"))
        self.assertTrue(chk.harness_uses_start_code("JavaScript", "function f() {}", "f(1) === 2"))

    def test_declaration_forms_recognized_by_the_grader(self):
        # Revue #246 : formes que CodeAssembler lit (PY_DEF, BASH_FUNC, `\p{L}`) et que le script
        # ratait — le nom imposé n'était pas vu, la question sortait À VÉRIFIER, et --unpublish
        # fermait un quiz juste. Une forme par cas.
        for language, start, name in (
                # Python : fonction de premier niveau écrite en lambda.
                ("Python", "max = lambda l: 0\n", "max"),
                ("Python", "carre=lambda x: x * x\n", "carre"),
                # Bash : `function f {`, sans parenthèses.
                ("Bash", "function carre {\n  echo $(( $1 * $1 ))\n}\n", "carre"),
                # Identifiants Unicode (première lettre accentuée) : Python, JS/TS, Bash.
                ("Python", "def écart(a, b):\n    pass\n", "écart"),
                ("Python", "class Élève:\n    pass\n", "Élève"),
                ("JavaScript", "function écart(a, b) {}\n", "écart"),
                ("TypeScript", "export const élève = (n: number) => n;\n", "élève"),
                ("TypeScript", "class Élève {}\n", "Élève"),
                ("Bash", "écart() { :; }\n", "écart"),
                ("Bash", "function écart { :; }\n", "écart")):
            with self.subTest(language=language, start=start):
                self.assertEqual({name}, chk.declared_names(language, start))
                question = {"language": language, "start_code": start,
                            "cases": [{"id": 1, "name": "a", "harnessCode": name + "(1)",
                                       "weight": 1}]}
                with mock.patch.object(chk, "evaluate", return_value=[{"passed": True}]):
                    self.assertEqual((chk.OK, []), chk.check_question("http://x", "t", question))
        # Les formes déjà reconnues le restent, et un chiffre n'ouvre pas un nom.
        self.assertEqual({"f", "g"}, chk.declared_names("Bash", "function f() { :; }\ng () { :; }"))
        self.assertEqual({"_x"}, chk.declared_names("Python", "_x = lambda: 1\n1y = lambda: 2"))
        self.assertEqual(set(), chk.declared_names("Python", "    f = lambda: 1\nlambdas = 3"))

    def test_harness_testing_an_exception_needs_check(self):
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

    def test_empty_inventory_fails_unless_allow_empty(self):
        # Un dump non chargé donnait « 0 question », bilan vide, sortie 0 : un faux feu vert.
        with mock.patch.object(chk, "psql", return_value="[]"), \
                mock.patch.object(chk, "container_env", return_value=[]), \
                mock.patch.object(chk, "exec_url", return_value="http://x"), \
                mock.patch.object(chk, "internal_token", return_value="t"), \
                mock.patch.object(chk.sys, "argv", ["check"]):
            self.assertEqual(2, chk.main())
        with mock.patch.object(chk, "psql", return_value="[]"), \
                mock.patch.object(chk, "container_env", return_value=[]), \
                mock.patch.object(chk, "exec_url", return_value="http://x"), \
                mock.patch.object(chk, "internal_token", return_value="t"), \
                mock.patch.object(chk.sys, "argv", ["check", "--allow-empty"]):
            self.assertEqual(0, chk.main())

    def test_exit_code_and_unpublish_only_concern_published_quizzes(self):
        # Revue #246 : fermer un quiz BLOQUANT ne changeait pas la sortie (toutes les questions
        # comptaient, brouillons compris), et --unpublish laissait ouvert un quiz À VÉRIFIER
        # (harnais à exception) qui note 0 à toute bonne réponse.
        def question(qid, quiz, published, harness):
            return {"quiz_id": quiz, "quiz_title": "Q%d" % quiz, "published": published,
                    "question_id": qid, "language": "Java", "start_code": "class S {}",
                    "exec_timeout_ms": None,
                    "cases": [{"id": qid, "name": "c", "harnessCode": harness, "weight": 1}]}
        inventory = [question(1, 10, True, "try { f(); } catch (Exception e) { return true; }"),
                     question(2, 20, False, "try { f(); } catch (Exception e) { return true; }"),
                     question(3, 30, True, "return f() == 1;")]
        calls = []

        def fake_psql(container, sql):
            calls.append(sql)
            return chk.json.dumps(inventory) if "json_agg" in sql else ""
        verdict = [{"passed": True, "detail": None}]
        for argv, expected, closed in (
                (["check"], 1, None),
                (["check", "--unpublish"], 1, "IN (10);"),
                (["check", "--ack", "1"], 0, None)):
            calls.clear()
            with self.subTest(argv=argv), \
                    mock.patch.object(chk, "psql", side_effect=fake_psql), \
                    mock.patch.object(chk, "container_env", return_value=[]), \
                    mock.patch.object(chk, "exec_url", return_value="http://x"), \
                    mock.patch.object(chk, "internal_token", return_value="t"), \
                    mock.patch.object(chk, "evaluate", return_value=verdict), \
                    mock.patch.object(chk.sys, "argv", argv):
                self.assertEqual(expected, chk.main())
                updates = [sql for sql in calls if sql.startswith("UPDATE")]
                self.assertEqual([closed] if closed else [],
                                 [sql[sql.index("IN ("):] for sql in updates])

    def test_worst(self):
        self.assertEqual(chk.OK, chk.worst([chk.OK, chk.OK]))
        self.assertEqual(chk.TO_CHECK, chk.worst([chk.OK, chk.TO_CHECK]))
        self.assertEqual(chk.BLOCKING, chk.worst([chk.TO_CHECK, chk.BLOCKING, chk.OK]))

    def test_exec_port_follows_container_environment(self):
        # Le port était en dur : sur un autre port, tout sortait « À VÉRIFIER ».
        self.assertEqual(9191, chk.exec_port(["PATH=/usr/bin", "EXEC_SERVICE_PORT=9191"]))
        self.assertEqual(9191, chk.exec_port(["EXEC_SERVICE_PORT= 9191 "]))
        # Variable absente, vide ou illisible : le défaut du service.
        self.assertEqual(8085, chk.exec_port(["PATH=/usr/bin", ""]))
        self.assertEqual(8085, chk.exec_port(["EXEC_SERVICE_PORT="]))
        self.assertEqual(8085, chk.exec_port(["EXEC_SERVICE_PORT=abc", "AUTRE_EXEC_SERVICE_PORT=1"]))


_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SUPERVISOR = os.path.join(_ROOT, "docker", "runners", "common", "supervisor.py")
_CODE_ASSEMBLER = os.path.join(_ROOT, "execution-service", "src", "main", "java", "com", "moodit",
                               "execution_service", "assembly", "CodeAssembler.java")


class SupervisorDriftTest(unittest.TestCase):
    """Les libellés que le script reconnaît sont COPIÉS du superviseur et de CodeAssembler : s'ils
    y changent, le script ne les reconnaît plus, en silence (un harnais qui tourne sortirait À
    VÉRIFIER, un « ne compile pas » ne serait plus BLOQUANT). Revue #246."""

    @classmethod
    def setUpClass(cls):
        # Chargé par importlib depuis son chemin (compatible `python -I`) : rien n'en est lancé,
        # son main() n'est appelé que sous `__main__`.
        spec = importlib.util.spec_from_file_location("moodit_supervisor", _SUPERVISOR)
        cls.supervisor = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.supervisor)
        with open(_SUPERVISOR, encoding="utf-8") as f:
            cls.supervisor_source = f.read()

    def test_prefixes_equal_supervisor_ones(self):
        for name in ("HARNESS_BUILD_ERROR", "HARNESS_BUILD_ABORTED", "TOOL_ABORTED"):
            with self.subTest(name=name):
                self.assertEqual(getattr(self.supervisor, name), getattr(chk, name))
        self.assertEqual(self.supervisor.TOOL_KILLED.pattern, chk.TOOL_KILLED.pattern)

    def test_run_proofs_written_by_supervisor(self):
        # Chaque préfixe de HARNESS_RAN ouvre un littéral du superviseur (message ou gabarit de
        # noteur) : le guillemet devant interdit un simple fragment de phrase.
        for prefix in chk.HARNESS_RAN:
            with self.subTest(prefix=prefix):
                self.assertIn('"' + prefix, self.supervisor_source)

    def test_accepted_types_written_by_supervisor(self):
        self.assertIn("(" + chk.NO_TRANSPORTABLE_SIGNATURE + " : ", self.supervisor_source)

    def test_reserved_name_equals_code_assembler_prefix(self):
        with open(_CODE_ASSEMBLER, encoding="utf-8") as f:
            source = f.read()
        prefixes = re.findall(r'\bSHADOW_PREFIX\s*=\s*"((?:[^"\\]|\\.)*)"\s*;', source)
        self.assertEqual([chk.RESERVED_NAME], prefixes)


_EXECUTION_CLIENT = os.path.join(_ROOT, "core-service", "src", "main", "java", "com", "moodit",
                                 "core_service", "service", "ExecutionClient.java")


class ExecutionClientDriftTest(unittest.TestCase):
    """Le délai d'attente du script COPIE le pire cas de core (ExecutionClient.readTimeoutMs) :
    si core le relève et pas le script, celui-ci renonce avant le noteur, et --unpublish ferme un
    quiz juste. Chaque terme copié est relu dans la source Java. Revue #246."""

    @classmethod
    def setUpClass(cls):
        with open(_EXECUTION_CLIENT, encoding="utf-8") as f:
            cls.source = f.read()

    def java_constant(self, name):
        """Valeur d'une constante `static final long|int NAME = <entiers et *>;` de la source."""
        found = re.findall(r"\bstatic\s+final\s+(?:long|int)\s+%s\s*=\s*([\d_\s*]+);" % name,
                           self.source)
        self.assertEqual(1, len(found), "constante %s introuvable ou ambiguë" % name)
        value = 1
        for factor in found[0].split("*"):
            value *= int(factor.strip().replace("_", ""))
        return value

    def spring_default(self, key):
        """Défaut d'une propriété `@Value("${clé:défaut}")` (ou `${…:${VAR:défaut}}`)."""
        found = re.findall(r"\$\{" + re.escape(key) + r":(?:\$\{\w+:)?(\d+)\}", self.source)
        self.assertEqual(1, len(found), "défaut de %s introuvable ou ambigu" % key)
        return int(found[0])

    def test_constants_equal_core_ones(self):
        for name in ("RUN_MARGIN_MS", "EXEC_WALL_SLACK_MS", "EVAL_MAX_WALL_MS",
                     "DAEMON_RESPONSE_MS", "DAEMON_CONNECT_MS", "LOG_READ_MS",
                     "DAEMON_CALLS_OUTSIDE_WALL"):
            with self.subTest(name=name):
                self.assertEqual(self.java_constant(name), getattr(chk, "_" + name))

    def test_lifecycle_same_formula_as_core(self):
        formula = "DAEMON_CALLS_OUTSIDE_WALL * (DAEMON_CONNECT_MS + DAEMON_RESPONSE_MS) + LOG_READ_MS"
        found = re.findall(r"\bCONTAINER_LIFECYCLE_MS\s*=\s*([^;]+);", self.source)
        self.assertEqual([formula], [" ".join(f.split()) for f in found])
        self.assertEqual(
            self.java_constant("DAEMON_CALLS_OUTSIDE_WALL")
            * (self.java_constant("DAEMON_CONNECT_MS") + self.java_constant("DAEMON_RESPONSE_MS"))
            + self.java_constant("LOG_READ_MS"),
            chk._CONTAINER_LIFECYCLE_MS)

    def test_default_settings_equal_core_ones(self):
        for key, name in (("app.execution-service.read-timeout-ms", "_BASE_READ_MS"),
                          ("app.execution-service.per-test-timeout-ms", "_PER_TEST_MS"),
                          ("app.execution-service.internal-queue-wait-ms",
                           "_DEFAULT_QUEUE_WAIT_MS"),
                          ("app.execution-service.interpreted-budget-ms",
                           "_DEFAULT_INTERPRETED_BUDGET_MS")):
            with self.subTest(key=key):
                self.assertEqual(self.spring_default(key), getattr(chk, name))

    def test_read_timeout_capped_like_core(self):
        found = re.findall(r"\bstatic\s+final\s+long\s+MAX_READ_TIMEOUT_MS\s*=\s*([^;]+);",
                           self.source)
        self.assertEqual(["Integer.MAX_VALUE"], [f.strip() for f in found])
        self.assertEqual(2**31 - 1, chk._MAX_READ_TIMEOUT_MS)

    def test_time_limit_capped_like_core(self):
        self.assertIn("Math.min(Math.max(execTimeoutMs, 1), %s)" % format(chk.MAX_TIMEOUT_MS, "_"),
                      self.source)


class ReadTimeoutTest(unittest.TestCase):
    """Revue #246 : 900 s, plus court que le pire cas serveur — le script renonçait pendant une
    correction en cours, et --unpublish fermait un quiz juste."""

    # Cycle de vie d'un conteneur hors mur, démon lent : 7 × (5 s + 60 s) + 30 s (revue #246 :
    # l'ancien terme de 35 s ne couvrait que des appels rapides).
    LIFECYCLE_S = 7 * (5 + 60) + 30

    def test_covers_server_worst_case(self):
        self.assertEqual(485, self.LIFECYCLE_S)
        # Interprété (défauts) : base 10 s + budget 900 s + l'unité déjà partie (attente 120 s +
        # temps limite 60 s + marge 5 s + mur 75 s + cycle de vie 485 s) = 1 655 s.
        self.assertGreaterEqual(chk.read_timeout_s({}),
                                10 + 900 + 120 + 60 + 5 + 75 + self.LIFECYCLE_S)
        # Compilé : base 10 s + attente 120 s + mur 900 s + marge 5 s + cycle de vie 485 s.
        self.assertGreaterEqual(chk.read_timeout_s({}), 10 + 120 + 900 + 5 + self.LIFECYCLE_S)

    def test_follows_shared_server_settings(self):
        default = chk.read_timeout_s({})
        self.assertGreaterEqual(chk.read_timeout_s({"EXEC_INTERPRETED_BUDGET_MS": "1800000"}),
                                default + 900)
        self.assertGreaterEqual(chk.read_timeout_s({"EXEC_INTERNAL_QUEUE_WAIT_MS": "300000"}),
                                default + 180)
        # Valeur vide ou illisible : le défaut du service.
        self.assertEqual(default, chk.read_timeout_s({"EXEC_INTERPRETED_BUDGET_MS": "",
                                                      "EXEC_INTERNAL_QUEUE_WAIT_MS": "abc"}))

    def test_huge_budget_capped_like_core(self):
        # Revue #246 : EXEC_INTERPRETED_BUDGET_MS = Long.MAX_VALUE donnait un délai que
        # socket.settimeout refuse (OverflowError) : le script s'arrêtait à la 1re question.
        huge = {"EXEC_INTERPRETED_BUDGET_MS": "9223372036854775807",
                "EXEC_INTERNAL_QUEUE_WAIT_MS": "9223372036854775807"}
        timeout = chk.read_timeout_s(huge)
        self.assertLessEqual(timeout, 2_147_483.647)
        self.assertEqual((2**31 - 1) / 1000, timeout)
        # Une vraie requête avec ce délai (serveur local) : urlopen le pose sur son socket.
        import http.server
        import threading

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"[]")

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            question = {"language": "Java", "start_code": "class S {}", "cases": []}
            self.assertEqual([], chk.evaluate("http://127.0.0.1:%d" % server.server_port, "t",
                                              question, timeout_s=timeout))
        finally:
            server.shutdown()
            server.server_close()
        # Sans dépassement, la valeur n'est pas touchée.
        self.assertLess(chk.read_timeout_s({}), timeout)

    def test_settings_read_from_container_first(self):
        # Revue #246 : sur l'hôte de prod, le shell n'a pas chargé .env.docker ; un budget relevé
        # pour le service ne rallongeait pas l'attente du script, qui renonçait avant le noteur.
        lines = ["PATH=/usr/bin", "EXEC_INTERPRETED_BUDGET_MS=1800000",
                 "EXEC_INTERNAL_QUEUE_WAIT_MS=abc"]
        shell = {"EXEC_INTERPRETED_BUDGET_MS": "600000", "EXEC_INTERNAL_QUEUE_WAIT_MS": "300000"}
        # Conteneur d'abord ; valeur illisible dans le conteneur : celle du shell.
        self.assertEqual({"EXEC_INTERPRETED_BUDGET_MS": "1800000",
                          "EXEC_INTERNAL_QUEUE_WAIT_MS": "300000"},
                         chk.server_settings(lines, shell))
        # Sans conteneur (étape 1, bootRun) : le shell ; sans rien : les défauts.
        self.assertEqual(shell, chk.server_settings([], shell))
        self.assertEqual({}, chk.server_settings([], {}))
        self.assertEqual("1", chk.container_setting(["A=0", "AB=2", "B=1"], "B"))
        self.assertIsNone(chk.container_setting(["AB=2"], "A"))

    def test_main_waits_per_container_settings(self):
        # Le délai passé à chaque appel suit le conteneur, même quand le shell n'a rien.
        inventory = [{"quiz_id": 1, "quiz_title": "Q", "published": True, "question_id": 1,
                      "language": "Java", "start_code": "class S {}", "exec_timeout_ms": None,
                      "cases": [{"id": 1, "name": "c", "harnessCode": "return S.f() == 1;",
                                 "weight": 1}]}]
        seen = []

        def fake_evaluate(base_url, token, question, timeout_s=None):
            seen.append(timeout_s)
            return [{"passed": True, "detail": None}]
        with mock.patch.object(chk, "psql", return_value=chk.json.dumps(inventory)), \
                mock.patch.object(chk, "container_env",
                                  return_value=["EXEC_INTERPRETED_BUDGET_MS=1800000"]), \
                mock.patch.object(chk, "exec_url", return_value="http://x"), \
                mock.patch.object(chk, "internal_token", return_value="t"), \
                mock.patch.object(chk, "evaluate", side_effect=fake_evaluate), \
                mock.patch.dict(chk.os.environ, {}, clear=True), \
                mock.patch.object(chk.sys, "argv", ["check"]):
            self.assertEqual(0, chk.main())
        self.assertEqual([chk.read_timeout_s({"EXEC_INTERPRETED_BUDGET_MS": "1800000"})], seen)
        self.assertGreater(seen[0], chk.read_timeout_s({}))

    def test_container_env_empty_without_container(self):
        # Étape 1 : service lancé par bootRun, pas de conteneur — ni arrêt ni exception.
        failure = chk.subprocess.CalledProcessError(1, ["docker"])
        for error in (failure, FileNotFoundError("docker")):
            with self.subTest(error=type(error).__name__), \
                    mock.patch.object(chk, "run", side_effect=error):
                self.assertEqual([], chk.container_env("moodit_execution"))
        with mock.patch.object(chk, "run", return_value="A=1\nB=2\n"):
            self.assertEqual(["A=1", "B=2"], chk.container_env("moodit_execution"))

    def test_request_waits_that_timeout(self):
        seen = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b"[]"

        def urlopen(request, timeout):
            seen["timeout"] = timeout
            return Response()

        question = {"language": "Java", "start_code": "class S {}", "cases": []}
        with mock.patch.object(chk.OPENER, "open", urlopen), \
                mock.patch.dict(chk.os.environ, {"EXEC_INTERPRETED_BUDGET_MS": "1800000"}):
            chk.evaluate("http://x", "t", question)
            expected = chk.read_timeout_s(chk.os.environ)
        self.assertEqual(expected, seen["timeout"])
        self.assertGreaterEqual(seen["timeout"],
                                10 + 1800 + 120 + 60 + 5 + 75 + self.LIFECYCLE_S)


def http_error(code, body=None, headers=None):
    """HTTPError comme urllib la lève, corps JSON facultatif."""
    import io
    import urllib.error
    payload = io.BytesIO(chk.json.dumps(body).encode("utf-8") if body is not None else b"")
    return urllib.error.HTTPError("http://x/internal/exec/evaluate", code, "erreur",
                                  headers or {}, payload)


def always(make_error):
    """side_effect qui lève une NOUVELLE erreur à chaque appel (aucune laissée ouverte)."""
    def fail(*args, **kwargs):
        raise make_error()
    return fail


class GraderRetryTest(unittest.TestCase):
    """Revue #246 : un 429, un 502 « indisponible » ou une connexion refusée classaient la
    question À VÉRIFIER, et --unpublish fermait un quiz juste. Désormais : nouveaux essais
    bornés, puis NOTEUR INDISPONIBLE (jamais de fermeture, sortie 3)."""

    QUESTION = {"quiz_id": 1, "quiz_title": "Q", "published": True, "question_id": 7,
                "language": "Java", "start_code": "class S {}", "exec_timeout_ms": None,
                "cases": [{"id": 1, "name": "c", "harnessCode": "return S.f() == 1;",
                           "weight": 1}]}
    VERDICT = [{"passed": True, "detail": None}]

    def setUp(self):
        # Horloge simulée : chaque attente l'avance d'autant, sans rien attendre pour de bon.
        self.now = 1000.0
        self.waits = []

        def sleep(seconds):
            self.waits.append(seconds)
            self.now += seconds
            # Nouveaux essais sans borne : échec immédiat plutôt qu'un test qui ne finit pas.
            if len(self.waits) > 1000 or seconds < 0:
                raise AssertionError("nouveaux essais sans borne ou attente négative")
        patches = (mock.patch.object(chk.time, "monotonic", lambda: self.now),
                   mock.patch.object(chk.time, "sleep", sleep))
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def check(self, *outcomes):
        with mock.patch.object(chk, "evaluate", side_effect=list(outcomes)) as evaluate:
            status, lines = chk.check_question("http://x", "t", self.QUESTION)
        return status, lines, evaluate.call_count

    def test_429_then_answer_is_ok_after_retry_after(self):
        status, lines, calls = self.check(http_error(429, headers={"Retry-After": "7"}),
                                          self.VERDICT)
        self.assertEqual((chk.OK, [], 2), (status, lines, calls))
        self.assertEqual([7], self.waits)

    def test_connection_refused_then_answer_is_ok(self):
        import urllib.error
        refused = urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))
        status, _, calls = self.check(refused, refused, self.VERDICT)
        self.assertEqual((chk.OK, 3), (status, calls))
        self.assertEqual([1, 2], self.waits)

    def test_unavailable_502_then_answer_is_ok(self):
        status, _, calls = self.check(http_error(502, {"cause": "indisponible"}), self.VERDICT)
        self.assertEqual((chk.OK, 2), (status, calls))

    def test_persistent_unavailability_is_bounded(self):
        # Durée simulée : attentes doublées de 1 s à 10 s, 2 min au total, puis abandon.
        unavailable = always(lambda: http_error(502, {"cause": "indisponible"}))
        with mock.patch.object(chk, "evaluate", side_effect=unavailable) as evaluate:
            status, lines = chk.check_question("http://x", "t", self.QUESTION)
        calls = evaluate.call_count
        self.assertEqual(chk.UNAVAILABLE, status)
        self.assertIn("relancer le script", lines[0])
        self.assertEqual([1, 2, 4, 8], self.waits[:4])
        self.assertTrue(all(wait <= 10 for wait in self.waits))
        self.assertEqual(120, sum(self.waits))
        self.assertEqual(len(self.waits) + 1, calls)

    def test_no_verdict_502_stays_to_check_without_retry(self):
        status, lines, calls = self.check(http_error(502, {"cause": "sans_verdict"}))
        self.assertEqual((chk.TO_CHECK, 1), (status, calls))
        self.assertIn("sans_verdict", lines[0])
        self.assertEqual([], self.waits)

    def test_refused_token_is_unavailable_without_retry(self):
        status, lines, calls = self.check(http_error(401))
        self.assertEqual((chk.UNAVAILABLE, 1), (status, calls))
        self.assertIn("INTERNAL_TOKEN", lines[0])

    def test_other_errors_keep_their_class(self):
        # Refus du format (400), erreur du noteur (500), 502 au corps illisible : À VÉRIFIER,
        # comme avant, sans nouvel essai.
        for error in (http_error(400, {"detail": "format"}), http_error(500),
                      http_error(502)):
            with self.subTest(code=error.code):
                status, _, calls = self.check(error)
                self.assertEqual((chk.TO_CHECK, 1), (status, calls))

    def test_persistent_429_never_unpublishes_and_exits_3(self):
        calls = []

        def fake_psql(container, sql):
            calls.append(sql)
            return chk.json.dumps([self.QUESTION]) if "json_agg" in sql else ""
        busy = always(lambda: http_error(429, headers={"Retry-After": "5"}))
        with mock.patch.object(chk, "psql", side_effect=fake_psql), \
                mock.patch.object(chk, "container_env", return_value=[]), \
                mock.patch.object(chk, "exec_url", return_value="http://x"), \
                mock.patch.object(chk, "internal_token", return_value="t"), \
                mock.patch.object(chk, "evaluate", side_effect=busy), \
                mock.patch.object(chk.sys, "argv", ["check", "--unpublish"]):
            self.assertEqual(chk.EXIT_UNAVAILABLE, chk.main())
        self.assertEqual([], [sql for sql in calls if sql.startswith("UPDATE")])
        self.assertEqual(3, chk.EXIT_UNAVAILABLE)
        self.assertLessEqual(sum(self.waits), 120)

    def test_proven_quiz_still_closed_when_another_is_unavailable(self):
        # Contrôle incomplet (sortie 3), mais un quiz PROUVÉ en cause est fermé quand même.
        broken = dict(self.QUESTION, quiz_id=2, question_id=8)
        calls = []

        def fake_psql(container, sql):
            calls.append(sql)
            return chk.json.dumps([self.QUESTION, broken]) if "json_agg" in sql else ""
        outcomes = [http_error(401),
                    [{"passed": False, "detail": "Le harnais ne compile pas :\nerreur"}]]
        with mock.patch.object(chk, "psql", side_effect=fake_psql), \
                mock.patch.object(chk, "container_env", return_value=[]), \
                mock.patch.object(chk, "exec_url", return_value="http://x"), \
                mock.patch.object(chk, "internal_token", return_value="t"), \
                mock.patch.object(chk, "evaluate", side_effect=outcomes), \
                mock.patch.object(chk.sys, "argv", ["check", "--unpublish"]):
            self.assertEqual(chk.EXIT_UNAVAILABLE, chk.main())
        self.assertEqual(["UPDATE Quiz SET is_published = false WHERE id IN (2);"],
                         [sql for sql in calls if sql.startswith("UPDATE")])

    def test_429_after_server_queue_wait_is_still_retried(self):
        # Revue #246 : l'appel interne attend jusqu'à 120 s une place côté serveur AVANT de
        # répondre 429 ; une échéance posée avant cet appel était déjà épuisée — aucun essai.
        def busy_after_queue_wait(*args, **kwargs):
            self.now += 120
            raise http_error(429, headers={"Retry-After": "5"})
        outcomes = iter([busy_after_queue_wait, lambda *a, **k: self.VERDICT])
        with mock.patch.object(chk, "evaluate",
                               side_effect=lambda *a, **k: next(outcomes)(*a, **k)) as evaluate:
            status, lines = chk.check_question("http://x", "t", self.QUESTION)
        self.assertEqual((chk.OK, [], 2), (status, lines, evaluate.call_count))
        self.assertEqual([5], self.waits)

    def test_budget_message_counts_from_first_failure(self):
        def busy_after_queue_wait(*args, **kwargs):
            self.now += 120
            raise http_error(429)
        with mock.patch.object(chk, "evaluate", side_effect=busy_after_queue_wait):
            status, lines = chk.check_question("http://x", "t", self.QUESTION)
        self.assertEqual(chk.UNAVAILABLE, status)
        self.assertIn("toujours après 120 s de nouveaux essais", lines[0])
        # Au moins un nouvel essai, attentes comprises dans le budget.
        self.assertTrue(self.waits)
        self.assertLessEqual(sum(self.waits), 120)

    def test_static_proof_kept_when_grader_unavailable(self):
        # Revue #246 : NOTEUR INDISPONIBLE était rendu AVANT les contrôles statiques, et un quiz
        # au harnais déjà prouvé en cause restait ouvert.
        harness = "try { S.f(-1); return false; } catch (IllegalArgumentException e) { return true; }"
        question = dict(self.QUESTION, cases=[{"id": 1, "name": "c", "harnessCode": harness,
                                               "weight": 1}])
        for code in (401, 429):
            calls = []

            def fake_psql(container, sql):
                calls.append(sql)
                return chk.json.dumps([question]) if "json_agg" in sql else ""
            with self.subTest(code=code), \
                    mock.patch.object(chk, "psql", side_effect=fake_psql), \
                    mock.patch.object(chk, "container_env", return_value=[]), \
                    mock.patch.object(chk, "exec_url", return_value="http://x"), \
                    mock.patch.object(chk, "internal_token", return_value="t"), \
                    mock.patch.object(chk, "evaluate",
                                      side_effect=always(lambda code=code: http_error(code))), \
                    mock.patch.object(chk.sys, "argv", ["check", "--unpublish"]):
                status, lines = chk.check_question("http://x", "t", question)
                self.assertEqual(chk.TO_CHECK, status)
                self.assertIn("teste une exception", lines[0])
                self.assertIn("relancer le script", lines[-1])
                # Contrôle incomplet (sortie 3), mais le quiz prouvé en cause est fermé.
                with mock.patch("sys.stdout", new_callable=io.StringIO) as out, \
                        mock.patch("sys.stderr", new_callable=io.StringIO):
                    self.assertEqual(chk.EXIT_UNAVAILABLE, chk.main())
                self.assertEqual(["UPDATE Quiz SET is_published = false WHERE id IN (1);"],
                                 [sql for sql in calls if sql.startswith("UPDATE")])
                # Le bilan compte ce qui décide de la sortie 3 : la question À VÉRIFIER restée
                # sans verdict du noteur (il affichait « 0 sans réponse du noteur »).
                self.assertIn("0 bloquant(s), 1 à vérifier, 0 ok, 1 sans verdict du noteur.",
                              out.getvalue())

    def test_unreachable_grader_skips_following_questions(self):
        # Revue #246 : service arrêté → 2 min de nouveaux essais PAR question avant la sortie 3.
        import urllib.error
        questions = [dict(self.QUESTION, question_id=i, quiz_id=i) for i in (1, 2, 3)]
        refused = always(lambda: urllib.error.URLError(ConnectionRefusedError(111, "refusée")))
        with mock.patch.object(chk, "psql",
                               side_effect=lambda c, sql: chk.json.dumps(questions)
                               if "json_agg" in sql else ""), \
                mock.patch.object(chk, "container_env", return_value=[]), \
                mock.patch.object(chk, "exec_url", return_value="http://x"), \
                mock.patch.object(chk, "internal_token", return_value="t"), \
                mock.patch.object(chk, "evaluate", side_effect=refused) as evaluate, \
                mock.patch.object(chk.sys, "argv", ["check", "--unpublish"]):
            self.assertEqual(chk.EXIT_UNAVAILABLE, chk.main())
        # Une seule série de nouveaux essais (2 min) pour les trois questions.
        self.assertLessEqual(sum(self.waits), 120)
        self.assertEqual(len(self.waits) + 1, evaluate.call_count)
        # Une réponse du service (429) ne le marque pas injoignable : la suite est tentée.
        grader = {"unreachable": False, "incomplete": 0}
        with mock.patch.object(chk, "evaluate", side_effect=always(lambda: http_error(429))):
            chk.check_question("http://x", "t", self.QUESTION, grader=grader)
        self.assertEqual({"unreachable": False, "incomplete": 1}, grader)

    def test_connect_timeout_is_treated_like_refusal(self):
        # Revue #246 : un hôte qui ignore les paquets bloquait près d'une demi-heure (le délai de
        # lecture servait aussi à la connexion). La connexion expire en CONNECT_TIMEOUT_S, et
        # compte comme un refus : nouveaux essais, puis service injoignable.
        timeouts = []

        def blackhole(address, timeout=None, source_address=None, **kwargs):
            timeouts.append(timeout)
            raise TimeoutError("timed out")
        grader = {"unreachable": False, "incomplete": 0}
        with mock.patch("socket.create_connection", side_effect=blackhole):
            status, lines = chk.check_question("http://192.0.2.1:8085", "t", self.QUESTION,
                                               timeout_s=1715, grader=grader)
        self.assertEqual(chk.UNAVAILABLE, status)
        self.assertIn("injoignable", lines[0])
        self.assertTrue(grader["unreachable"])
        self.assertTrue(self.waits)
        self.assertEqual({chk.CONNECT_TIMEOUT_S}, set(timeouts))

    def test_worst_puts_proofs_before_unavailability(self):
        self.assertEqual(chk.TO_CHECK, chk.worst([chk.UNAVAILABLE, chk.TO_CHECK]))
        self.assertEqual(chk.UNAVAILABLE, chk.worst([chk.OK, chk.UNAVAILABLE]))


class SplitTimeoutTest(unittest.TestCase):
    """Délai de connexion court, délai de lecture long : une correction longue n'est pas coupée
    par le délai de connexion, et le délai de lecture reste appliqué. Vrai serveur local."""

    def serve(self, delay_s):
        import http.server
        import threading

        class SlowHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                threading.Event().wait(delay_s)   # correction qui prend du temps
                try:
                    self.send_response(200)
                    self.send_header("Content-Length", "2")
                    self.end_headers()
                    self.wfile.write(b"[]")
                except OSError:
                    pass   # client parti (délai de lecture dépassé)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SlowHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return "http://127.0.0.1:%d" % server.server_port

    QUESTION = {"language": "Java", "start_code": "class S {}", "cases": []}

    def test_long_read_not_cut_by_connect_timeout(self):
        url = self.serve(0.6)
        with mock.patch.object(chk, "CONNECT_TIMEOUT_S", 0.2):
            self.assertEqual([], chk.evaluate(url, "t", self.QUESTION, timeout_s=5))

    def test_read_timeout_still_applies(self):
        url = self.serve(0.6)
        with mock.patch.object(chk, "CONNECT_TIMEOUT_S", 5):
            with self.assertRaises(TimeoutError):
                chk.evaluate(url, "t", self.QUESTION, timeout_s=0.2)


class CaseNameTest(unittest.TestCase):
    def test_empty_name_becomes_case_n_like_core(self):
        # Revue #246 : un nom vide donnait un 400 (@NotBlank) et classait À VÉRIFIER une question
        # que core corrige normalement (il envoie « cas N »).
        question = {"language": "Python", "start_code": "",
                    "cases": [{"name": "", "harnessCode": "return True", "weight": 1},
                              {"name": "  ", "harnessCode": "return True", "weight": 1},
                              {"name": None, "harnessCode": "return True", "weight": 1},
                              {"name": "garde", "harnessCode": "return True", "weight": 1}]}
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

        with mock.patch.object(chk.OPENER, "open", urlopen):
            chk.evaluate("http://x", "t", question)
        body = __import__("json").loads(sent["body"].decode("utf-8"))
        self.assertEqual(["cas 1", "cas 2", "cas 3", "garde"],
                         [case["name"] for case in body["testCases"]])


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Tests de la classification de deploy/check-compiled-harnesses.py (#116).

Le script est le contrôle BLOQUANT avant déploiement : il doit échouer FERMÉ. Seul un détail qui
prouve que le harnais a tourné donne OK ; tout message inconnu donne À VÉRIFIER.
Lancer : python3 deploy/test_check_compiled_harnesses.py
"""

import importlib.util
import os
import re
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

    def test_compilateur_tue_sous_son_pilote_a_verifier(self):
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

    def test_compilation_du_harnais_expiree_a_verifier(self):
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
                def fails(base_url, token, q, timeout_s=None, error=error):
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

    def test_formes_de_declaration_reconnues_par_le_noteur(self):
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

    def test_inventaire_vide_echoue_sauf_allow_empty(self):
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

    def test_sortie_et_unpublish_ne_portent_que_sur_les_quiz_publies(self):
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

    def test_exec_port_suit_l_environnement_du_conteneur(self):
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

    def test_prefixes_egaux_a_ceux_du_superviseur(self):
        for name in ("HARNESS_BUILD_ERROR", "HARNESS_BUILD_ABORTED", "TOOL_ABORTED"):
            with self.subTest(name=name):
                self.assertEqual(getattr(self.supervisor, name), getattr(chk, name))
        self.assertEqual(self.supervisor.TOOL_KILLED.pattern, chk.TOOL_KILLED.pattern)

    def test_preuves_d_execution_ecrites_par_le_superviseur(self):
        # Chaque préfixe de HARNESS_RAN ouvre un littéral du superviseur (message ou gabarit de
        # noteur) : le guillemet devant interdit un simple fragment de phrase.
        for prefix in chk.HARNESS_RAN:
            with self.subTest(prefix=prefix):
                self.assertIn('"' + prefix, self.supervisor_source)

    def test_types_acceptes_ecrit_par_le_superviseur(self):
        self.assertIn("(" + chk.NO_TRANSPORTABLE_SIGNATURE + " : ", self.supervisor_source)

    def test_nom_reserve_egal_au_prefixe_de_code_assembler(self):
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

    def test_constantes_egales_a_celles_de_core(self):
        for name in ("RUN_MARGIN_MS", "EXEC_WALL_SLACK_MS", "EVAL_MAX_WALL_MS",
                     "DAEMON_RESPONSE_MS", "DAEMON_CONNECT_MS", "LOG_READ_MS",
                     "DAEMON_CALLS_OUTSIDE_WALL"):
            with self.subTest(name=name):
                self.assertEqual(self.java_constant(name), getattr(chk, "_" + name))

    def test_cycle_de_vie_meme_formule_que_core(self):
        formula = "DAEMON_CALLS_OUTSIDE_WALL * (DAEMON_CONNECT_MS + DAEMON_RESPONSE_MS) + LOG_READ_MS"
        found = re.findall(r"\bCONTAINER_LIFECYCLE_MS\s*=\s*([^;]+);", self.source)
        self.assertEqual([formula], [" ".join(f.split()) for f in found])
        self.assertEqual(
            self.java_constant("DAEMON_CALLS_OUTSIDE_WALL")
            * (self.java_constant("DAEMON_CONNECT_MS") + self.java_constant("DAEMON_RESPONSE_MS"))
            + self.java_constant("LOG_READ_MS"),
            chk._CONTAINER_LIFECYCLE_MS)

    def test_reglages_par_defaut_egaux_a_ceux_de_core(self):
        for key, name in (("app.execution-service.read-timeout-ms", "_BASE_READ_MS"),
                          ("app.execution-service.per-test-timeout-ms", "_PER_TEST_MS"),
                          ("app.execution-service.internal-queue-wait-ms",
                           "_DEFAULT_QUEUE_WAIT_MS"),
                          ("app.execution-service.interpreted-budget-ms",
                           "_DEFAULT_INTERPRETED_BUDGET_MS")):
            with self.subTest(key=key):
                self.assertEqual(self.spring_default(key), getattr(chk, name))

    def test_temps_limite_plafonne_comme_core(self):
        self.assertIn("Math.min(Math.max(execTimeoutMs, 1), %s)" % format(chk.MAX_TIMEOUT_MS, "_"),
                      self.source)


class ReadTimeoutTest(unittest.TestCase):
    """Revue #246 : 900 s, plus court que le pire cas serveur — le script renonçait pendant une
    correction en cours, et --unpublish fermait un quiz juste."""

    # Cycle de vie d'un conteneur hors mur, démon lent : 7 × (5 s + 60 s) + 30 s (revue #246 :
    # l'ancien terme de 35 s ne couvrait que des appels rapides).
    LIFECYCLE_S = 7 * (5 + 60) + 30

    def test_couvre_le_pire_cas_serveur(self):
        self.assertEqual(485, self.LIFECYCLE_S)
        # Interprété (défauts) : base 10 s + budget 900 s + l'unité déjà partie (attente 120 s +
        # temps limite 60 s + marge 5 s + mur 75 s + cycle de vie 485 s) = 1 655 s.
        self.assertGreaterEqual(chk.read_timeout_s({}),
                                10 + 900 + 120 + 60 + 5 + 75 + self.LIFECYCLE_S)
        # Compilé : base 10 s + attente 120 s + mur 900 s + marge 5 s + cycle de vie 485 s.
        self.assertGreaterEqual(chk.read_timeout_s({}), 10 + 120 + 900 + 5 + self.LIFECYCLE_S)

    def test_suit_les_reglages_partages_du_serveur(self):
        default = chk.read_timeout_s({})
        self.assertGreaterEqual(chk.read_timeout_s({"EXEC_INTERPRETED_BUDGET_MS": "1800000"}),
                                default + 900)
        self.assertGreaterEqual(chk.read_timeout_s({"EXEC_INTERNAL_QUEUE_WAIT_MS": "300000"}),
                                default + 180)
        # Valeur vide ou illisible : le défaut du service.
        self.assertEqual(default, chk.read_timeout_s({"EXEC_INTERPRETED_BUDGET_MS": "",
                                                      "EXEC_INTERNAL_QUEUE_WAIT_MS": "abc"}))

    def test_reglages_lus_d_abord_dans_le_conteneur(self):
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

    def test_main_attend_selon_le_conteneur(self):
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

    def test_container_env_vide_sans_conteneur(self):
        # Étape 1 : service lancé par bootRun, pas de conteneur — ni arrêt ni exception.
        failure = chk.subprocess.CalledProcessError(1, ["docker"])
        for error in (failure, FileNotFoundError("docker")):
            with self.subTest(error=type(error).__name__), \
                    mock.patch.object(chk, "run", side_effect=error):
                self.assertEqual([], chk.container_env("moodit_execution"))
        with mock.patch.object(chk, "run", return_value="A=1\nB=2\n"):
            self.assertEqual(["A=1", "B=2"], chk.container_env("moodit_execution"))

    def test_la_demande_attend_ce_delai(self):
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
        with mock.patch.object(chk.urllib.request, "urlopen", urlopen), \
                mock.patch.dict(chk.os.environ, {"EXEC_INTERPRETED_BUDGET_MS": "1800000"}):
            chk.evaluate("http://x", "t", question)
            expected = chk.read_timeout_s(chk.os.environ)
        self.assertEqual(expected, seen["timeout"])
        self.assertGreaterEqual(seen["timeout"],
                                10 + 1800 + 120 + 60 + 5 + 75 + self.LIFECYCLE_S)


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

        with mock.patch.object(chk.urllib.request, "urlopen", urlopen):
            chk.evaluate("http://x", "t", question)
        body = __import__("json").loads(sent["body"].decode("utf-8"))
        self.assertEqual(["cas 1", "cas 2", "cas 3", "garde"],
                         [case["name"] for case in body["testCases"]])


if __name__ == "__main__":
    unittest.main()

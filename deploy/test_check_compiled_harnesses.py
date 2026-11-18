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
        self.assertEqual(chk.BLOCKING, chk.classify(
            "Aucune fonction exploitable (types acceptés : int, long)", False))

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


if __name__ == "__main__":
    unittest.main()

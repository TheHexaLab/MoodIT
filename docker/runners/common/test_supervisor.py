# -*- coding: utf-8 -*-
"""Tests unitaires des FONCTIONS PURES de supervisor.py (verdict des canaris, jeton de fin,
relecture tête+queue, substitution des gabarits, scan de trace) : la logique de verdict ne doit
pas n'être couverte que par les tests d'intégration Docker. Lancés par le job CI `integration`
(`python3 docker/runners/common/test_supervisor.py`) AVANT la construction des images, et
exécutables localement dans n'importe quelle image runner (le module importe `resource`,
indisponible sous Windows).
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import supervisor  # noqa: E402


def outcome(passed, ran=True, timed_out=False):
    return supervisor.CaseOutcome(passed, None, ran=ran, timed_out=timed_out)


class CanaryVerdictTest(unittest.TestCase):
    def setUp(self):
        supervisor.EVENTS.clear()

    def test_aucun_canari(self):
        self.assertEqual(supervisor.canary_verdict([{"index": 0}], {0: outcome(True)}), "aucun")

    def test_canaris_conformes(self):
        cases = [{"index": 0}, {"index": 1, "canary": "pass"}, {"index": 2, "canary": "fail"}]
        outcomes = {0: outcome(True), 1: outcome(True), 2: outcome(False)}
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "ok")
        self.assertEqual(supervisor.EVENTS, [])

    def test_canari_au_resultat_contraire(self):
        cases = [{"index": 0}, {"index": 1, "canary": "pass"}, {"index": 2, "canary": "fail"}]
        outcomes = {0: outcome(True), 1: outcome(True), 2: outcome(True)}  # « fail » qui réussit
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "incoherents")
        self.assertEqual(supervisor.EVENTS[0]["type"], "canari_incoherent")

    def test_fail_closed_si_les_cas_reels_ont_tourne_mais_pas_les_canaris(self):
        # Collision de nom ciblant la compilation des seuls canaris : falsification, pas un
        # échec honnête (un code honnête échoue PARTOUT pareil).
        cases = [{"index": 0}, {"index": 1, "canary": "pass"}, {"index": 2, "canary": "fail"}]
        outcomes = {0: outcome(True), 1: outcome(False, ran=False), 2: outcome(False, ran=False)}
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "incoherents")
        self.assertEqual(supervisor.EVENTS[0]["type"], "canari_incoherent")

    def test_tout_expire_indetermine_pas_d_accusation(self):
        # Temps limite trop court (ou hôte surchargé) : TOUT expire, canaris compris — mauvaise
        # configuration, pas une falsification. Aucun gain pour un sabotage (cas réels morts).
        cases = [{"index": 0}, {"index": 1, "canary": "pass"}, {"index": 2, "canary": "fail"}]
        outcomes = {0: outcome(False, timed_out=True), 1: outcome(False, timed_out=True),
                    2: outcome(False, timed_out=True)}
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
        self.assertEqual(supervisor.EVENTS, [])

    def test_indetermine_quand_rien_n_a_tourne(self):
        # Échec de compilation GLOBAL (code étudiant cassé) : honnête, pas d'alerte.
        cases = [{"index": 0}, {"index": 1, "canary": "pass"}, {"index": 2, "canary": "fail"}]
        outcomes = {0: outcome(False, ran=False), 1: outcome(False, ran=False),
                    2: outcome(False, ran=False)}
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
        self.assertEqual(supervisor.EVENTS, [])


class EnforceTokenTest(unittest.TestCase):
    def setUp(self):
        supervisor.EVENTS.clear()
        supervisor.TOKENS.clear()
        supervisor.TOKENS[0] = "123456789012"

    def test_jeton_present_verdict_conserve(self):
        passed, detail = supervisor.enforce_token(
            True, None, "PASS\n[MOODIT] jeton=123456789012\n", 0)
        self.assertTrue(passed)
        self.assertIsNone(detail)
        self.assertEqual(supervisor.EVENTS, [])

    def test_jeton_absent_refuse_un_verdict_reussi(self):
        # Rapport forgé + exit(0) depuis la fonction notée : tous les autres canaux passent,
        # seul le jeton (imprimé APRÈS tous les tests) manque.
        passed, detail = supervisor.enforce_token(True, None, "PASS\n", 0)
        self.assertFalse(passed)
        self.assertIn("jeton", detail)
        self.assertEqual(supervisor.EVENTS[0]["type"], "jeton_absent")

    def test_echec_reste_echec_sans_alerte(self):
        passed, detail = supervisor.enforce_token(False, "boum", "FAIL\n", 0)
        self.assertFalse(passed)
        self.assertEqual(detail, "boum")
        self.assertEqual(supervisor.EVENTS, [])


class ReadCappedTest(unittest.TestCase):
    def test_petit_fichier_entier(self):
        with tempfile.NamedTemporaryFile("w", suffix=".out", delete=False) as f:
            f.write("début\nfin\n")
        try:
            self.assertEqual(supervisor.read_capped(f.name, cap=1024), "début\nfin\n")
        finally:
            os.unlink(f.name)

    def test_gros_fichier_tete_et_queue(self):
        # Copie honnête mais bavarde : le jeton, imprimé EN FIN de sortie, doit survivre à la
        # troncature — sinon fausse accusation (« jeton absent »).
        with tempfile.NamedTemporaryFile("w", suffix=".out", delete=False) as f:
            f.write("tete-visible\n" + ("x" * 10000) + "\n[MOODIT] jeton=42\n")
        try:
            text = supervisor.read_capped(f.name, cap=1024)
            self.assertIn("tete-visible", text)
            self.assertIn("[MOODIT] jeton=42", text)
            self.assertIn("tronquée au milieu", text)
        finally:
            os.unlink(f.name)


class SubstitutePlaceholdersTest(unittest.TestCase):
    def test_substitue_dans_tous_les_fichiers_du_src(self):
        with tempfile.TemporaryDirectory() as case_dir:
            src = os.path.join(case_dir, "src")
            os.makedirs(src)
            with open(os.path.join(src, "h.c"), "w", encoding="utf-8") as f:
                f.write("a=__MOODIT_A__; t=\"__MOODIT_T__\";")
            supervisor.substitute_placeholders(case_dir, {"__MOODIT_A__": "7",
                                                          "__MOODIT_T__": "jeton"})
            with open(os.path.join(src, "h.c"), encoding="utf-8") as f:
                self.assertEqual(f.read(), 'a=7; t="jeton";')


class ScanTraceTest(unittest.TestCase):
    def setUp(self):
        supervisor.EVENTS.clear()

    def _trace(self, lines):
        f = tempfile.NamedTemporaryFile("w", suffix=".trace", delete=False)
        f.write("\n".join(lines) + "\n")
        f.close()
        return f.name

    def test_lecture_de_source_verrouillee_detectee(self):
        path = self._trace(['openat(AT_FDCWD, "src/harness.c", O_RDONLY) = -1 EACCES'])
        try:
            supervisor.scan_trace(path, "/box/cases/0/src", 0)
            self.assertEqual(supervisor.EVENTS[0]["type"], "lecture_source_tentee")
        finally:
            os.unlink(path)

    def test_lecture_du_binaire_de_test_detectee(self):
        path = self._trace(['openat(AT_FDCWD, "/proc/self/exe", O_RDONLY) = 3'])
        try:
            supervisor.scan_trace(path, "/box/cases/0/src", 0,
                                  binaries=("/box/cases/0/tests",))
            self.assertEqual(supervisor.EVENTS[0]["type"], "lecture_binaire_tentee")
        finally:
            os.unlink(path)

    def test_trace_anodine_sans_evenement(self):
        path = self._trace(['openat(AT_FDCWD, "/etc/ld.so.cache", O_RDONLY) = 3'])
        try:
            supervisor.scan_trace(path, "/box/cases/0/src", 0,
                                  binaries=("/box/cases/0/tests",))
            self.assertEqual(supervisor.EVENTS, [])
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main(verbosity=1)

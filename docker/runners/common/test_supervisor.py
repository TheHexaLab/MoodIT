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


def outcome(passed, ran=True, timed_out=False, skipped=False):
    return supervisor.CaseOutcome(passed, None, ran=ran, timed_out=timed_out, skipped=skipped)


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

    def test_canari_saute_faute_de_budget_pas_d_accusation(self):
        # Budget global dépassé : l'ordre étant tiré au sort, un canari peut tomber dans la
        # queue non exécutée alors que des cas réels ont tourné. Une soumission simplement
        # TROP LENTE ne doit jamais être étiquetée « falsification probable ».
        cases = [{"index": 0}, {"index": 1, "canary": "pass"}, {"index": 2, "canary": "fail"}]
        outcomes = {0: outcome(True), 1: outcome(True),
                    2: outcome(False, ran=False, skipped=True)}
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
        self.assertEqual(supervisor.EVENTS, [])

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


class StudentUidTest(unittest.TestCase):
    """UID étudiant unique par conteneur : RLIMIT_NPROC compte par UID RÉEL sur l'hôte, un UID
    fixe en faisait un budget partagé entre notations simultanées."""

    def test_reecrit_uid_et_gid_dans_passwd(self):
        passwd = ("root:x:0:0:root:/root:/bin/bash\n"
                  "student:x:1300:1300::/nonexistent:/usr/sbin/nologin\n")
        out = supervisor.with_uid(passwd, "student", 45678, 45678)
        self.assertIn("student:x:45678:45678::/nonexistent:/usr/sbin/nologin", out)
        self.assertIn("root:x:0:0:", out)          # les autres lignes sont intactes

    def test_reecrit_gid_dans_group(self):
        out = supervisor.with_uid("student:x:1300:\n", "student", 45678, 45678)
        self.assertEqual(out, "student:x:45678:\n")

    def test_utilisateur_absent_renvoie_none(self):
        self.assertIsNone(supervisor.with_uid("root:x:0:0:\n", "student", 1, 1))


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


class RustVerdictTest(unittest.TestCase):
    """Verdict Rust : avec --nocapture, libtest imprime « test <nom> ... » SANS saut de ligne,
    la sortie du test s'y colle et « FAILED » peut se retrouver seul sur sa ligne. Un fil de
    détente ancré sur « ^test X ... FAILED$ » ne voyait donc rien dès que le code étudiant
    imprimait quelque chose."""

    def test_succes_honnete(self):
        out = ("running 2 tests\n"
               "test moodit_tests::aire ... ok\n"
               "test zzzz_moodit_jeton::zzzz_jeton ... [MOODIT] jeton=42\n"
               "ok\n"
               "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n")
        self.assertEqual(supervisor.rust_verdict(0, out), (True, None))

    def test_echec_honnete(self):
        out = ("running 2 tests\n"
               "test moodit_tests::aire ... FAILED\n"
               "test zzzz_moodit_jeton::zzzz_jeton ... ok\n"
               "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out\n")
        passed, incoherence = supervisor.rust_verdict(101, out)
        self.assertFalse(passed)
        self.assertIsNone(incoherence)

    def test_forgeage_par_test_tardif_avec_sortie_detecte(self):
        # EXPLOIT : la fonction notée imprime (le « FAILED » du vrai test se retrouve seul sur
        # sa ligne), puis un test zzzzz_* trié après le jeton forge le sommaire et exit(0).
        out = ("running 3 tests\n"
               "test moodit_tests::aire ... coucou depuis la fonction notee\n"
               "FAILED\n"
               "test zzzz_moodit_jeton::zzzz_jeton ... [MOODIT] jeton=42\n"
               "ok\n"
               "test zzzzz_tricheur::t ... \n"
               "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n")
        passed, incoherence = supervisor.rust_verdict(0, out)
        self.assertFalse(passed)
        self.assertIn("forgé", incoherence)

    def test_forgeage_sans_sortie_detecte(self):
        # Variante naïve : le « FAILED » reste collé au marqueur de début.
        out = ("running 3 tests\n"
               "test moodit_tests::aire ... FAILED\n"
               "test zzzz_moodit_jeton::zzzz_jeton ... ok\n"
               "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n")
        passed, incoherence = supervisor.rust_verdict(0, out)
        self.assertFalse(passed)
        self.assertIn("forgé", incoherence)

    def test_sommaire_annonce_moins_de_tests_que_demarres(self):
        # Forgeur qui sort tôt : trois tests démarrés, deux annoncés.
        out = ("running 3 tests\n"
               "test a::x ... ok\n"
               "test b::y ... ok\n"
               "test c::z ... \n"
               "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n")
        passed, incoherence = supervisor.rust_verdict(0, out)
        self.assertFalse(passed)
        self.assertIn("démarrés", incoherence)

    def test_exit_zero_sans_sommaire(self):
        passed, incoherence = supervisor.rust_verdict(0, "running 1 test\n")
        self.assertFalse(passed)
        self.assertIn("sans sommaire", incoherence)

    def test_exit_non_nul_jamais_reussi(self):
        out = "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n"
        self.assertEqual(supervisor.rust_verdict(1, out), (False, None))


class RandomIdentifierTest(unittest.TestCase):
    """Nom des canaris : une forme FIXE (« 1 majuscule + 9 minuscules ») restait
    reconnaissable à l'exécution sur les langages où le code étudiant peut interposer les
    fonctions de sortie — il relayait alors honnêtement les tests à cette forme."""

    def test_identifiant_valide_et_de_longueur_variable(self):
        import random
        rng = random.Random(12345)
        noms = {supervisor.random_identifier(rng) for _ in range(300)}
        self.assertGreater(len({len(n) for n in noms}), 3)       # longueurs variées
        for nom in noms:
            self.assertRegex(nom, r"^[A-Za-z][A-Za-z0-9_]*$")    # identifiant valide partout
            self.assertGreaterEqual(len(nom), 5)
        # L'alphabet dépasse la casse unique : chiffres et _ apparaissent.
        self.assertTrue(any(c.isdigit() or c == "_" for n in noms for c in n))
        self.assertTrue(any(c.isupper() for n in noms for c in n[1:]))


class BoxExhaustedTest(unittest.TestCase):
    """Saturation du tmpfs /box : un code honnête mais bogué (fichiers temporaires jamais
    supprimés) faisait échouer les cas SUIVANTS, canaris compris → « falsification probable ».
    Le cas est désormais sauté avec un verdict honnête."""

    def test_sous_le_seuil_est_sature(self):
        # 100 blocs de 4 Kio = 400 Kio, bien en dessous du seuil de 48 Mio.
        self.assertTrue(supervisor.free_bytes_under(100, 4096, 48 * 1024 * 1024))

    def test_au_dessus_du_seuil_est_sain(self):
        # 100 000 blocs de 4 Kio = 390 Mio.
        self.assertFalse(supervisor.free_bytes_under(100000, 4096, 48 * 1024 * 1024))

    def test_cas_saute_pour_saturation_n_accuse_pas(self):
        # Même traitement qu'un budget dépassé : skipped → « indetermines », jamais
        # « incoherents » (vérifié par le verdict des canaris).
        cases = [{"index": 0}, {"index": 1, "canary": "pass"}, {"index": 2, "canary": "fail"}]
        outcomes = {0: outcome(True), 1: outcome(False, ran=False, skipped=True),
                    2: outcome(False, ran=False, skipped=True)}
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
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

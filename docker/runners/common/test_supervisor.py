# -*- coding: utf-8 -*-
"""Tests unitaires des FONCTIONS PURES de supervisor.py (verdict des canaris, jeton de fin,
relecture tête+queue, substitution des gabarits, scan de trace) : la logique de verdict ne doit
pas n'être couverte que par les tests d'intégration Docker. Lancés par le job CI `integration`
(`python3 docker/runners/common/test_supervisor.py`) AVANT la construction des images, et
exécutables localement dans n'importe quelle image runner (le module importe `resource`,
indisponible sous Windows).
"""

import os
import shutil
import sys
import tempfile
import io
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

    def test_jeton_absent_mais_sortie_perdue_n_accuse_pas(self):
        # Rust et C/C++ passent par ici (pas d'enveloppe tenant le code du framework) et
        # doivent obeir a la meme regle que wrapper_verdict : un tmpfs sature a pu empecher
        # l'ECRITURE du jeton. On ne distingue pas une saturation d'un forgeage, donc dans le
        # doute on refuse le cas SANS accuser.
        passed, detail = supervisor.enforce_token(True, None, "PASS\n", 0,
                                                  sortie_perdue=True)
        self.assertFalse(passed)
        self.assertIn("incomplète", detail)
        self.assertEqual(supervisor.EVENTS, [])

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

    def test_sortie_honnete_contenant_failed_reste_un_echec_sans_accusation(self):
        # Avec --nocapture, les println! de l'étudiant sont MÊLÉS aux lignes de libtest : un
        # programme qui imprime « FAILED » (p. ex. `println!("{}", if ok {"OK"} else {"FAILED"})`)
        # déclenchait le recoupement. Le cas est refusé — on ne peut pas distinguer —, mais
        # l'événement ne doit plus porter d'accusation côté Java (cf. isSuspicious).
        out = ("running 2 tests\n"
               "test moodit_tests::d ... FAILED\n"
               "test zzzz_moodit_jeton::zzzz_jeton ... ok\n"
               "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n")
        passed, incoherence = supervisor.rust_verdict(0, out)
        self.assertFalse(passed)
        self.assertIsNotNone(incoherence)

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

    def test_seul_le_jeton_a_tourne_est_refuse(self):
        # Si un filtrage trop large écarte tous les tests du prof, il ne reste que le jeton :
        # sommaire cohérent, exit 0, jeton présent — le cas était noté RÉUSSI sur un code
        # arbitrairement faux. L'invariant « au moins deux tests » ferme ce trou.
        out = ("running 1 test\n"
               "test zzzz_moodit_jeton::zzzz_jeton ... [MOODIT] jeton=42\n"
               "ok\n"
               "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out\n")
        passed, incoherence = supervisor.rust_verdict(0, out)
        self.assertFalse(passed)
        self.assertIn("jeton", incoherence)

    def test_exit_zero_sans_sommaire(self):
        passed, incoherence = supervisor.rust_verdict(0, "running 1 test\n")
        self.assertFalse(passed)
        self.assertIn("sans sommaire", incoherence)

    def test_exit_non_nul_jamais_reussi(self):
        out = "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n"
        self.assertEqual(supervisor.rust_verdict(1, out), (False, None))


class SelectionTest(unittest.TestCase):
    """Filtres d'exécution : un cas CANARI n'exécute que son test ; un cas RÉEL exécute tout
    SAUF les conteneurs déclarés par l'étudiant. L'exclusion est un choix de sûreté — une
    extraction incomplète réintroduit au pire l'ancien défaut d'équité, elle ne peut pas
    n'exécuter aucun test du prof et accorder la note."""

    def setUp(self):
        supervisor.CANARY_NAMES.clear()
        supervisor.STUDENT_TYPES.clear()

    def test_cas_reel_exclut_les_types_de_l_etudiant(self):
        supervisor.STUDENT_TYPES[0] = ["Solution", "MesTests"]
        self.assertEqual(supervisor.junit_selection(0),
                         ["--scan-class-path",
                          "--exclude-classname=^Solution$", "--exclude-classname=^MesTests$"])
        self.assertEqual(supervisor.nunit_selection(0),
                         ["--where", "class != 'Solution' and class != 'MesTests'"])
        self.assertEqual(supervisor.libtest_selection(0, ""), [])   # sans listing : pas de filtre

    def test_rust_selectionne_par_nom_exact_depuis_le_listing(self):
        listing = ("moodit_tests::d: test\n"
                   "tests::x: test\n"
                   "zzzz_moodit_jeton::zzzz_jeton: test\n\n3 tests, 0 benchmarks\n")
        self.assertEqual(supervisor.libtest_listed_tests(listing),
                         ["moodit_tests::d", "tests::x", "zzzz_moodit_jeton::zzzz_jeton"])
        supervisor.STUDENT_TYPES[0] = ["tests"]
        # « tests » et « moodit_tests » restent distincts : la comparaison porte sur le
        # PREMIER SEGMENT, là où --skip aurait filtré les deux (sous-chaîne).
        self.assertEqual(supervisor.libtest_selection(0, listing),
                         ["--exact", "moodit_tests::d", "zzzz_moodit_jeton::zzzz_jeton"])

    def test_rust_module_court_ne_filtre_pas_le_harnais(self):
        listing = "harnais::d: test\ns::x: test\nzzzz_moodit_jeton::zzzz_jeton: test\n"
        supervisor.STUDENT_TYPES[0] = ["s"]
        self.assertEqual(supervisor.libtest_selection(0, listing),
                         ["--exact", "harnais::d", "zzzz_moodit_jeton::zzzz_jeton"])

    def test_rust_listing_forge_ne_peut_pas_injecter_une_option(self):
        # Le run `--list` exécute déjà du code étudiant : sa sortie n'est pas digne de
        # confiance. Une ligne forgée commençant par « - » deviendrait une OPTION de libtest
        # dans l'argv et détournerait le filtre. Seuls des chemins de test Rust bien formés
        # sont retenus.
        forge = ("harnais::d: test\n"
                 "--skip: test\n"
                 "-Zunstable-options: test\n"
                 "mes_tests::x: test\n")
        # TOUT OU RIEN : on renonce au filtre entier. Ignorer la ligne en silence serait
        # pire — la sélection est une LISTE BLANCHE, donc un nom écarté ne tournerait pas.
        self.assertIsNone(supervisor.libtest_listed_tests(forge))
        supervisor.STUDENT_TYPES[0] = ["mes_tests"]
        self.assertEqual(supervisor.libtest_selection(0, forge), [])

    def test_rust_nom_de_test_non_ascii_fait_renoncer_au_filtre(self):
        # Rust accepte les identifiants non ASCII et bruts, et `--list` les imprime tels quels.
        # Les écarter en silence aurait SAUTÉ ce test du harnais — sans que l'invariant
        # « un test du harnais a tourné » s'en aperçoive, un seul lui suffisant.
        for nom in ("moodit_tests::teste_données", "moodit_tests::r#match"):
            listing = ("moodit_tests::ascii_ok: test\n%s: test\n"
                       "zzzz_moodit_jeton::zzzz_jeton: test\n" % nom)
            self.assertIsNone(supervisor.libtest_listed_tests(listing), nom)
            # « moodit_tests » (un module REELLEMENT present dans le listing) et non « tests » :
            # avec un module absent, keep == names, libtest_selection renvoyait [] par un AUTRE
            # chemin et l'assertion passait meme si la garantie tout-ou-rien etait cassee.
            supervisor.STUDENT_TYPES[0] = ["moodit_tests"]
            self.assertEqual(supervisor.libtest_selection(0, listing), [], nom)

    def test_rust_listing_tronque_pas_de_filtre(self):
        # Un listing plafonné perd les tests du MILIEU : un filtre bâti dessus pouvait écarter
        # le harnais à l'insu de tous. On renonce au filtre (l'invariant reste le garde-fou).
        tronque = ("harnais::a: test\n… (sortie tronquée au milieu : 99999 octets)\n"
                   "zzz::b: test\n")
        # La troncature est reperee EN AMONT (usable_listing, appelee par run_rust) : sans elle,
        # libtest_selection batirait bel et bien un filtre partiel sur ce listing.
        self.assertEqual(supervisor.usable_listing(tronque, False), "")
        self.assertEqual(supervisor.usable_listing("harnais::a: test\n", True), "")
        self.assertEqual(supervisor.usable_listing("harnais::a: test\n", False),
                         "harnais::a: test\n")
        supervisor.STUDENT_TYPES[0] = ["zzz"]
        self.assertIn("--exact", supervisor.libtest_selection(0, tronque))   # le risque evite
        self.assertEqual(supervisor.libtest_selection(
            0, supervisor.usable_listing(tronque, False)), [])
        self.assertEqual(supervisor.libtest_listed_tests(tronque), ["harnais::a", "zzz::b"])

    def test_rust_listing_illisible_pas_de_filtre(self):
        supervisor.STUDENT_TYPES[0] = ["tests"]
        self.assertEqual(supervisor.libtest_selection(0, ""), [])

    def test_sans_type_extrait_aucun_filtre(self):
        # Comportement d'origine : on exécute tout (défaut d'équité, jamais de note offerte).
        supervisor.STUDENT_TYPES[0] = []
        self.assertEqual(supervisor.junit_selection(0), ["--scan-class-path"])
        self.assertEqual(supervisor.nunit_selection(0), [])
        self.assertEqual(supervisor.libtest_selection(0), [])

    def test_canari_n_execute_que_son_test(self):
        supervisor.CANARY_NAMES[1] = "Abcdef"
        supervisor.STUDENT_TYPES[1] = ["Solution"]
        self.assertEqual(supervisor.junit_selection(1), ["--select-class=Abcdef"])
        self.assertEqual(supervisor.nunit_selection(1), ["--test=Abcdef"])
        self.assertEqual(supervisor.libtest_selection(1, ""),
                         ["--exact", "mAbcdef::tAbcdef", "zzzz_moodit_jeton::zzzz_jeton"])

    def test_nom_de_type_echappe_dans_la_regex_junit(self):
        # Un point de nom qualifié ne doit pas devenir un joker de regex.
        supervisor.STUDENT_TYPES[0] = ["devoir.un.Solution"]
        self.assertEqual(supervisor.junit_selection(0),
                         ["--scan-class-path", "--exclude-classname=^devoir\\.un\\.Solution$"])


class TokenExitCodeTest(unittest.TestCase):
    """Le verdict des langages à enveloppe se lit SUR LA LIGNE DU JETON. Les deux autres
    canaux sont sous le contrôle de l'étudiant APRÈS les tests : le rapport du framework vit
    sous work/ (possédé par l'étudiant) et le code de sortie du processus s'écrase après coup
    (hook d'arrêt). Une ligne déjà écrite sur stdout, non."""

    def setUp(self):
        supervisor.TOKENS.clear()
        supervisor.TOKENS[0] = "4242424242424"

    def test_code_lu_sur_la_ligne_du_jeton(self):
        out = "…\n[MOODIT] jeton=4242424242424 code=0\n"
        self.assertEqual(supervisor.token_exit_code(out, 0), 0)
        out = "…\n[MOODIT] jeton=4242424242424 code=1\n"
        self.assertEqual(supervisor.token_exit_code(out, 0), 1)

    def test_ligne_absente_aucun_verdict(self):
        # Jeton non atteint (exit forgé avant la fin) : pas de code → jamais « réussi ».
        self.assertIsNone(supervisor.token_exit_code("rien du tout", 0))
        # Jeton présent mais SANS code : l'ancienne forme ne vaut pas un verdict.
        self.assertIsNone(supervisor.token_exit_code("[MOODIT] jeton=4242424242424\n", 0))

    def test_plusieurs_lignes_de_jeton_refusees(self):
        # L'enveloppe n'en imprime qu'UNE : plusieurs = une autre vient du code note, donc le
        # jeton a fuite. On ne choisit pas entre elles (ni la premiere, ni la derniere) — on
        # refuse, et l'evenement dit pourquoi.
        supervisor.EVENTS.clear()
        out = ("[MOODIT] jeton=4242424242424 code=0\n"
               "[MOODIT] jeton=4242424242424 code=0\n")
        self.assertIsNone(supervisor.token_exit_code(out, 0))
        self.assertEqual([e["type"] for e in supervisor.EVENTS], ["jeton_duplique"])

    def test_jeton_d_un_autre_cas_ne_compte_pas(self):
        # Le jeton est tiré par cas : celui du voisin ne vaut pas verdict ici.
        self.assertIsNone(supervisor.token_exit_code("[MOODIT] jeton=9999999999999 code=0", 0))

    def test_code_non_nul_meme_si_le_reste_est_coherent(self):
        # Cœur du défaut corrigé : un rapport réécrit en « 0 échec » et un code de sortie
        # écrasé à 0 ne suffisent plus — le code publié par l'enveloppe, lui, reste à 1.
        out = "[MOODIT] jeton=4242424242424 code=1\n"
        self.assertNotEqual(supervisor.token_exit_code(out, 0), 0)


class RedactTokensTest(unittest.TestCase):
    """Aucun jeton dans le detail renvoye a l'appelant : quand le verdict echoue tot, le detail
    est bati sur les premieres lignes de sortie, et la ligne « [MOODIT] jeton=… code=… » s'y
    retrouvait telle quelle (constate en sondant un cas C#)."""

    def setUp(self):
        supervisor.TOKENS.clear()
        supervisor.TOKENS[0] = "6121964961777"
        supervisor.TOKENS[1] = "1234567890123"

    def test_jeton_retire_du_detail(self):
        self.assertEqual(
            supervisor.redact_tokens("[MOODIT] jeton=6121964961777 code=1"),
            "[MOODIT] jeton=… code=1")

    def test_jeton_d_un_autre_cas_retire_aussi(self):
        # Les cas partagent le meme conteneur : aucun de leurs jetons ne doit sortir.
        self.assertNotIn("1234567890123", supervisor.redact_tokens("fuite 1234567890123"))

    def test_detail_vide_inchange(self):
        self.assertIsNone(supervisor.redact_tokens(None))
        self.assertEqual(supervisor.redact_tokens(""), "")

    def test_detail_sans_jeton_inchange(self):
        self.assertEqual(supervisor.redact_tokens("expected: <12> but was: <0>"),
                         "expected: <12> but was: <0>")


class TokenExitCodeEitherTest(unittest.TestCase):
    """L'enveloppe publie son verdict sur les DEUX descripteurs bruts (1 et 2).

    Defaut corrige : un etudiant honnete qui ferme System.out — `try (PrintWriter w = new
    PrintWriter(System.out))`, idiome de premiere annee — fermait FileDescriptor.out, donc le
    fd 1 du processus, donc le flux brut de l'enveloppe. La ligne de verdict disparaissait, le
    rapport XML restait correct, et une REPONSE JUSTE recevait « ⚠ jeton_absent » : une
    accusation de triche. Mesure faite contre un vrai conteneur avant correctif."""

    JETON = "4242424242424"
    LIGNE = "[MOODIT] jeton=4242424242424 code=0"

    def setUp(self):
        supervisor.TOKENS.clear()
        supervisor.TOKENS[0] = self.JETON
        supervisor.EVENTS.clear()

    def test_stdout_prioritaire(self):
        self.assertEqual(supervisor.token_exit_code_either(self.LIGNE, "", 0), 0)

    def test_repli_sur_stderr_si_stdout_est_ferme(self):
        # Le cas honnete : stdout ferme par le code note, stderr intact.
        self.assertEqual(supervisor.token_exit_code_either("", self.LIGNE, 0), 0)

    def test_les_deux_flux_ne_valent_pas_un_doublon(self):
        # Normal : la MEME ligne sur les deux flux. Ce n'est pas une fuite de jeton.
        self.assertEqual(supervisor.token_exit_code_either(self.LIGNE, self.LIGNE, 0), 0)
        self.assertEqual(supervisor.EVENTS, [])

    def test_doublon_sur_stdout_ne_se_rattrape_pas_sur_stderr(self):
        # Sinon il suffisait de dupliquer la ligne sur stdout pour faire ignorer le refus et
        # se faire noter sur celle de stderr.
        double = self.LIGNE + "\n" + self.LIGNE + "\n"
        self.assertIsNone(supervisor.token_exit_code_either(double, self.LIGNE, 0))
        self.assertEqual([e["type"] for e in supervisor.EVENTS], ["jeton_duplique"])

    def test_aucune_ligne_aucun_code(self):
        self.assertIsNone(supervisor.token_exit_code_either("rien", "rien", 0))


class CSummaryTest(unittest.TestCase):
    """C/C++ : seul un sommaire PORTEUR DU JETON compte, et il doit etre UNIQUE.

    Defaut corrige : le superviseur retenait le PREMIER sommaire trouve par re.search. Le code
    note imprimait donc, depuis la fonction notee (jamais appelee dans un cas canari, donc
    discrimination parfaite), un faux « summary total=1 failed=0 », posait un atexit() qui sort
    en 0, et LAISSAIT le framework finir : le vrai sommaire et le VRAI jeton etaient bien
    imprimes ensuite, enforce_token etait satisfait, et le cas passait au vert sur une reponse
    fausse, sans aucun evenement."""

    JETON = "7777777777777"

    def test_sommaire_porteur_du_jeton_compte(self):
        out = "[MOODIT] summary jeton=%s total=3 failed=0\n" % self.JETON
        self.assertEqual(supervisor.c_summary(out, self.JETON), (3, 0, False, [(3, 0)]))

    def test_doublon_distingue_de_rien_trouve(self):
        # Les deux cas renvoyaient (None, None, True) : indistinguables. c_family traitait donc
        # un DOUBLON comme un « rien sur stdout » et se rabattait sur stderr — ou le sommaire
        # authentique vit aussi, puisque moodit_check.h publie sur les deux flux. Dupliquer la
        # ligne sur stdout suffisait a faire annuler le refus.
        double = ("[MOODIT] summary jeton=%s total=1 failed=0\n"
                  "[MOODIT] summary jeton=%s total=1 failed=1\n" % (self.JETON, self.JETON))
        # `forge` reste FAUX : aucun sommaire sans jeton n'a ete vu, seulement deux
        # authentifies. Les confondre faisait libeller un refus honnete « sommaire forge ».
        self.assertEqual(supervisor.c_summary(double, self.JETON),
                         (None, None, False, [(1, 0), (1, 1)]))
        vide = supervisor.c_summary("rien", self.JETON)
        self.assertEqual(vide, (None, None, False, []))
        self.assertEqual(len(vide[3]), 0)   # « rien trouve » n'est PAS un doublon

    def test_sommaire_sans_jeton_ne_compte_pas_et_est_signale(self):
        # L'exploit exact : faux sommaire d'abord, vrai sommaire ensuite.
        out = ("[MOODIT] summary total=1 failed=0\n"
               "[MOODIT] fail aire (harness.c:12) attendu 12\n"
               "[MOODIT] summary jeton=%s total=1 failed=1\n"
               "[MOODIT] jeton=%s\n" % (self.JETON, self.JETON))
        total, failed, forge, sommaires = supervisor.c_summary(out, self.JETON)
        # Le sommaire AUTHENTIQUE est celui qui compte : un echec, donc pas de vert.
        self.assertEqual((total, failed), (1, 1))
        self.assertTrue(forge)
        self.assertEqual(len(sommaires), 1)

    def test_faux_sommaire_seul_ne_vaut_aucun_verdict(self):
        out = "[MOODIT] summary total=5 failed=0\n"
        self.assertEqual(supervisor.c_summary(out, self.JETON), (None, None, True, []))

    def test_deux_sommaires_authentiques_refuses(self):
        # Le framework n'en imprime qu'un PAR FLUX : deux = aucun verdict. La liste rendue sert
        # a distinguer « aucun sommaire → tenter l'autre flux » de « plusieurs → refus SANS
        # repli », rien d'autre. En particulier la CONCORDANCE des sommaires ne porte aucune
        # information de securite : l'enfant d'un fork() reprend la boucle avec son propre
        # etat, donc ses tests restants peuvent donner un autre `failed` que le parent. Ne pas
        # rebrancher d'accusation sur la divergence (c'etait un faux positif, cf. c_verdict).
        out = ("[MOODIT] summary jeton=%s total=1 failed=0\n"
               "[MOODIT] summary jeton=%s total=1 failed=1\n" % (self.JETON, self.JETON))
        self.assertEqual(supervisor.c_summary(out, self.JETON),
                         (None, None, False, [(1, 0), (1, 1)]))

    def test_jeton_d_un_autre_cas_ne_compte_pas(self):
        out = "[MOODIT] summary jeton=1111111111111 total=1 failed=0\n"
        self.assertEqual(supervisor.c_summary(out, self.JETON), (None, None, False, []))

    def test_sans_jeton_connu_aucun_verdict(self):
        out = "[MOODIT] summary jeton=%s total=1 failed=0\n" % self.JETON
        self.assertEqual(supervisor.c_summary(out, None), (None, None, False, []))


class CVerdictTest(unittest.TestCase):
    """Decision complete du chemin C/C++ : c'est ICI que vit la propriete de securite.

    Sans ces tests, remettre un repli sur stderr apres un doublon — l'exploit meme, puisque
    moodit_check.h publie le sommaire sur les DEUX flux — laissait toute la suite verte."""

    JETON = "7777777777777"

    def _sommaire(self, total, failed):
        return "[MOODIT] summary jeton=%s total=%d failed=%d\n" % (self.JETON, total, failed)

    def setUp(self):
        supervisor.EVENTS.clear()

    def test_sommaire_unique_sur_stdout(self):
        self.assertEqual(
            supervisor.c_verdict(self._sommaire(3, 0), "", self.JETON, 0), (3, 0, False, None))
        self.assertEqual(supervisor.EVENTS, [])

    def test_repli_sur_stderr_si_stdout_ferme(self):
        # fclose(stdout) d'un etudiant honnete : le verdict vit encore sur stderr.
        self.assertEqual(
            supervisor.c_verdict("", self._sommaire(2, 1), self.JETON, 0), (2, 1, False, None))
        self.assertEqual(supervisor.EVENTS, [])

    def test_doublon_divergent_refuse_sans_accuser_et_ne_se_replie_pas(self):
        # Deux sommaires qui ne disent pas la meme chose : on pourrait croire a une forge, mais
        # l'enfant d'un fork() reprend la boucle avec son PROPRE etat, donc ses tests restants
        # peuvent donner un autre `failed` que le parent. La divergence n'est pas une preuve :
        # refus, pas d'accusation. Et SURTOUT pas de repli sur le sommaire authentique de stderr
        # (c'etait la faille : dupliquer sur stdout annulait le refus).
        stdout = self._sommaire(1, 0) + self._sommaire(1, 1)
        total, failed, _, incident = supervisor.c_verdict(
            stdout, self._sommaire(1, 1), self.JETON, 2)
        self.assertEqual((total, failed), (None, None))
        self.assertEqual(incident, "sommaire_duplique")
        self.assertEqual([e["type"] for e in supervisor.EVENTS], ["sommaire_duplique"])
        self.assertEqual(supervisor.EVENTS[0]["case"], 2)

    def test_doublon_concordant_refuse_sans_accuser(self):
        # FAUX POSITIF a eviter : moodit_check.h imprime le sommaire APRES la boucle de tests,
        # donc un fork() dans la fonction notee dont l'enfant revient normalement poursuit la
        # boucle et imprime SON sommaire — identique. Code honnete (exercice sur les appels
        # systeme) : le cas echoue, mais sans bandeau de falsification.
        stdout = self._sommaire(2, 0) + self._sommaire(2, 0)
        total, failed, forge, incident = supervisor.c_verdict(stdout, "", self.JETON, 1)
        # `forge` garde son sens strict : aucun sommaire SANS jeton n'a ete vu. L'y agreger
        # faisait libeller ce refus honnete « sommaire forge (jeton absent) » dans les journaux.
        self.assertFalse(forge)
        self.assertEqual(incident, "sommaire_duplique")
        self.assertEqual((total, failed), (None, None))
        self.assertEqual([e["type"] for e in supervisor.EVENTS], ["sommaire_duplique"])
        self.assertEqual(supervisor.EVENTS[0]["case"], 1)   # rattache au cas, sans accuser

    def test_doublon_sur_stderr_aussi_refuse(self):
        total, failed, _, incident = supervisor.c_verdict(
            "", self._sommaire(1, 0) + self._sommaire(1, 1), self.JETON, 0)
        self.assertEqual((total, failed), (None, None))
        self.assertEqual(incident, "sommaire_duplique")
        self.assertEqual([e["type"] for e in supervisor.EVENTS], ["sommaire_duplique"])

    def test_faux_sommaire_sans_jeton_ni_verdict_ni_accusation(self):
        total, failed, forge, incident = supervisor.c_verdict(
            "[MOODIT] summary total=1 failed=0\n", "", self.JETON, 0)
        self.assertEqual((total, failed), (None, None))
        self.assertTrue(forge)          # un sommaire SANS jeton, lui, est bien un faux
        self.assertIsNone(incident)
        self.assertEqual(supervisor.EVENTS, [])


class DrainPipeTest(unittest.TestCase):
    """Les sorties passent par des tubes recopies par ROOT : le processus execute ne tient
    aucun descripteur sur le fichier que le superviseur relit. Un fichier regulier passe
    directement en stdout lui en donnait un, positionnable — donc reecrivable apres coup."""

    def test_recopie_integrale_sous_le_plafond(self):
        src, dst = io.BytesIO(b"ligne 1\nligne 2\n"), io.BytesIO()
        supervisor.drain_pipe(src, dst, cap=1024)
        self.assertEqual(dst.getvalue(), b"ligne 1\nligne 2\n")

    def test_queue_preservee_au_dela_du_plafond(self):
        # TOUS les canaux de verdict sont en FIN de sortie (ligne du jeton, sommaire du
        # framework). N'ecrire que la tete les perdait : une copie honnete mais bavarde
        # devenait « jeton absent », soit une FAUSSE ACCUSATION de triche. Miroir de
        # read_capped, qui garde tete + queue pour exactement cette raison.
        supervisor.TOKENS[0] = "4242424242424"
        verdict = b"[MOODIT] jeton=4242424242424 code=0\n"
        bavard = (b"B" * 49 + b"\n") * 100            # 5000 octets, en lignes
        src, dst = io.BytesIO(bavard + verdict), io.BytesIO()
        supervisor.drain_pipe(src, dst, cap=100, tail_bytes=256)
        sortie = dst.getvalue()
        self.assertIn(verdict, sortie)                  # la queue porteuse du verdict
        self.assertTrue(sortie.startswith(b"B" * 49 + b"\n"))   # tete alignee
        self.assertIn("tronquée au milieu".encode("utf-8"), sortie)
        # Le total compte TOUT ce qui est passe par le tube, pas seulement la tete ecrite.
        self.assertIn(b"5036 octets", sortie)
        self.assertEqual(supervisor.token_exit_code(
            sortie.decode("utf-8"), 0), 0)                   # le verdict reste lisible

    def test_ligne_du_jeton_a_cheval_sur_le_plafond_reste_lisible(self):
        # Le plafond tombe AU MILIEU de la ligne du jeton : couper la tete a l'octet pres
        # scindait cette ligne en deux autour du marqueur, token_exit_code ne la reconnaissait
        # plus et le cas recoltait « jeton absent » — fausse accusation sur une soumission
        # honnete. La tete doit donc etre coupee sur une FIN DE LIGNE.
        supervisor.TOKENS[0] = "4242424242424"
        verdict = b"[MOODIT] jeton=4242424242424 code=0\n"
        tete = b"bavard\n" * 10                      # 70 octets
        src, dst = io.BytesIO(tete + verdict), io.BytesIO()
        # Plafond tombant 12 octets apres le debut de la ligne de verdict.
        supervisor.drain_pipe(src, dst, cap=len(tete) + 12, tail_bytes=512)
        self.assertEqual(supervisor.token_exit_code(
            dst.getvalue().decode("utf-8"), 0), 0)

    def test_tete_collante_la_fin_de_sortie_reste_dans_la_queue(self):
        # La coupe sur fin de ligne laisse written < cap. Sans verrou, un bloc suivant
        # assez court repartait dans la tete : le DERNIER bloc, celui qui porte la ligne
        # du jeton, s y retrouvait AVANT le marqueur — hors de la fenetre relue par
        # read_capped — et le cas recoltait « jeton absent » sur un code honnete.
        supervisor.TOKENS[0] = "4242424242424"
        verdict = b"[MOODIT] jeton=4242424242424 code=0\n"
        # Exactement un bloc de lecture (65536 o) de lignes, puis le verdict seul.
        corps = (b"z" * 63 + b"\n") * 1024
        src, dst = io.BytesIO(corps + verdict), io.BytesIO()
        supervisor.drain_pipe(src, dst, cap=100, tail_bytes=4096)
        sortie = dst.getvalue()
        marqueur = "tronquée au milieu".encode("utf-8")
        self.assertIn(marqueur, sortie)
        self.assertIn(verdict, sortie)
        # L ORDRE est le point du test : le verdict doit etre APRES le marqueur.
        self.assertLess(sortie.index(marqueur), sortie.index(verdict))
        self.assertEqual(supervisor.token_exit_code(
            sortie.decode("utf-8"), 0), 0)

    def test_saturation_a_la_fermeture_ne_fait_pas_echouer_run_proc(self):
        # CPython garde les octets en tampon quand flush() echoue : le close() implicite
        # du `with` relevait la MEME OSError apres le flush garde, remplacait la valeur de
        # retour et devenait « Erreur interne du noteur » — et sur un canari une
        # accusation de falsification pour une simple saturation de /box.
        class FichierSature(io.BytesIO):
            def close(self):
                raise OSError(28, "No space left on device")

        origine = supervisor.open_output
        supervisor.open_output = lambda chemin: FichierSature()
        supervisor.EVENTS.clear()
        try:
            code, expire = supervisor.run_proc(
                ["true"], ".", dict(os.environ), 10, "o.out", "e.err", None)
        finally:
            supervisor.open_output = origine
        self.assertEqual((code, expire), (0, False))
        self.assertEqual([e["type"] for e in supervisor.EVENTS], ["espace_sature"])

    def test_erreur_d_ecriture_ne_ferme_pas_le_tube(self):
        # Fermer le tube tuerait le processus note par SIGPIPE, et cesser de lire le bloquerait.
        # Un tmpfs sature doit donc faire perdre la SORTIE, pas tuer le cas.
        class DestinationSaturee(io.BytesIO):
            def write(self, donnees):
                raise OSError(28, "No space left on device")

        src = io.BytesIO(b"x" * 4096)
        etat = supervisor.EtatSortie(case_index=7)
        supervisor.drain_pipe(src, DestinationSaturee(), cap=1024, etat=etat)
        # La perte est ENREGISTREE : c'est elle qui empechera d'accuser le cas.
        self.assertTrue(etat.perdue)
        # Le tube reste OUVERT : le fermer tuerait le processus note par SIGPIPE. (L'ancienne
        # forme, `assertTrue(src.closed is False or True)`, etait une tautologie : elle passait
        # meme si drain_pipe fermait le tube.)
        self.assertFalse(src.closed)
        self.assertEqual(src.read(), b"")              # tout a ete lu jusqu'a l'EOF

    def test_plafond_respecte_mais_lecture_poursuivie(self):
        # Le fichier est maintenant ecrit par root, que la rlimit de l'etudiant ne borne pas :
        # le plafond doit etre ici. Et il faut continuer de LIRE, sinon le tube se remplit et
        # le processus se bloque.
        class SourceComptee(io.BytesIO):
            lus = 0

            def read(self, taille=-1):
                bloc = super().read(taille)
                SourceComptee.lus += len(bloc)
                return bloc

        src, dst = SourceComptee((b"A" * 49 + b"\n") * 100), io.BytesIO()
        supervisor.drain_pipe(src, dst, cap=100, tail_bytes=64)
        self.assertTrue(dst.getvalue().startswith(b"A" * 49 + b"\n"))
        self.assertEqual(SourceComptee.lus, 5000)       # lue jusqu au bout
        # Ecrit = tete + marqueur + queue bornee, et JAMAIS les 5000 octets.
        self.assertLess(len(dst.getvalue()), 300)
        # La pompe ne ferme PLUS le tube (SIGPIPE) : c'est run_proc qui s'en charge
        # une fois le processus mort et les pompes jointes.
        self.assertFalse(src.closed)

    def test_fichier_deja_referme_ne_leve_pas(self):
        # L'appelant referme le fichier apres un join borne : une pompe en retard ne doit pas
        # faire remonter d'exception et tuer le job.
        src, dst = io.BytesIO(b"x" * 10), io.BytesIO()
        dst.close()
        supervisor.drain_pipe(src, dst, cap=1024)   # ne doit pas lever
        self.assertEqual(src.read(), b"")           # et la lecture va jusqu'a l'EOF


class ExecuteCaseSaturationTest(unittest.TestCase):
    """Marquage « non imputable » d'un cas touche par une saturation du tmpfs."""

    def setUp(self):
        self.dossier = tempfile.mkdtemp()
        self.box = supervisor.BOX
        supervisor.BOX = self.dossier
        self.runners = dict(supervisor.RUNNERS)
        self.base_env = supervisor.base_env
        supervisor.base_env = lambda case_dir: {"HOME": self.dossier,
                                                "TMPDIR": self.dossier}

    def tearDown(self):
        supervisor.BOX = self.box
        supervisor.RUNNERS.clear()
        supervisor.RUNNERS.update(self.runners)
        supervisor.base_env = self.base_env
        shutil.rmtree(self.dossier, ignore_errors=True)

    def _executer(self, issue, perdue):
        def faux_runner(case_dir, env, timeout_s, case_index):
            supervisor.ETAT_SORTIE.perdue = perdue
            return issue, None

        supervisor.RUNNERS["Java"] = faux_runner
        return supervisor.execute_case("Java", {"index": 0}, 10)[0]

    def test_cas_en_echec_devient_non_imputable_et_dit_la_cause(self):
        issue = self._executer(supervisor.CaseOutcome(
            False, "Échec du harnais JUnit", ran=True), perdue=True)
        self.assertTrue(issue.skipped)
        self.assertIn("saturé", issue.detail)

    def test_cas_reussi_n_est_pas_contredit(self):
        # « perdue » est pose des qu'UN des deux flux echoue, or le verdict a pu conclure
        # « reussi » sur un stdout intact. Un cas vert accompagne de « notation impossible »
        # etait un message contradictoire, qui imputait au code une panne du noteur.
        issue = self._executer(supervisor.CaseOutcome(True, None, ran=True), perdue=True)
        self.assertFalse(issue.skipped)
        self.assertIsNone(issue.detail)
        self.assertTrue(issue.passed)

    def test_mort_par_signal_remontee_sur_l_issue(self):
        def faux_runner(case_dir, env, timeout_s, case_index):
            supervisor.ETAT_SORTIE.tue_par_signal = True
            return supervisor.CaseOutcome(False, "echec", ran=True), None

        supervisor.RUNNERS["Java"] = faux_runner
        issue = supervisor.execute_case("Java", {"index": 0}, 10)[0]
        self.assertTrue(issue.killed)
        self.assertTrue(supervisor.inconclusive(issue))

    def test_sans_saturation_rien_ne_change(self):
        issue = self._executer(supervisor.CaseOutcome(
            False, "assertion ratee", ran=True), perdue=False)
        self.assertFalse(issue.skipped)
        self.assertEqual(issue.detail, "assertion ratee")


class EtatSortieTest(unittest.TestCase):
    """L'etat de capture est un OBJET PAR CAS, pas un drapeau global : les pompes peuvent
    survivre a leur run_proc, et un global aurait ete repositionne pendant le cas SUIVANT."""

    def test_une_pompe_retardataire_n_affecte_que_son_cas(self):
        etat_cas_1 = supervisor.EtatSortie(case_index=1)
        etat_cas_2 = supervisor.EtatSortie(case_index=2)
        # La pompe du cas 1, encore vivante, finit par echouer a ecrire.
        class DestinationFermee(io.BytesIO):
            def write(self, donnees):
                raise ValueError("I/O operation on closed file")

        # Le cas 2 est celui EN COURS (global) : c'est lui qui ne doit pas etre desarme.
        # (Auparavant l'assertion portait sur un objet jamais passe a drain_pipe, donc vraie
        # par construction, quoi que fasse le code.)
        supervisor.ETAT_SORTIE = etat_cas_2
        supervisor.drain_pipe(io.BytesIO(b"tardif\n"), DestinationFermee(),
                              cap=1024, etat=etat_cas_1)
        self.assertTrue(etat_cas_1.perdue)
        self.assertFalse(supervisor.ETAT_SORTIE.perdue)   # le cas en cours reste armé

    def test_run_proc_impute_la_perte_au_cas_capture_a_l_entree(self):
        # run_proc capture ETAT_SORTIE A L'ENTREE : si le cas SUIVANT remplace le global
        # pendant l'execution, une pompe retardataire doit continuer d'imputer sa perte au cas
        # qui l'a lancee. Aucun test ne couvrait cette capture.
        etat_pendant = supervisor.EtatSortie(case_index=1)
        supervisor.ETAT_SORTIE = etat_pendant

        class Sature(io.BytesIO):
            def write(self, donnees):
                # Le cas suivant a deja pris la main dans le global.
                supervisor.ETAT_SORTIE = supervisor.EtatSortie(case_index=2)
                raise OSError(28, "No space left on device")

        origine = supervisor.open_output
        supervisor.open_output = lambda chemin: Sature()
        try:
            supervisor.run_proc(["sh", "-c", "echo x"], ".", dict(os.environ), 10,
                                "o.out", "e.err", None)
        finally:
            supervisor.open_output = origine
        self.assertTrue(etat_pendant.perdue)               # impute au BON cas
        self.assertFalse(supervisor.ETAT_SORTIE.perdue)    # pas au cas suivant

    def test_sans_etat_aucune_erreur(self):
        # drain_pipe reste utilisable sans etat (compilation, mode exec).
        supervisor.drain_pipe(io.BytesIO(b"ok\n"), io.BytesIO(), cap=1024)


class ErreurInterneTest(unittest.TestCase):
    """Une defaillance du NOTEUR (tmpfs sature, fork impossible) ne doit jamais accuser :
    le cas echoue, mais marque skipped, donc non imputable."""

    def test_mort_par_signal_au_chargement_n_accuse_pas(self):
        # Un code qui PLANTE ou sature la memoire au CHARGEMENT fait echouer les canaris sans
        # les faire expirer : en Go et C/C++ le code etudiant partage leur unite de
        # compilation, donc son init()/constructeur global y tourne aussi. L'ancien garde-fou
        # n'acceptait que l'expiration, et accusait donc de triche.
        cases = [{"index": 0, "canary": "pass"}, {"index": 1, "canary": "fail"},
                 {"index": 2}]
        outcomes = {
            0: supervisor.CaseOutcome(False, "tue", ran=True, killed=True),
            1: supervisor.CaseOutcome(False, "tue", ran=True, killed=True),
            2: supervisor.CaseOutcome(False, "tue", ran=True, killed=True),
        }
        supervisor.EVENTS.clear()
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
        self.assertEqual(supervisor.EVENTS, [])

    def test_sans_aucun_cas_reel_jugeable_pas_d_accusation(self):
        # Les cas reels sont sautes AVANT les canaris (reserve de budget, saturation) : un code
        # honnete a compilation lente pouvait n'avoir plus que ses canaris, et se faire accuser
        # faute d'un cas reel pour l'exempter. Aucun cas reel jugeable = aucune preuve a charge.
        cases = [{"index": 0, "canary": "pass"}, {"index": 1, "canary": "fail"},
                 {"index": 2}, {"index": 3}]
        outcomes = {
            0: supervisor.CaseOutcome(False, "expire", ran=True, timed_out=True),
            1: supervisor.CaseOutcome(False, "expire", ran=True, timed_out=True),
            2: supervisor.CaseOutcome(False, "non execute", ran=False, skipped=True),
            3: supervisor.CaseOutcome(False, "non execute", ran=False, skipped=True),
        }
        supervisor.EVENTS.clear()
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
        self.assertEqual(supervisor.EVENTS, [])

    def test_canari_dont_la_compilation_est_tuee_n_accuse_pas(self):
        # Un canari dont la COMPILATION meurt par signal (OOM du cgroup) n'a pas ete sabote :
        # il n'a pas pu etre compile. L'ancienne branche accusait sur cette seule base.
        cases = [{"index": 0, "canary": "pass"}, {"index": 1, "canary": "fail"},
                 {"index": 2}]
        outcomes = {
            0: supervisor.CaseOutcome(False, "compilation tuee", ran=False, killed=True),
            1: supervisor.CaseOutcome(False, "compilation tuee", ran=False, killed=True),
            2: supervisor.CaseOutcome(True, None, ran=True),
        }
        supervisor.EVENTS.clear()
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
        self.assertEqual(supervisor.EVENTS, [])

    def test_compilation_des_seuls_canaris_cassee_reste_accusee(self):
        # La detection a NE PAS perdre : faire echouer la compilation des seuls canaris (p. ex.
        # par collision de nom de classe) est une falsification — la cause n'est pas un signal.
        cases = [{"index": 0, "canary": "pass"}, {"index": 1, "canary": "fail"},
                 {"index": 2}]
        outcomes = {
            0: supervisor.CaseOutcome(False, "classe dupliquee", ran=False),
            1: supervisor.CaseOutcome(False, "classe dupliquee", ran=False),
            2: supervisor.CaseOutcome(True, None, ran=True),
        }
        supervisor.EVENTS.clear()
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "incoherents")
        self.assertEqual([e["type"] for e in supervisor.EVENTS], ["canari_incoherent"])

    def test_un_canari_qui_contredit_accuse_meme_si_l_autre_n_a_pas_compile(self):
        # Angle mort de l'ancienne forme : elle jugeait par BRANCHE d'execution. Des qu'un
        # canari n'avait pas compile pour une cause non concluante, elle rendait
        # « indetermines » et jetait la preuve portee par l'AUTRE — ici la signature de
        # forgeage la plus franche (le canari « fail » ressort VERT), avec des cas reels verts
        # qui gardaient donc leurs points.
        cases = [{"index": 0, "canary": "pass"}, {"index": 1, "canary": "fail"},
                 {"index": 2}]
        outcomes = {
            0: supervisor.CaseOutcome(False, "compilation tuee", ran=False, killed=True),
            1: supervisor.CaseOutcome(True, None, ran=True),      # devait ECHOUER
            2: supervisor.CaseOutcome(True, None, ran=True),
        }
        supervisor.EVENTS.clear()
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "incoherents")
        self.assertEqual([e["type"] for e in supervisor.EVENTS], ["canari_incoherent"])

    def test_canari_gele_sans_cas_reel_vert_n_accuse_pas(self):
        # Autre angle mort : la condition portait sur « un cas reel a une cause non
        # concluante » au lieu de « un cas reel est VERT ». Un etudiant dont le code est
        # simplement FAUX — le cas le plus courant — bloquait donc l'exemption et se faisait
        # accuser quand un canari expirait par flottement de l'hote.
        cases = [{"index": 0, "canary": "pass"}, {"index": 1, "canary": "fail"},
                 {"index": 2}]
        outcomes = {
            0: supervisor.CaseOutcome(False, "expire", ran=True, timed_out=True),
            1: supervisor.CaseOutcome(False, "echoue comme prevu", ran=True),
            2: supervisor.CaseOutcome(False, "test faux", ran=True),   # honnetement rouge
        }
        supervisor.EVENTS.clear()
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
        self.assertEqual(supervisor.EVENTS, [])

    def test_aucun_canari_confirme_n_est_pas_ok(self):
        # « ok » ne doit etre rendu que si CHAQUE canari a ete confirme : sans cela, deux
        # canaris non compiles (cause non concluante) donnaient « ok », donc une verification
        # proclamee alors que rien n'avait ete verifie.
        cases = [{"index": 0, "canary": "pass"}, {"index": 1, "canary": "fail"},
                 {"index": 2}]
        outcomes = {
            0: supervisor.CaseOutcome(False, "compilation tuee", ran=False, killed=True),
            1: supervisor.CaseOutcome(False, "compilation tuee", ran=False, killed=True),
            2: supervisor.CaseOutcome(False, "non compile", ran=False),
        }
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")

    def test_panique_au_chargement_n_accuse_pas(self):
        # Une panique Go au chargement sort avec le STATUT 2 : ni expiration, ni signal, donc
        # l'ancienne forme y voyait une cause « concluante » et accusait — alors que le code
        # etudiant partage le package du canari, si bien que TOUS les cas plantent pareil. Le
        # critere est desormais unique : sans cas reel VERT, l'etudiant n'y gagne rien.
        cases = [{"index": 0, "canary": "pass"}, {"index": 1, "canary": "fail"},
                 {"index": 2}]
        outcomes = {
            0: supervisor.CaseOutcome(False, "panic: nil map", ran=True),
            1: supervisor.CaseOutcome(False, "panic: nil map", ran=True),
            2: supervisor.CaseOutcome(False, "panic: nil map", ran=True),
        }
        supervisor.EVENTS.clear()
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
        self.assertEqual(supervisor.EVENTS, [])

    def test_compilation_expiree_est_une_cause_non_concluante(self):
        # Les runners rapportent une compilation expiree en simple « Echec de compilation »,
        # donc sans timed_out : un code lent a compiler (gros templates C++) dont le canari
        # franchit la limite par flottement de l'hote passait pour un sabotage.
        def faux_runner(case_dir, env, timeout_s, case_index):
            supervisor.ETAT_SORTIE.expire = True
            return supervisor.CaseOutcome(False, "Échec de compilation", ran=False), None

        runners = dict(supervisor.RUNNERS)
        base_env = supervisor.base_env
        box = supervisor.BOX
        dossier = tempfile.mkdtemp()
        supervisor.BOX = dossier
        supervisor.base_env = lambda case_dir: {"HOME": dossier, "TMPDIR": dossier}
        supervisor.RUNNERS["Java"] = faux_runner
        try:
            issue = supervisor.execute_case("Java", {"index": 0}, 10)[0]
        finally:
            supervisor.BOX = box
            supervisor.base_env = base_env
            supervisor.RUNNERS.clear()
            supervisor.RUNNERS.update(runners)
            shutil.rmtree(dossier, ignore_errors=True)
        self.assertTrue(issue.timed_out)
        self.assertTrue(supervisor.inconclusive(issue))

    def test_gel_selectif_des_canaris_reste_accuse(self):
        # La detection que le garde-fou ne doit PAS perdre : geler les seuls canaris en
        # laissant les cas reels verts. Aucun cas reel n'a de cause non concluante, donc
        # l'exemption ne s'applique pas.
        cases = [{"index": 0, "canary": "pass"}, {"index": 1, "canary": "fail"},
                 {"index": 2}]
        outcomes = {
            0: supervisor.CaseOutcome(False, "expire", ran=True, timed_out=True),
            1: supervisor.CaseOutcome(False, "expire", ran=True, timed_out=True),
            2: supervisor.CaseOutcome(True, None, ran=True),      # cas reel « reussi »
        }
        supervisor.EVENTS.clear()
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "incoherents")
        self.assertEqual([e["type"] for e in supervisor.EVENTS], ["canari_incoherent"])

    def test_cause_non_concluante(self):
        self.assertTrue(supervisor.inconclusive(
            supervisor.CaseOutcome(False, timed_out=True)))
        self.assertTrue(supervisor.inconclusive(
            supervisor.CaseOutcome(False, killed=True)))
        self.assertFalse(supervisor.inconclusive(
            supervisor.CaseOutcome(False, "assertion ratee")))

    def test_tout_a_expire_n_accuse_pas_meme_avec_un_cas_non_imputable(self):
        # Un code qui se bloque au CHARGEMENT fait expirer tous les cas, canaris compris : le
        # canari « pass » contredit alors son attendu sans qu'il y ait falsification (un
        # sabotage qui gele tout tue aussi les cas reels, aucun gain). Le garde-fou doit
        # ignorer les cas NON IMPUTABLES, qui ont timed_out=False par construction : sinon un
        # seul cas saute faute de budget suffisait a retomber sur l'accusation.
        cases = [{"index": 0, "canary": "pass"}, {"index": 1, "canary": "fail"},
                 {"index": 2}, {"index": 3}]
        outcomes = {
            0: supervisor.CaseOutcome(False, "expire", ran=True, timed_out=True),
            1: supervisor.CaseOutcome(False, "expire", ran=True, timed_out=True),
            2: supervisor.CaseOutcome(False, "expire", ran=True, timed_out=True),
            # Dernier cas SAUTE faute de budget : ni tente, ni fautif.
            3: supervisor.CaseOutcome(False, "non execute", ran=False, skipped=True),
        }
        supervisor.EVENTS.clear()
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
        self.assertEqual(supervisor.EVENTS, [])

    def test_un_canari_sature_ne_desarme_pas_l_autre(self):
        # Renoncer a juger des que UN SEUL canari est non imputable laissait passer un
        # forgeage de l'autre, et sur TOUTE la soumission. Les non imputables sont ecartes,
        # ceux qui restent sont juges.
        cases = [{"index": 0, "canary": "pass"}, {"index": 1, "canary": "fail"},
                 {"index": 2}]
        outcomes = {
            0: supervisor.CaseOutcome(False, "sature", ran=True, skipped=True),
            # Le canari « fail » REUSSIT : contraire a l'attendu, donc forgeage.
            1: supervisor.CaseOutcome(True, None, ran=True),
            2: supervisor.CaseOutcome(True, None, ran=True),
        }
        supervisor.EVENTS.clear()
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "incoherents")
        self.assertEqual([e["type"] for e in supervisor.EVENTS], ["canari_incoherent"])

    def test_tous_les_canaris_non_imputables_donnent_indetermines(self):
        cases = [{"index": 0, "canary": "pass"}, {"index": 1, "canary": "fail"},
                 {"index": 2}]
        outcomes = {
            0: supervisor.CaseOutcome(False, "sature", ran=True, skipped=True),
            1: supervisor.CaseOutcome(False, "sature", ran=True, skipped=True),
            2: supervisor.CaseOutcome(True, None, ran=True),
        }
        supervisor.EVENTS.clear()
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
        self.assertEqual(supervisor.EVENTS, [])

    def test_canari_sature_donne_indetermines(self):
        # Une saturation du tmpfs pendant un CANARI le faisait echouer, et canary_verdict
        # concluait « incoherents » → bandeau « falsification probable » et mise a zero de
        # toute la soumission, pour un disque plein. Marquee skipped, elle n'accuse plus.
        cases = [{"index": 0, "canary": "pass"}, {"index": 1, "canary": "fail"},
                 {"index": 2}]
        outcomes = {
            0: supervisor.CaseOutcome(False, "Échec du harnais (sortie incomplète)",
                                      ran=True, skipped=True),
            1: supervisor.CaseOutcome(False, "echoue comme prevu", ran=True),
            2: supervisor.CaseOutcome(True, None, ran=True),
        }
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")

    def test_canari_en_erreur_interne_donne_indetermines(self):
        cases = [{"index": 0, "canary": "pass"}, {"index": 1, "canary": "fail"},
                 {"index": 2}]
        # Le canari 0 tombe sur une erreur interne : ran=False, skipped=True.
        outcomes = {
            0: supervisor.CaseOutcome(False, "Erreur interne du noteur",
                                      ran=False, skipped=True),
            1: supervisor.CaseOutcome(False, "echoue comme prevu", ran=True),
            2: supervisor.CaseOutcome(True, None, ran=True),
        }
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
        # Sans le marquage, le meme cas passait par « incoherents » → falsification probable.
        outcomes[0] = supervisor.CaseOutcome(False, "Erreur interne du noteur", ran=False)
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "incoherents")


class WrapperVerdictTest(unittest.TestCase):
    """Verdict des langages a enveloppe (Java, C#, Go) : il ne tient qu'au code publie sur la
    ligne du jeton, et l'absence de cette ligne reste SIGNALEE au prof."""

    def setUp(self):
        supervisor.EVENTS.clear()

    def test_code_zero_et_reste_coherent_reussi(self):
        self.assertEqual(supervisor.wrapper_verdict(0, True, "peu importe", 0), (True, None))

    def test_les_deux_codes_sont_exiges_ensemble(self):
        # Exiger les DEUX est strictement plus fort que l'un ou l'autre :
        # - le seul code de sortie laissait Java/C# forgeables (halt(0) dans un hook d'arret) ;
        # - la seule ligne du jeton affaiblissait Go, ou tout le verdict vient alors de stdout,
        #   reecrivable en vol depuis un init() qui reassigne os.Stdout — sans connaitre le
        #   jeton. Le code de sortie Go, lui, n'est pas remplacable.
        self.assertEqual(supervisor.wrapper_verdict(0, True, "x", 0, exit_code=0), (True, None))
        # Ligne du jeton a 0 mais processus sorti autrement : refuse.
        passed, _ = supervisor.wrapper_verdict(0, True, "x", 0, exit_code=1)
        self.assertFalse(passed)
        # Processus sorti a 0 mais code publie non nul : refuse aussi.
        passed, _ = supervisor.wrapper_verdict(1, True, "x", 0, exit_code=0)
        self.assertFalse(passed)

    def test_code_non_nul_echoue_avec_le_detail(self):
        passed, detail = supervisor.wrapper_verdict(1, True, "assertion ratee", 0)
        self.assertFalse(passed)
        self.assertEqual(detail, "assertion ratee")
        self.assertEqual(supervisor.EVENTS, [])

    def test_ligne_absente_mais_reste_coherent_signale(self):
        # Sortie forgee avant la fin : rapport credible, mais pas de ligne de jeton. Le cas
        # echoue ET l'evenement est leve — sans quoi le prof ne verrait qu'un echec ordinaire.
        passed, detail = supervisor.wrapper_verdict(None, True, "ignore", 3, exit_code=0)
        self.assertFalse(passed)
        self.assertIn("jeton", detail)
        self.assertEqual([e["type"] for e in supervisor.EVENTS], ["jeton_absent"])
        self.assertEqual(supervisor.EVENTS[0]["case"], 3)

    def test_sortie_perdue_n_accuse_pas(self):
        # Tmpfs sature : la ligne du jeton a pu ne jamais etre ECRITE alors que le rapport
        # sous work/ l etait deja. Java et C# tirent leur « looked_ok » de ce rapport, donc
        # tout semblait credible sauf le jeton — et le cas recoltait « jeton absent », une
        # accusation de forgeage pour une saturation. Dans le doute, on n accuse pas.
        passed, detail = supervisor.wrapper_verdict(None, True, "x", 0, exit_code=0,
                                                   sortie_perdue=True)
        self.assertFalse(passed)
        self.assertEqual(supervisor.EVENTS, [])
        # Sans saturation, la meme forme reste la signature du forgeage : on accuse.
        passed, _ = supervisor.wrapper_verdict(None, True, "x", 0, exit_code=0,
                                               sortie_perdue=False)
        self.assertFalse(passed)
        self.assertEqual([e["type"] for e in supervisor.EVENTS], ["jeton_absent"])

    def test_mort_anormale_apres_les_tests_n_accuse_pas(self):
        # Rapport credible, pas de ligne de jeton, mais le processus a ete TUE (OOM du cgroup,
        # SIGXFSZ, signal) : code de sortie non nul. Accuser de triche serait une fausse
        # accusation sur une soumission honnete — le cas echoue, sans evenement.
        passed, detail = supervisor.wrapper_verdict(None, True, "tue", 0, exit_code=137)
        self.assertFalse(passed)
        self.assertEqual(detail, "tue")
        self.assertEqual(supervisor.EVENTS, [])
        # Meme situation mais sorti a 0 : c'est la signature du forgeage, on accuse.
        passed, detail = supervisor.wrapper_verdict(None, True, "ignore", 0, exit_code=0)
        self.assertFalse(passed)
        self.assertEqual([e["type"] for e in supervisor.EVENTS], ["jeton_absent"])

    def test_ligne_absente_et_reste_incoherent_echec_ordinaire(self):
        # Rien de credible : echec simple, pas d'accusation de forgeage.
        passed, detail = supervisor.wrapper_verdict(None, False, "ne compile pas", 0)
        self.assertFalse(passed)
        self.assertEqual(detail, "ne compile pas")
        self.assertEqual(supervisor.EVENTS, [])


class HarnessRanTest(unittest.TestCase):
    """L'INVARIANT DE SÛRETÉ de la notation : un cas n'est réussi que si au moins un test du
    HARNAIS a réellement tourné. Un comptage anonyme ne suffisait pas — l'exclusion est bâtie
    sur un texte que l'étudiant contrôle, et dès qu'elle emportait le harnais, un seul test
    personnel survivant faisait noter « réussi » un code arbitrairement faux."""

    def test_un_test_du_harnais_a_tourne(self):
        self.assertTrue(supervisor.harness_ran(["Harnais", "MesTests"], ["Harnais"]))

    def test_seuls_les_tests_de_l_etudiant_ont_tourne(self):
        # Le cœur du défaut : des tests ont tourné, tous à l'étudiant, et ils passent.
        self.assertFalse(supervisor.harness_ran(["MesTests"], ["Harnais"]))

    def test_aucun_test_n_a_tourne(self):
        self.assertFalse(supervisor.harness_ran([], ["Harnais"]))

    def test_type_de_test_imbrique_appartient_au_harnais(self):
        # JUnit rapporte un @Nested « Harnais$Cas », NUnit « Harnais+Cas », alors que le
        # harnais ne déclare que « Harnais » au niveau racine. Sans tolérer l'imbrication,
        # l'invariant notait 0 TOUS les étudiants sur ce harnais pourtant légitime.
        self.assertEqual(supervisor.enclosing_type("Harnais$Cas"), "Harnais")
        self.assertEqual(supervisor.enclosing_type("Devoir.Harnais+Cas"), "Devoir.Harnais")
        self.assertTrue(supervisor.harness_ran(["Harnais$Cas"], ["Harnais"]))
        self.assertTrue(supervisor.harness_ran(["Devoir.Harnais+Cas"], ["Devoir.Harnais"]))
        # Tolérer l'imbrication ne rend pas l'invariant permissif pour autant.
        self.assertFalse(supervisor.harness_ran(["MesTests$Cas"], ["Harnais"]))

    def test_harnais_non_identifie_rien_a_verifier(self):
        # Extraction en échec : aucune exclusion n'est appliquée, donc le harnais a tourné.
        self.assertTrue(supervisor.harness_ran(["MesTests"], []))

    def test_modules_executes_lus_dans_la_sortie_libtest(self):
        out = ("running 2 tests\n"
               "test harnais::d ... ok\n"
               "test mes_tests::x ... FAILED\n"
               "test result: FAILED. 1 passed; 1 failed; 0 ignored\n")
        self.assertEqual(supervisor.libtest_ran_tests(out), ["harnais", "mes_tests"])
        self.assertTrue(supervisor.harness_ran(supervisor.libtest_ran_tests(out), ["harnais"]))


class CanaryReserveTest(unittest.TestCase):
    """Réserve de budget des canaris : bornée au tiers du budget. Non bornée, elle dépassait
    le budget lui-même sur un appel public (mur plafonné à 4 min) et AUCUN cas réel ne
    démarrait — le « Tester » du prof ne notait plus rien sur les six langages compilés."""

    def test_toujours_de_la_place_pour_des_cas_reels(self):
        # Toutes les combinaisons atteignables des deux chemins (public et interne).
        for budget_s in (60, 110, 119, 212, 230, 330, 616, 670, 720, 770, 779):
            for timeout_s in (1, 10, 30, 60):
                reserve = supervisor.canary_reserve_seconds(budget_s, timeout_s)
                self.assertGreater(budget_s - reserve, 0,
                                   "budget=%s timeout=%s" % (budget_s, timeout_s))
                self.assertGreaterEqual(reserve, 0)
                self.assertLessEqual(reserve, budget_s / 3.0 + 1e-9)

    def test_reserve_nulle_sans_budget(self):
        self.assertEqual(supervisor.canary_reserve_seconds(0, 10), 0.0)

    def test_pire_cas_retenu_quand_le_budget_est_large(self):
        # 2 × (10 + 90) = 200 s, bien en dessous du tiers d'un gros budget.
        self.assertEqual(supervisor.canary_reserve_seconds(3000, 10), 200.0)


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
            # MAJUSCULE en tête, impérativement : le canari Go s'appelle « Test<N> » et Go
            # exige une non-minuscule après « Test » (sinon la fonction n'est pas un test et
            # `go vet` la refuse) — une soumission Go honnête serait accusée de falsification.
            self.assertRegex(nom, r"^[A-Z][A-Za-z0-9_]*$")
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

    def test_lecture_par_le_chemin_du_binaire_detectee(self):
        # La branche « probes batis depuis binaries » n'etait couverte par aucun test (seul
        # /proc/self/exe l'etait) : c'est pourtant la voie directe.
        for ligne in ('openat(AT_FDCWD, "/box/cases/0/tests", O_RDONLY) = 3',
                      'openat(AT_FDCWD, "./tests", O_RDONLY) = 4',
                      'open("tests", O_RDONLY) = 5'):
            supervisor.EVENTS.clear()
            path = self._trace([ligne])
            try:
                supervisor.scan_trace(path, "/box/cases/0/src", 0,
                                      binaries=("/box/cases/0/tests",))
                self.assertEqual([e["type"] for e in supervisor.EVENTS],
                                 ["lecture_binaire_tentee"], ligne)
            finally:
                os.unlink(path)

    def test_fichier_homonyme_cree_par_une_soumission_honnete_n_accuse_pas(self):
        # FAUSSE ACCUSATION corrigee : le basename du binaire est generique (« tests »), et
        # l'accusation se faisait sur une SOUS-CHAINE, sans regarder le resultat de l'appel. Un
        # etudiant qui ecrit un fichier nomme `tests` (refuse : case_dir est root) portait donc
        # la banniere « Comportement suspect detecte » et voyait son cas refuse.
        for ligne in ('openat(AT_FDCWD, "tests", O_WRONLY|O_CREAT|O_TRUNC, 0666) = -1 EACCES '
                      '(Permission denied)',
                      'openat(AT_FDCWD, "./tests", O_RDONLY) = -1 ENOENT (No such file)',
                      'readlink("/proc/self/exe", "/box/cases/0/tests", 4096) = 20'):
            supervisor.EVENTS.clear()
            path = self._trace([ligne])
            try:
                supervisor.scan_trace(path, "/box/cases/0/src", 0,
                                      binaries=("/box/cases/0/tests",))
                self.assertEqual(supervisor.EVENTS, [], ligne)
            finally:
                os.unlink(path)

    def test_trace_read_ok_distingue_lecture_reussie(self):
        self.assertTrue(supervisor.trace_read_ok('openat(AT_FDCWD, "x", O_RDONLY) = 3'))
        self.assertFalse(supervisor.trace_read_ok(
            'openat(AT_FDCWD, "x", O_RDONLY) = -1 EACCES (Permission denied)'))
        self.assertFalse(supervisor.trace_read_ok(
            'openat(AT_FDCWD, "x", O_WRONLY|O_CREAT, 0666) = 3'))
        self.assertFalse(supervisor.trace_read_ok('readlink("/proc/self/exe", "x", 4096) = 9'))


class ApiObjetTest(unittest.TestCase):
    """Lecture de l'API OBJET du code soumis, pour la notation NON FALSIFIABLE.

    Ce sont des fonctions pures, et c'est là que les erreurs coûtent le plus cher : une API mal
    lue, et le harnais du prof ne compile pas (ou, pire, un objet n'est pas proxifié)."""

    GO = ("package main\n\n"
          "type Rectangle struct {\n\tlargeur int\n\thauteur int\n}\n\n"
          "func NewRectangle(l int, h int) Rectangle {\n"
          "\treturn Rectangle{largeur: l, hauteur: h}\n}\n\n"
          "func (r Rectangle) aire() int { return r.largeur * r.hauteur }\n")

    RUST = ("struct Rectangle {\n    largeur: i32,\n    hauteur: i32,\n}\n\n"
            "impl Rectangle {\n"
            "    fn new(l: i32, h: i32) -> Rectangle {\n"
            "        Rectangle { largeur: l, hauteur: h }\n    }\n\n"
            "    fn aire(&self) -> i32 {\n        self.largeur * self.hauteur\n    }\n}\n")

    CPP = ("class Rectangle {\n    int largeur, hauteur;\npublic:\n"
           "    Rectangle(int largeur, int hauteur) : largeur(largeur), hauteur(hauteur) {}\n"
           "    int aire() { return largeur * hauteur; }\nprivate:\n"
           "    int secret() { return 1; }\n};\n\n"
           "int doubler(int n) { return n * 2; }\n")

    def test_go_champs_et_api(self):
        self.assertEqual(supervisor.go_struct_fields(self.GO),
                         {"Rectangle": [("largeur", "int"), ("hauteur", "int")]})
        # Le dernier membre dit si le constructeur rend un POINTEUR : l'aiguillage doit le savoir
        # pour ne pas prendre l'adresse d'une adresse.
        self.assertEqual(supervisor.go_object_api(self.GO),
                         [("Rectangle", [("NewRectangle", ["int", "int"], False)],
                           [("int", "aire", [])])])

    def test_go_type_sans_constructeur_reste_proxifie(self):
        # L'idiome Go : pas de constructeur, un littéral à champs nommés. Refuser ce cas
        # écartait la forme que les profs écrivent (et celle du quiz de démo).
        sans_ctor = self.GO.replace(
            "func NewRectangle(l int, h int) Rectangle {\n"
            "\treturn Rectangle{largeur: l, hauteur: h}\n}\n\n", "")
        self.assertEqual(supervisor.go_object_api(sans_ctor),
                         [("Rectangle", [], [("int", "aire", [])])])

    def test_go_bouchon_capture_les_champs(self):
        objets = supervisor.go_object_api(self.GO)
        champs = supervisor.go_struct_fields(self.GO)
        bouchon = supervisor.go_object_stub(objets, champs)
        # Le bouchon MIROITE les champs (le harnais écrit son littéral habituel) et la méthode
        # construit l'objet CHEZ l'étudiant au moment de l'appel.
        self.assertIn("type Rectangle struct {\n    largeur int\n    hauteur int\n}", bouchon)
        self.assertIn('mooditNouvelle("Rectangle", []interface{}{o.largeur, o.hauteur})', bouchon)
        # La fonction-constructeur reste proxifiée, en relisant les champs du résultat.
        self.assertIn('mooditChamps("NewRectangle"', bouchon)

    def test_go_aiguillage_couvre_litteral_methode_et_constructeur(self):
        objets = supervisor.go_object_api(self.GO)
        champs = supervisor.go_struct_fields(self.GO)
        cas_new, cas_methode = supervisor.go_object_dispatch(objets, champs)
        self.assertIn('case "Rectangle":', cas_new)
        self.assertIn('case "NewRectangle":', cas_new)
        # La boucle des méthodes ne doit PAS être sautée pour un type à champs capturés : elle
        # l'était, et tout appel de méthode remontait « methode inconnue ».
        self.assertIn('case "Rectangle.aire":', cas_methode)

    def test_rust_champs_et_api(self):
        self.assertEqual(supervisor.rust_struct_fields(self.RUST),
                         {"Rectangle": [("largeur", "i32"), ("hauteur", "i32")]})
        self.assertEqual(supervisor.rust_object_api(self.RUST),
                         [("Rectangle", [("new", ["i32", "i32"])], [("i32", "aire", [])])])

    def test_rust_bouchon_et_aiguillage(self):
        objets = supervisor.rust_object_api(self.RUST)
        champs = supervisor.rust_struct_fields(self.RUST)
        bouchon = supervisor.rust_object_stub(objets, champs)
        self.assertIn("struct Rectangle {\n    largeur: i32,\n    hauteur: i32,\n}", bouchon)
        self.assertIn('"|new|Rectangle"', bouchon)
        piles, cas = supervisor.rust_object_dispatch(objets, champs)
        self.assertIn("let mut moodit_rectangle: Vec<Rectangle>", piles)
        self.assertIn('"new|Rectangle" =>', cas)
        self.assertIn('"new|new" =>', cas)
        self.assertIn('"method|Rectangle.aire" =>', cas)
        self.assertNotIn("unsafe", bouchon + piles + cas)

    def test_cpp_plages_de_classe_et_api(self):
        self.assertEqual(len(supervisor.cpp_class_spans(self.CPP)), 1)
        self.assertEqual(supervisor.cpp_object_api(self.CPP),
                         [("Rectangle", [["int", "int"]], [("int", "aire", [])])])

    def test_cpp_methode_privee_ecartee(self):
        _, _, methodes = supervisor.cpp_object_api(self.CPP)[0]
        self.assertEqual([n for _, n, _ in methodes], ["aire"])

    def test_cpp_methode_nest_pas_prise_pour_une_fonction_libre(self):
        # Sans ce filtre, `int aire()` passait pour une fonction de premier niveau et le bouchon
        # généré appelait `aire()` sans objet : le code soumis ne compilait plus.
        self.assertEqual(supervisor.c_signatures(self.CPP, cpp=True),
                         [("int", "doubler", ["int"])])
        self.assertIn(("int", "aire", []), supervisor.c_signatures(self.CPP))

    def test_cpp_bouchon_et_aiguillage(self):
        objets = supervisor.cpp_object_api(self.CPP)
        bouchon = supervisor.cpp_object_stub(objets)
        self.assertIn("class Rectangle {", bouchon)
        self.assertIn('"%s|new|Rectangle|%d|%d"', bouchon)
        piles, cas = supervisor.cpp_object_dispatch(objets)
        self.assertIn("static std::vector<Rectangle> moodit_objets_Rectangle;", piles)
        self.assertIn('strcmp(nom, "Rectangle.aire")', cas)

    def test_java_bouchon_quand_la_classe_publique_est_l_objet(self):
        # Classe publique `Rectangle`, AUCUNE méthode statique : le bouchon de premier niveau
        # doit porter le constructeur et les méthodes, sinon la question était refusée.
        source = supervisor.java_stub_source(
            "Rectangle", [], (), [["int", "int"]], [("int", "aire", [])])
        self.assertIn("public Rectangle(int a0, int a1) {", source)
        self.assertIn('MooditRpc.nouvelle("Rectangle"', source)
        self.assertIn("public int aire() {", source)
        self.assertNotIn("private Rectangle() {}", source)

    def test_java_bouchon_sans_objet_garde_le_constructeur_prive(self):
        source = supervisor.java_stub_source("Solution", [("int", "doubler", ["int"])])
        self.assertIn("private Solution() {}", source)


class GenerationTypesEtIdiomesTest(unittest.TestCase):
    """Types de retour et idiomes que la première version du générateur ne savait pas produire.

    Chacun rendait « Échec de compilation » à un étudiant dont le code était juste : ce sont les
    régressions les plus coûteuses du chemin non falsifiable, et aucune n'était mesurée."""

    def test_java_types_de_retour_sans_mot_reserve(self):
        # `long`, `double` et `boolean` sont des mots réservés : le nom de la méthode RPC ne peut
        # pas être dérivé du type. `MooditRpc.double(…)` ne compilait pas.
        for retour, attendu in (("int", "MooditRpc.integer("), ("long", "MooditRpc.long_("),
                                ("double", "MooditRpc.double_("),
                                ("boolean", "MooditRpc.boolean_("),
                                ("java.lang.String", "MooditRpc.string(")):
            source = supervisor.java_stub_source("Solution", [(retour, "f", ["int"])])
            self.assertIn(attendu, source, retour)
            for reserve in ("MooditRpc.double(", "MooditRpc.long(", "MooditRpc.boolean("):
                self.assertNotIn(reserve, source)

    def test_rust_methode_transmet_ses_arguments(self):
        objets = [("Compteur", [], [("i32", "plus", ["i32"])])]
        champs = {"Compteur": [("valeur", "i32")]}
        _, cas = supervisor.rust_object_dispatch(objets, champs)
        self.assertIn("let a0 =", cas)
        self.assertIn(".plus(a0)", cas)

    def test_rust_un_seul_bras_new_par_cle(self):
        # Un type à champs capturés ET doté d'un constructeur recevait deux bras identiques ;
        # le second, inatteignable, valait un avertissement `unreachable_patterns`.
        objets = [("Rectangle", [("new", ["i32", "i32"])], [("i32", "aire", [])])]
        champs = {"Rectangle": [("largeur", "i32"), ("hauteur", "i32")]}
        _, cas = supervisor.rust_object_dispatch(objets, champs)
        self.assertEqual(cas.count('"new|new" =>'), 1)
        self.assertEqual(cas.count('"new|Rectangle" =>'), 1)

    def test_go_recepteur_pointeur(self):
        source = ("package main\n\n"
                  "type Compteur struct {\n\tvaleur int\n}\n\n"
                  "func NewCompteur(v int) *Compteur {\n\treturn &Compteur{valeur: v}\n}\n\n"
                  "func (c *Compteur) Plus(n int) int { return c.valeur + n }\n")
        # Le constructeur rendant *T était ignoré, donc le type n'était pas proxifié du tout.
        objets = supervisor.go_object_api(source)
        self.assertEqual(objets, [("Compteur", [("NewCompteur", ["int"], True)],
                                   [("int", "Plus", ["int"])])])
        # Un récepteur pointeur écarte la capture de champs : l'objet reconstruit à chaque appel
        # perdrait la modification EN SILENCE.
        self.assertEqual(supervisor.go_capture_fields(source), {})
        self.assertEqual(supervisor.go_pointer_receivers(source), {"Compteur"})
        # Et l'objet est stocké par POINTEUR : une méthode à récepteur pointeur ne peut pas être
        # appelée sur le résultat d'une assertion de type, qui n'est pas adressable.
        cas_new, cas_methode = supervisor.go_object_dispatch(objets, {})
        self.assertIn("mooditObjets = append(mooditObjets, moodit_cree)", cas_new)
        self.assertIn(".(*Compteur).Plus(", cas_methode)
        self.assertIn("func NewCompteur(a0 int) *Compteur {",
                      supervisor.go_object_stub(objets, {}))

    def test_go_recepteur_valeur_garde_la_capture_de_champs(self):
        source = ("package main\n\n"
                  "type Rectangle struct {\n\tlargeur int\n\thauteur int\n}\n\n"
                  "func (r Rectangle) aire() int { return r.largeur * r.hauteur }\n")
        self.assertEqual(supervisor.go_pointer_receivers(source), set())
        self.assertIn("Rectangle", supervisor.go_capture_fields(source))

    def test_double_garde_sa_precision(self):
        # `%g` s'arrête à 6 chiffres significatifs, pour les arguments COMME pour les retours :
        # 3.14159265 arrivait tronqué et une réponse juste était notée fausse.
        self.assertEqual(supervisor.C_TYPES["double"], "%.17g")
        bouchon = supervisor.c_grader_source([("double", "moyenne", ["double", "double"])],
                                             "return 1;", "N")
        self.assertIn("%.17g", bouchon)
        self.assertNotIn('"%s|call|moyenne|%g', bouchon)

    def test_rust_chaine_part_en_hexadecimal(self):
        # Le fil est à champs séparés par « | », une ligne par message : un « | » dans la valeur
        # décalait tout l'appel.
        self.assertEqual(supervisor.rust_envoi(["String"]), ' + "|" + &moodit_hexe(&a0)')
        self.assertEqual(supervisor.rust_envoi(["i32"]), ' + "|" + &a0.to_string()')
        noteur = supervisor.rust_grader_source([("String", "copie", ["String"])], "true", "N")
        self.assertIn("moodit_hexe(&a0)", noteur)
        self.assertIn("moodit_dehexe(&brut)", noteur)
        serveur = supervisor.rust_server_source([("String", "copie", ["String"])], "fn copie() {}")
        self.assertIn("moodit_dehexe(args.next()", serveur)
        self.assertIn("moodit_hexe(&copie(a0))", serveur)

    def test_csharp_chaine_et_culture(self):
        self.assertIn("MooditRpc.Hexe(a0)", supervisor.cs_envoi(["string"]))
        self.assertIn("CultureInfo.InvariantCulture", supervisor.cs_envoi(["double"]))
        self.assertEqual(supervisor.CS_LECTURE["string"], "MooditRpc.Dehexe(v)")

    def test_csharp_pas_de_constructeur_a_poignee(self):
        # Il collisionnait avec un constructeur du code soumis prenant un seul int, et C#
        # n'autorise pas la surcharge par accessibilité : le noteur ne compilait plus.
        source = supervisor.cs_grader_source([], "return true;", "N", "Compteur",
                                             ctors=[["int"]],
                                             instance=[("int", "Plus", ["int"])])
        self.assertNotIn("private Compteur(int h)", source)
        self.assertIn("public Compteur(int a0)", source)

    def test_rust_champ_chaine_capture_part_en_hexadecimal(self):
        objets = [("Personne", [], [("String", "carte", [])])]
        champs = {"Personne": [("nom", "String"), ("age", "i32")]}
        bouchon = supervisor.rust_object_stub(objets, champs)
        # Le lecteur d'en face déhexe : un champ String envoyé en clair revenait mutilé.
        self.assertIn("&moodit_hexe(&self.nom)", bouchon)
        self.assertIn("&self.age.to_string()", bouchon)

    def test_go_entiers_exacts_au_dela_de_deux_puissance_53(self):
        # Le JSON décodé dans un interface{} donne un float64 : au-delà de 2^53, une somme de
        # grands nombres revenait fausse, et une réponse juste était notée fausse.
        self.assertEqual(supervisor.GO_CONV["int64"], "mooditEntier(%s)")
        self.assertEqual(supervisor.GO_CONV["int"], "int(mooditEntier(%s))")
        for source in (supervisor.go_grader_source([("int64", "somme", ["int64"])], "true", "N"),
                       supervisor.go_server_source([("int64", "somme", ["int64"])])):
            self.assertIn("dec.UseNumber()", source)
            self.assertIn("func mooditEntier(", source)
            # Une seule table de conversion : l'aiguillage du serveur avait la sienne, restée sur
            # la lecture en flottant. Aucun chemin ne doit lire un entier autrement.
            self.assertNotIn("int64(mooditNombre(", source)
            self.assertNotIn("int(mooditNombre(", source)
        self.assertIn("valeur = somme(mooditEntier(req.Args[0]))",
                      supervisor.go_server_source([("int64", "somme", ["int64"])]))

    def test_go_constructeur_pointeur_en_capture_de_champs(self):
        # La branche à poignée gardait la signature du constructeur, pas celle-ci : un harnais
        # rangeant le résultat dans un *T ne compilait que d'un côté.
        objets = [("Rectangle", [("NewRectangle", ["int", "int"], True)],
                   [("int", "aire", [])])]
        champs = {"Rectangle": [("largeur", "int"), ("hauteur", "int")]}
        bouchon = supervisor.go_object_stub(objets, champs)
        self.assertIn("func NewRectangle(a0 int, a1 int) *Rectangle {", bouchon)
        self.assertIn("return &Rectangle{", bouchon)

    def test_csharp_double_en_aller_retour_exact(self):
        # Le format « G » par défaut n'est pas garanti exact. Et c'est « G17 », pas « R » : la
        # documentation .NET déconseille R pour l'aller-retour d'un double, et le runner tourne
        # sur mono, le runtime le plus ancien du parc.
        self.assertIn('a0.ToString("G17"', supervisor.cs_envoi(["double"]))
        self.assertIn('+ "|" + MooditRpc.Hexe(a0)', supervisor.cs_envoi(["string"]))
        serveur = supervisor.cs_server_source("Solution")
        self.assertIn('ToString("G17"', serveur)
        self.assertIn('ToString("G9"', serveur)

    def test_rust_fonction_associee_ou_imbriquee_nest_pas_libre(self):
        # Une `fn` indentée vit dans un `impl` ou dans une autre fonction : l'aiguillage généré
        # l'appelait au niveau module, où le nom n'existe pas, et le programme de l'étudiant ne
        # compilait plus. Même défaut qu'en C++, où cpp_class_spans le ferme déjà.
        source = ("struct Rect { c: i32 }\n\n"
                  "impl Rect {\n"
                  "    fn double(x: i32) -> i32 { x * 2 }\n"
                  "}\n\n"
                  "fn calcule(n: i32) -> i32 {\n"
                  "    fn aide(k: i32) -> i32 { k + 1 }\n"
                  "    aide(n)\n"
                  "}\n")
        self.assertEqual(supervisor.rust_signatures(source), [("i32", "calcule", ["i32"])])
        serveur = supervisor.rust_server_source(supervisor.rust_signatures(source), source)
        for absent in ('"double" =>', '"aide" =>'):
            self.assertNotIn(absent, serveur)

    def test_rust_recepteur_mutable_ecarte_la_capture_de_champs(self):
        # Pendant du filtre Go : l'objet reconstruit à chaque appel perdrait la modification EN
        # SILENCE, donc une réponse juste serait notée fausse sans diagnostic.
        source = ("struct Compteur { valeur: i32 }\n\n"
                  "impl Compteur {\n"
                  "    fn ajoute(&mut self, n: i32) -> i32 { self.valeur += n; self.valeur }\n"
                  "}\n")
        self.assertEqual(supervisor.rust_mut_receivers(source), {"Compteur"})
        self.assertEqual(supervisor.rust_capture_fields(source), {})
        # Sans constructeur ET avec méthode mutante : pas proxifié du tout, plutôt qu'un faux
        # verdict. Le harnais ne compile pas, et le prof le voit.
        self.assertEqual(supervisor.rust_object_api(source), [])

    def test_rust_recepteur_immuable_garde_la_capture_de_champs(self):
        source = ("struct Rectangle { largeur: i32, hauteur: i32 }\n\n"
                  "impl Rectangle {\n"
                  "    fn aire(&self) -> i32 { self.largeur * self.hauteur }\n"
                  "}\n")
        self.assertEqual(supervisor.rust_mut_receivers(source), set())
        self.assertIn("Rectangle", supervisor.rust_capture_fields(source))

    def test_java_reponse_d_erreur_porte_l_identifiant(self):
        # Le noteur n'accepte qu'une ligne portant l'identifiant de SON appel : sans lui, une
        # exception du code soumis n'était jamais consommée et le couple s'attendait jusqu'au
        # temps limite. Les cinq autres langages tenaient déjà cet invariant.
        serveur = supervisor.java_server_source("Solution")
        self.assertIn('"{\\"ok\\":false,\\"id\\":\\""', serveur)
        self.assertIn('entre(ligne, "\\"id\\":\\"", "\\"")', serveur)

    def test_une_seule_table_de_conversion_par_langage(self):
        # Cause racine de trois tours de correctifs : une table dupliquée reste en arrière au
        # changement d'invariant suivant. Le garde-fou utile n'est pas « ce générateur-là utilise
        # la table » mais « il n'existe AUCUNE table littérale hors des constantes ».
        for t in supervisor.GO_CONV:
            self.assertIn(supervisor.GO_CONV[t] % "v",
                          supervisor.go_grader_source([(t, "f", [])], "true", "N"))
            self.assertIn(supervisor.GO_CONV[t] % "req.Args[0]",
                          supervisor.go_server_source([("int", "f", [t])]))
        for t in supervisor.RUST_CONV:
            attendu = supervisor.RUST_CONV[t] % 'args.next().unwrap_or("")'
            self.assertIn(attendu,
                          supervisor.rust_server_source([("i32", "f", [t])], "fn f() {}"))
        for t, lecture in supervisor.C_LECTURE.items():
            self.assertIn("%s(moodit_valeur(id))" % lecture,
                          supervisor.c_grader_source([(t, "f", [])], "return 1;", "N"))
        with open(supervisor.__file__, encoding="utf-8") as f:
            source = f.read()
        # Une seule DÉFINITION par table, et aucune copie littérale ailleurs.
        for empreinte in ('"long": "atol"', '"int64": "mooditEntier', '"bool": "%s.parse::<bool>'):
            self.assertEqual(source.count(empreinte), 1, empreinte)

    def test_go_valeur_non_representable_ne_bloque_pas_le_couple(self):
        # json.Marshal échoue sur NaN et ±Inf : l'erreur ignorée donnait une ligne vide, que le
        # décodeur d'en face rejette — les deux processus s'attendaient jusqu'au temps limite.
        noteur = supervisor.go_grader_source([("float64", "moyenne", [])], "true", "N")
        self.assertIn("errReq != nil", noteur)
        self.assertIn("errRep != nil", supervisor.go_server_source([("float64", "moyenne", [])]))

    def test_reponse_auto_cadree_dans_les_six_langages(self):
        """Le stdout du code noté EST le canal de réponse, et il partage son tampon.

        Une dernière écriture non terminée par un saut de ligne (`print(…, end="")`, `print!`,
        `System.out.print`) se collait au DÉBUT de la ligne de réponse, qui n'était alors plus
        reconnue : le couple s'attendait jusqu'au temps limite, et une réponse JUSTE était notée
        « Interrompu ». Un saut de ligne AVANT la réponse referme la ligne partielle, qui devient
        du bruit à part entière. L'invariant doit valoir dans les six langages — il ne valait,
        côté interprété, qu'en PHP."""
        attendus = (
            ("java", supervisor.java_server_source("Solution"),
             r'System.out.print("\n" + reponse + "\n");'),
            ("go", supervisor.go_server_source([("int", "f", [])]),
             r'fmt.Print("\n" + string(brut) + "\n")'),
            ("rust", supervisor.rust_server_source([("i32", "f", [])], "fn f() {}"),
             r'print!("\n{}\n", reponse);'),
            ("csharp", supervisor.cs_server_source("Solution"),
             r'Console.Out.Write("\n" + reponse + "\n");'),
            ("c", supervisor.c_server_source([("int", "f", [])], "int f(void){return 1;}"),
             r'printf("\n%s|ok|'),
        )
        for langue, source, attendu in attendus:
            self.assertIn(attendu, source, langue)

    def test_profondeur_ignore_litteraux_et_commentaires(self):
        # Un comptage naïf se faisait déséquilibrer par une accolade en littéral, et toutes les
        # fonctions suivantes passaient pour imbriquées : un code CORRECT rendait « aucune
        # fonction exploitable ». C'était une régression du correctif précédent.
        cas = [
            ("littéral de caractère", "fn ouvrante(c: char) -> bool { c == '{' }\n"
                                      "fn doubler(n: i32) -> i32 { n * 2 }\n"),
            ("littéral fermant", "fn fermante(c: char) -> bool { c == '}' }\n"
                                 "fn doubler(n: i32) -> i32 { n * 2 }\n"),
            ("chaîne", 'fn motif() -> String { String::from("{x}") }\n'
                       "fn doubler(n: i32) -> i32 { n * 2 }\n"),
            ("commentaire ligne", "// un { dans un commentaire\n"
                                  "fn doubler(n: i32) -> i32 { n * 2 }\n"),
            ("commentaire bloc", "/* { et } */\nfn doubler(n: i32) -> i32 { n * 2 }\n"),
            ("chaîne brute", 'fn brut() -> String { String::from(r#"{"a": 1}"#) }\n'
                             "fn doubler(n: i32) -> i32 { n * 2 }\n"),
        ]
        for nom, source in cas:
            noms = [n for _, n, _ in supervisor.rust_signatures(source)]
            self.assertIn("doubler", noms, nom)
        # Et le filtre de premier niveau tient toujours.
        imbrique = ("impl Rect {\n    fn associee(x: i32) -> i32 { x }\n}\n"
                    "fn doubler(n: i32) -> i32 { n * 2 }\n")
        self.assertEqual([n for _, n, _ in supervisor.rust_signatures(imbrique)], ["doubler"])

    def test_appariement_daccolades_partage(self):
        # Le même balayage sert aux quatre endroits qui appariaient des accolades à la main.
        source = ("class Rectangle {\n    int largeur, hauteur;\npublic:\n"
                  "    Rectangle(int l, int h) : largeur(l), hauteur(h) {}\n"
                  "    int aire() { return largeur * hauteur; }\n"
                  "    char ouvrante() { return '{'; }\n};\n\n"
                  "int doubler(int n) { return n * 2; }\n")
        self.assertEqual(supervisor.c_signatures(source, cpp=True),
                         [("int", "doubler", ["int"])])
        self.assertEqual([c for c, _, _ in supervisor.cpp_object_api(source)], ["Rectangle"])

    def test_verdict_rpc_est_fail_closed(self):
        self.assertEqual(supervisor.rpc_verdict("N", "bruit N bruit", ""), (True, None))
        # Sans nonce : échec, quoi qu'il arrive — noteur planté, jeton non armé, flux vide.
        passed, detail = supervisor.rpc_verdict("N", "", "")
        self.assertFalse(passed)
        self.assertEqual(detail, "Le harnais a renvoyé faux")
        self.assertEqual(supervisor.rpc_verdict("", "N", "")[0], False)
        # Le motif vient du NOTEUR en priorité : présenter le stderr de l'étudiant désignait le
        # mauvais fautif, et c'est lui qui en choisissait le texte.
        self.assertEqual(
            supervisor.rpc_verdict("N", "[MOODIT] harnais: oups\n", "mon message")[1],
            "[MOODIT] harnais: oups")
        self.assertEqual(supervisor.rpc_verdict("N", "", "trace etudiant")[1], "trace etudiant")


if __name__ == "__main__":
    unittest.main(verbosity=1)

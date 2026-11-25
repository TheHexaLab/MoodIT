# -*- coding: utf-8 -*-
"""Tests unitaires des FONCTIONS PURES de supervisor.py (verdict des canaris et du noteur,
extraction des signatures et génération des bouchons et serveurs des six langages compilés,
noms réservés, relecture tête+queue, nettoyage) : la logique de verdict ne doit pas n'être
couverte que par les tests d'intégration Docker. Lancés par le job CI `integration`
(`python3 docker/runners/common/test_supervisor.py`) AVANT la construction des images, et
exécutables localement : dans une image runner, ou sous Windows, où les tests qui demandent un
système Linux (UID, /proc, signaux) sont ignorés.
"""

import json
import os
import subprocess
import time
import re
import shutil
import stat
import sys
import tempfile
import inspect
import io
import unittest
import unittest.mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import supervisor  # noqa: E402


def outcome(passed, ran=True, timed_out=False, skipped=False):
    return supervisor.CaseOutcome(passed, None, ran=ran, timed_out=timed_out, skipped=skipped)


class CanaryVerdictTest(unittest.TestCase):
    def setUp(self):
        supervisor.EVENTS.clear()

    def test_no_canary(self):
        self.assertEqual(supervisor.canary_verdict([{"index": 0}], {0: outcome(True)}), "aucun")

    def test_conforming_canaries(self):
        cases = [{"index": 0}, {"index": 1, "canary": "pass"}, {"index": 2, "canary": "fail"}]
        outcomes = {0: outcome(True), 1: outcome(True), 2: outcome(False)}
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "ok")
        self.assertEqual(supervisor.EVENTS, [])

    def test_canary_with_opposite_result(self):
        cases = [{"index": 0}, {"index": 1, "canary": "pass"}, {"index": 2, "canary": "fail"}]
        outcomes = {0: outcome(True), 1: outcome(True), 2: outcome(True)}  # « fail » qui réussit
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "incoherents")
        self.assertEqual(supervisor.EVENTS[0]["type"], "canari_incoherent")

    def test_fail_closed_when_real_cases_ran_but_not_canaries(self):
        # Collision de nom ciblant la compilation des seuls canaris : falsification, pas un
        # échec honnête (un code honnête échoue PARTOUT pareil).
        cases = [{"index": 0}, {"index": 1, "canary": "pass"}, {"index": 2, "canary": "fail"}]
        outcomes = {0: outcome(True), 1: outcome(False, ran=False), 2: outcome(False, ran=False)}
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "incoherents")
        self.assertEqual(supervisor.EVENTS[0]["type"], "canari_incoherent")

    def test_canary_skipped_for_budget_no_accusation(self):
        # Budget global dépassé : l'ordre étant tiré au sort, un canari peut tomber dans la
        # queue non exécutée alors que des cas réels ont tourné. Une soumission simplement
        # TROP LENTE ne doit jamais être étiquetée « falsification probable ».
        cases = [{"index": 0}, {"index": 1, "canary": "pass"}, {"index": 2, "canary": "fail"}]
        outcomes = {0: outcome(True), 1: outcome(True),
                    2: outcome(False, ran=False, skipped=True)}
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
        self.assertEqual(supervisor.EVENTS, [])

    def test_all_expired_undetermined_no_accusation(self):
        # Temps limite trop court (ou hôte surchargé) : TOUT expire, canaris compris — mauvaise
        # configuration, pas une falsification. Aucun gain pour un sabotage (cas réels morts).
        cases = [{"index": 0}, {"index": 1, "canary": "pass"}, {"index": 2, "canary": "fail"}]
        outcomes = {0: outcome(False, timed_out=True), 1: outcome(False, timed_out=True),
                    2: outcome(False, timed_out=True)}
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
        self.assertEqual(supervisor.EVENTS, [])

    def test_undetermined_when_nothing_ran(self):
        # Échec de compilation GLOBAL (code étudiant cassé) : honnête, pas d'alerte.
        cases = [{"index": 0}, {"index": 1, "canary": "pass"}, {"index": 2, "canary": "fail"}]
        outcomes = {0: outcome(False, ran=False), 1: outcome(False, ran=False),
                    2: outcome(False, ran=False)}
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
        self.assertEqual(supervisor.EVENTS, [])


class StudentUidTest(unittest.TestCase):
    """UID étudiant unique par conteneur : RLIMIT_NPROC compte par UID RÉEL sur l'hôte, un UID
    fixe en faisait un budget partagé entre notations simultanées."""

    def test_rewrites_uid_and_gid_in_passwd(self):
        passwd = ("root:x:0:0:root:/root:/bin/bash\n"
                  "student:x:1300:1300::/nonexistent:/usr/sbin/nologin\n")
        out = supervisor.with_uid(passwd, "student", 45678, 45678)
        self.assertIn("student:x:45678:45678::/nonexistent:/usr/sbin/nologin", out)
        self.assertIn("root:x:0:0:", out)          # les autres lignes sont intactes

    def test_rewrites_gid_in_group(self):
        out = supervisor.with_uid("student:x:1300:\n", "student", 45678, 45678)
        self.assertEqual(out, "student:x:45678:\n")

    def test_missing_user_returns_none(self):
        self.assertIsNone(supervisor.with_uid("root:x:0:0:\n", "student", 1, 1))


class RedactTokensTest(unittest.TestCase):
    """Aucun jeton dans le detail renvoye a l'appelant : quand le verdict echoue tot, le detail
    est bati sur les premieres lignes de sortie, et la ligne « [MOODIT] jeton=… code=… » s'y
    retrouvait telle quelle (constate en sondant un cas C#)."""

    def setUp(self):
        supervisor.TOKENS.clear()
        supervisor.TOKENS[0] = "6121964961777"
        supervisor.TOKENS[1] = "1234567890123"

    def test_token_removed_from_detail(self):
        self.assertEqual(
            supervisor.redact_tokens("[MOODIT] jeton=6121964961777 code=1"),
            "[MOODIT] jeton=… code=1")

    def test_other_case_token_removed_too(self):
        # Les cas partagent le meme conteneur : aucun de leurs jetons ne doit sortir.
        self.assertNotIn("1234567890123", supervisor.redact_tokens("fuite 1234567890123"))

    def test_empty_detail_unchanged(self):
        self.assertIsNone(supervisor.redact_tokens(None))
        self.assertEqual(supervisor.redact_tokens(""), "")

    def test_detail_without_token_unchanged(self):
        self.assertEqual(supervisor.redact_tokens("expected: <12> but was: <0>"),
                         "expected: <12> but was: <0>")


class ExecuteCaseSaturationTest(unittest.TestCase):
    """Marquage « non imputable » d'un cas touche par une saturation du tmpfs."""

    def setUp(self):
        self.directory = tempfile.mkdtemp()
        self.box = supervisor.BOX
        supervisor.BOX = self.directory
        self.runners = dict(supervisor.RUNNERS)
        self.base_env = supervisor.base_env
        supervisor.base_env = lambda case_dir: {"HOME": self.directory,
                                                "TMPDIR": self.directory}

    def tearDown(self):
        supervisor.BOX = self.box
        supervisor.RUNNERS.clear()
        supervisor.RUNNERS.update(self.runners)
        supervisor.base_env = self.base_env
        shutil.rmtree(self.directory, ignore_errors=True)

    def _run_case(self, issue, lost):
        def fake_runner(case_dir, env, timeout_s, case_index):
            supervisor.EXIT_STATE.lost = lost
            return issue, None

        supervisor.RUNNERS["Java"] = fake_runner
        return supervisor.execute_case("Java", {"index": 0}, 10)[0]

    def test_failed_case_becomes_not_imputable_and_states_cause(self):
        issue = self._run_case(supervisor.CaseOutcome(
            False, "Échec du harnais", ran=True), lost=True)
        self.assertTrue(issue.skipped)
        self.assertIn("saturé", issue.detail)

    def test_passed_case_is_not_contradicted(self):
        # « perdue » est pose des qu'UN des deux flux echoue, or le verdict a pu conclure
        # « reussi » sur un stdout intact. Un cas vert accompagne de « notation impossible »
        # etait un message contradictoire, qui imputait au code une panne du noteur.
        issue = self._run_case(supervisor.CaseOutcome(True, None, ran=True), lost=True)
        self.assertFalse(issue.skipped)
        self.assertIsNone(issue.detail)
        self.assertTrue(issue.passed)

    def test_signal_death_reported_on_outcome(self):
        def fake_runner(case_dir, env, timeout_s, case_index):
            supervisor.EXIT_STATE.killed_by_signal = True
            return supervisor.CaseOutcome(False, "echec", ran=True), None

        supervisor.RUNNERS["Java"] = fake_runner
        issue = supervisor.execute_case("Java", {"index": 0}, 10)[0]
        self.assertTrue(issue.killed)
        self.assertTrue(supervisor.inconclusive(issue))

    def test_grader_build_failure_is_flagged_inconclusive(self):
        # Le NOTEUR n'a pas compilé (bouchons générés + harnais) : pour un canari, dont le
        # harnais est fixe, c'est le générateur qui a cédé — jamais une accusation.
        def fake_runner(case_dir, env, timeout_s, case_index):
            return None, supervisor.HARNESS_BUILD_ERROR + " contre le code soumis :\nCS0111"

        supervisor.RUNNERS["Java"] = fake_runner
        issue = supervisor.execute_case("Java", {"index": 0}, 10)[0]
        self.assertFalse(issue.ran)
        self.assertTrue(issue.harness_build)
        self.assertTrue(supervisor.inconclusive(issue))

    def test_extraction_refusal_becomes_a_refused_case(self):
        # Une borne de l'extraction franchie par le code soumis (SubmissionRefused) donne un cas
        # REFUSÉ avec son message, comme les refus que rendent les runners — pas l'exception que
        # main() compterait en erreur interne (502 sans verdict, provoqué par l'étudiant).
        def fake_runner(case_dir, env, timeout_s, case_index):
            raise supervisor.SubmissionRefused("Hiérarchie trop profonde pour la notation")

        supervisor.RUNNERS["Java"] = fake_runner
        issue = supervisor.execute_case("Java", {"index": 0}, 10)[0]
        self.assertFalse(issue.passed)
        self.assertFalse(issue.ran)
        self.assertEqual("Hiérarchie trop profonde pour la notation", issue.detail)
        self.assertFalse(issue.harness_build)
        self.assertFalse(issue.skipped)
        self.assertIsNone(issue.cause)

    def test_student_build_failure_stays_conclusive(self):
        # Le message du compilateur vient APRÈS notre préfixe : un code soumis qui ne compile
        # pas, même s'il « écrit » la phrase du noteur, reste un échec ordinaire.
        def fake_runner(case_dir, env, timeout_s, case_index):
            return None, "Échec de compilation :\n" + supervisor.HARNESS_BUILD_ERROR

        supervisor.RUNNERS["Java"] = fake_runner
        issue = supervisor.execute_case("Java", {"index": 0}, 10)[0]
        self.assertFalse(issue.harness_build)
        self.assertFalse(supervisor.inconclusive(issue))

    def test_without_saturation_nothing_changes(self):
        issue = self._run_case(supervisor.CaseOutcome(
            False, "assertion ratee", ran=True), lost=False)
        self.assertFalse(issue.skipped)
        self.assertEqual(issue.detail, "assertion ratee")


class ExitStateTest(unittest.TestCase):
    """L'etat de capture est un OBJET PAR CAS, pas un drapeau global : les pompes peuvent
    survivre a leur run_proc, et un global aurait ete repositionne pendant le cas SUIVANT."""

    def test_late_pump_only_affects_its_case(self):
        case_state_1 = supervisor.ExitState(case_index=1)
        case_state_2 = supervisor.ExitState(case_index=2)
        # La pompe du cas 1, encore vivante, finit par echouer a ecrire.
        class ClosedDestination(io.BytesIO):
            def write(self, data):
                raise ValueError("I/O operation on closed file")

        # Le cas 2 est celui EN COURS (global) : c'est lui qui ne doit pas etre desarme.
        # (Auparavant l'assertion portait sur un objet jamais passe a drain_pipe, donc vraie
        # par construction, quoi que fasse le code.)
        supervisor.EXIT_STATE = case_state_2
        supervisor.drain_pipe(io.BytesIO(b"tardif\n"), ClosedDestination(),
                              cap=1024, state=case_state_1)
        self.assertTrue(case_state_1.lost)
        self.assertFalse(supervisor.EXIT_STATE.lost)   # le cas en cours reste armé

    @unittest.skipUnless(os.name == "posix",
                         "run_proc pilote des groupes de processus POSIX ; couvert en CI (Linux)")
    def test_run_proc_blames_loss_on_case_captured_at_entry(self):
        # run_proc capture EXIT_STATE A L'ENTREE : si le cas SUIVANT remplace le global
        # pendant l'execution, une pompe retardataire doit continuer d'imputer sa perte au cas
        # qui l'a lancee. Aucun test ne couvrait cette capture.
        state_during = supervisor.ExitState(case_index=1)
        supervisor.EXIT_STATE = state_during

        class Saturated(io.BytesIO):
            def write(self, data):
                # Le cas suivant a deja pris la main dans le global.
                supervisor.EXIT_STATE = supervisor.ExitState(case_index=2)
                raise OSError(28, "No space left on device")

        origin = supervisor.open_output
        supervisor.open_output = lambda fpath: Saturated()
        try:
            # Le vrai run_proc vide /tmp et /dev/shm et tue l'UID étudiant : neutralisés, sinon ce
            # test effaçait les fichiers temporaires de la machine qui le lance.
            with unittest.mock.patch.object(supervisor, "purge_shared_dirs"), \
                    unittest.mock.patch.object(supervisor, "kill_student_survivors"):
                supervisor.run_proc(["sh", "-c", "echo x"], ".", dict(os.environ), 10,
                                    "o.out", "e.err", None)
        finally:
            supervisor.open_output = origin
        self.assertTrue(state_during.lost)               # impute au BON cas
        self.assertFalse(supervisor.EXIT_STATE.lost)    # pas au cas suivant

    def test_without_state_no_error(self):
        # drain_pipe reste utilisable sans etat (compilation, mode exec).
        supervisor.drain_pipe(io.BytesIO(b"ok\n"), io.BytesIO(), cap=1024)


class InternalErrorTest(unittest.TestCase):
    """Une defaillance du NOTEUR (tmpfs sature, fork impossible) ne doit jamais accuser :
    le cas echoue, mais marque skipped, donc non imputable."""

    def setUp(self):
        # Etat GLOBAL vide avant chaque test : ces classes affirment sur supervisor.EVENTS,
        # et un test d'une autre classe (canary_verdict emet sans nettoyer) laissait un
        # evenement derriere lui. Sous unittest l'ordre alphabetique des classes masquait le
        # conflit ; sous pytest (ordre du fichier), test_case_skipped_for_saturation_does_not_accuse rougissait
        # — et un simple renommage de classe aurait inverse la CI. On ne fait pas confiance a
        # un etat global qu'on n'a pas pose.
        supervisor.EVENTS.clear()

    def test_signal_death_at_load_does_not_accuse(self):
        # Un code qui PLANTE ou sature la memoire au CHARGEMENT fait echouer les canaris sans
        # les faire expirer : le code soumis tourne dans le serveur de CHAQUE cas, canaris
        # compris, donc son init()/constructeur global y tourne aussi. L'ancien garde-fou
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

    def test_no_judgeable_real_case_no_accusation(self):
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

    def test_canary_with_killed_compilation_does_not_accuse(self):
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

    def test_broken_canary_only_compilation_still_accused(self):
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

    def test_contradicting_canary_accuses_even_if_other_did_not_compile(self):
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

    def test_frozen_canary_without_green_real_case_does_not_accuse(self):
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

    def test_no_confirmed_canary_is_not_ok(self):
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

    def test_panic_at_load_does_not_accuse(self):
        # Une panique Go au chargement sort avec le STATUT 2 : ni expiration, ni signal, donc
        # l'ancienne forme y voyait une cause « concluante » et accusait — alors que le code
        # soumis tourne dans le serveur de chaque cas, canaris compris, si bien que TOUS les cas
        # plantent pareil. Le
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

    def test_expired_compilation_is_inconclusive(self):
        # Les runners rapportent une compilation expiree en simple « Echec de compilation »,
        # donc sans timed_out : un code lent a compiler (gros templates C++) dont le canari
        # franchit la limite par flottement de l'hote passait pour un sabotage.
        def fake_runner(case_dir, env, timeout_s, case_index):
            supervisor.EXIT_STATE.expired = True
            return supervisor.CaseOutcome(False, "Échec de compilation", ran=False), None

        runners = dict(supervisor.RUNNERS)
        base_env = supervisor.base_env
        box = supervisor.BOX
        directory = tempfile.mkdtemp()
        supervisor.BOX = directory
        supervisor.base_env = lambda case_dir: {"HOME": directory, "TMPDIR": directory}
        supervisor.RUNNERS["Java"] = fake_runner
        try:
            issue = supervisor.execute_case("Java", {"index": 0}, 10)[0]
        finally:
            supervisor.BOX = box
            supervisor.base_env = base_env
            supervisor.RUNNERS.clear()
            supervisor.RUNNERS.update(runners)
            shutil.rmtree(directory, ignore_errors=True)
        self.assertTrue(issue.timed_out)
        self.assertTrue(supervisor.inconclusive(issue))

    def test_selective_canary_freeze_still_accused(self):
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

    def test_inconclusive_cause(self):
        self.assertTrue(supervisor.inconclusive(
            supervisor.CaseOutcome(False, timed_out=True)))
        self.assertTrue(supervisor.inconclusive(
            supervisor.CaseOutcome(False, killed=True)))
        self.assertFalse(supervisor.inconclusive(
            supervisor.CaseOutcome(False, "assertion ratee")))

    def test_all_expired_does_not_accuse_even_with_not_imputable_case(self):
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

    def test_saturated_canary_does_not_disarm_the_other(self):
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

    def test_all_canaries_not_imputable_give_undetermined(self):
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

    def test_saturated_canary_gives_undetermined(self):
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

    def test_canary_with_internal_error_gives_undetermined(self):
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


class CanaryReserveTest(unittest.TestCase):
    """Réserve de budget des canaris : bornée au tiers du budget. Non bornée, elle dépassait
    le budget lui-même sur un appel public (mur plafonné à 4 min) et AUCUN cas réel ne
    démarrait — le « Tester » du prof ne notait plus rien sur les six langages compilés."""

    def test_always_room_for_real_cases(self):
        # Toutes les combinaisons atteignables des deux chemins (public et interne).
        for budget_s in (60, 110, 119, 212, 230, 330, 616, 670, 720, 770, 779):
            for timeout_s in (1, 10, 30, 60):
                reserve = supervisor.canary_reserve_seconds(budget_s, timeout_s)
                self.assertGreater(budget_s - reserve, 0,
                                   "budget=%s timeout=%s" % (budget_s, timeout_s))
                self.assertGreaterEqual(reserve, 0)
                self.assertLessEqual(reserve, budget_s / 3.0 + 1e-9)

    def test_zero_reserve_without_budget(self):
        self.assertEqual(supervisor.canary_reserve_seconds(0, 10), 0.0)

    def test_worst_case_kept_when_budget_is_ample(self):
        # 2 × (10 + 90) = 200 s, bien en dessous du tiers d'un gros budget.
        self.assertEqual(supervisor.canary_reserve_seconds(3000, 10), 200.0)


class BoxExhaustedTest(unittest.TestCase):
    """Saturation du tmpfs /box : un code honnête mais bogué (fichiers temporaires jamais
    supprimés) faisait échouer les cas SUIVANTS, canaris compris → « falsification probable ».
    Le cas est désormais sauté avec un verdict honnête."""

    def setUp(self):
        # Etat GLOBAL vide avant chaque test : ces classes affirment sur supervisor.EVENTS,
        # et un test d'une autre classe (canary_verdict emet sans nettoyer) laissait un
        # evenement derriere lui. Sous unittest l'ordre alphabetique des classes masquait le
        # conflit ; sous pytest (ordre du fichier), test_case_skipped_for_saturation_does_not_accuse rougissait
        # — et un simple renommage de classe aurait inverse la CI. On ne fait pas confiance a
        # un etat global qu'on n'a pas pose.
        supervisor.EVENTS.clear()

    def test_below_threshold_is_saturated(self):
        # 100 blocs de 4 Kio = 400 Kio, bien en dessous du seuil de 48 Mio.
        self.assertTrue(supervisor.free_bytes_under(100, 4096, 48 * 1024 * 1024))

    def test_above_threshold_is_healthy(self):
        # 100 000 blocs de 4 Kio = 390 Mio.
        self.assertFalse(supervisor.free_bytes_under(100000, 4096, 48 * 1024 * 1024))

    def test_case_skipped_for_saturation_does_not_accuse(self):
        # Même traitement qu'un budget dépassé : skipped → « indetermines », jamais
        # « incoherents » (vérifié par le verdict des canaris).
        cases = [{"index": 0}, {"index": 1, "canary": "pass"}, {"index": 2, "canary": "fail"}]
        outcomes = {0: outcome(True), 1: outcome(False, ran=False, skipped=True),
                    2: outcome(False, ran=False, skipped=True)}
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
        self.assertEqual(supervisor.EVENTS, [])


class ReadCappedTest(unittest.TestCase):
    def test_small_file_whole(self):
        # En binaire : en mode texte, Windows ecrirait CRLF et le test comparerait
        # d'autres octets que ceux que le superviseur lit reellement (fichiers LF).
        with tempfile.NamedTemporaryFile("wb", suffix=".out", delete=False) as f:
            f.write("début\nfin\n".encode("utf-8"))
        try:
            self.assertEqual(supervisor.read_capped(f.name, cap=1024), "début\nfin\n")
        finally:
            os.unlink(f.name)

    def test_large_file_head_and_tail(self):
        # Copie honnête mais bavarde : le jeton, imprimé EN FIN de sortie, doit survivre à la
        # troncature — sinon fausse accusation (« jeton absent »).
        with tempfile.NamedTemporaryFile("w", suffix=".out", delete=False) as f:
            f.write("tete-visible\n" + ("x" * 10000) + "\n[MOODIT] jeton=42\n")
        try:
            text = supervisor.read_capped(f.name, cap=1024)
            self.assertIn("tete-visible", text)
            self.assertIn("[MOODIT] jeton=42", text)
            # Texte exact lu par execution-service (ExecutionService.SUPERVISOR_TRUNCATION_MARKER) :
            # un dump SQL de phase 1 tronqué est refusé, au lieu d'être noté amputé de son milieu.
            self.assertIn("(sortie tronquée au milieu", text)
        finally:
            os.unlink(f.name)


class SignatureFormsTest(unittest.TestCase):
    """Revue #246 : écritures légitimes qui n'étaient pas reconnues, d'où « aucune fonction
    exploitable » ou un bouchon faux — 0 (voire faux verdict muet) sur une réponse juste."""

    def test_c_unnamed_parameters_and_multiword_types(self):
        self.assertEqual(["int", "int"], supervisor._c_param_types("int, int"))
        self.assertEqual(["double"], supervisor._c_param_types("const double"))
        self.assertEqual(["int", "long"], supervisor._c_param_types("int a, long b = 3"))
        # `long double` n'est pas un `long` : plus de 2.5 tronqué en 2 sans diagnostic.
        self.assertIsNone(supervisor._c_param_types("long double"))
        self.assertIsNone(supervisor._c_param_types("long double x"))
        self.assertIsNone(supervisor._c_param_types("unsigned int"))
        api = {n: (c, m) for n, c, m in supervisor.cpp_object_api(
            "class Rect { int l, h; public: Rect(int, int); int aire(); int ajoute(int); };\n"
            "Rect::Rect(int a, int b) : l(a), h(b) {}\nint Rect::aire() { return l * h; }\n")}
        self.assertEqual([["int", "int"]], api["Rect"][0])
        self.assertIn(("int", "ajoute", ["int"]), api["Rect"][1])

    def test_c_function_defined_in_two_preprocessor_branches_is_stubbed_once(self):
        src = "#if 0\nint fact(int n) { return 0; }\n#else\nint fact(int n) { return n; }\n#endif\n"
        self.assertEqual([("int", "fact", ["int"])], supervisor.c_signatures(src))
        self.assertEqual([("int", "fact", ["int"])], supervisor.c_signatures(src, cpp=True))
        # C++ garde les vraies surcharges.
        both = "int f(int a) { return a; }\nint f(double a) { return 1; }\n"
        self.assertEqual(2, len(supervisor.c_signatures(both, cpp=True)))

    def test_go_parenthesized_or_named_result(self):
        src = ("func A(n int) (r int) {\n\treturn n\n}\nfunc B(n int) (int) {\n\treturn n\n}\n"
               "func C(n int) (int, error) {\n\treturn n, nil\n}\n"
               "type R struct{ a int }\nfunc NewR(a int) *R { return &R{a} }\n"
               "func (r *R) Aire() (v int) { return r.a }\n")
        self.assertEqual({"A", "B"}, {n for _, n, _ in supervisor.go_signatures(src)})
        self.assertEqual([("int", "Aire", [])], supervisor.go_object_api(src)[0][2])

    def test_rust_trait_impl_and_default_methods(self):
        src = ("pub trait Forme {\n    fn aire(&self) -> i32;\n"
               "    fn double_aire(&self) -> i32 { 2 * self.aire() }\n}\n"
               "pub struct Carre { c: i32 }\n"
               "impl Carre {\n    pub fn new(c: i32) -> Self { Carre { c } }\n}\n"
               "impl Forme for Carre {\n    fn aire(&self) -> i32 { self.c * self.c }\n}\n")
        api = {t: (c, m) for t, c, m in supervisor.rust_object_api(src)}
        names = {m[1] for m in api["Carre"][1]}
        self.assertEqual({"aire", "double_aire"}, names)
        self.assertEqual(["Forme"], supervisor.rust_implemented_traits(src))
        server = supervisor.rust_server_source([], src, supervisor.rust_object_api(src))
        self.assertIn("use crate::Forme as _;", server)
        # Sans trait : aucune importation, le gabarit reste valide.
        self.assertNotIn("as _;", supervisor.rust_server_source([("i32", "f", [])], "fn f() -> i32 { 1 }"))

    def test_cpp_operator_multiline_members_and_qualifiers(self):
        api = {n: (c, m) for n, c, m in supervisor.cpp_object_api(
            "class Rect {\n  int l, h;\npublic:\n  Rect(int largeur,\n       int hauteur) : l(largeur), h(hauteur) {}\n"
            "  int aire(int k,\n           int m) { return l * h * k * m; }\n"
            "  [[nodiscard]] int cote() const noexcept { return l; }\n};\n"
            "struct Carre { int operator()(int x) const { return x * x; } int f() { return 1; } };\n")}
        self.assertEqual([["int", "int"]], api["Rect"][0])
        self.assertEqual({("aire", ("int", "int")), ("cote", ())},
                         {(n, tuple(t)) for _r, n, t in api["Rect"][1]})
        # `operator()` n'est pas une méthode nommée `operator`.
        self.assertEqual([("int", "f", [])], api["Carre"][1])
        src = ("constexpr int carre(int x) { return x * x; }\nint cube(int x) noexcept { return x * x * x; }\n"
               "[[nodiscard]] int moitie(int x) { return x / 2; }\nauto dbl(int x) -> int { return 2 * x; }\n")
        self.assertEqual(["carre", "cube", "moitie", "dbl"],
                         [n for _r, n, _t in supervisor.c_signatures(src, cpp=True)])
        # Le retour en fin de signature est du C++ seulement.
        self.assertEqual(["carre", "cube", "moitie"], [n for _r, n, _t in supervisor.c_signatures(src)])
        self.assertEqual([("i32", "carre", ["i32"])], supervisor.rust_signatures(
            "pub const fn carre(x: i32) -> i32 { x * x }\nfn main() {}\n"))

    def test_cpp_final_inherited_ctors_and_spaced_labels(self):
        # Revue #246 : `final` avant la base, `using Forme::Forme;`, `public :` et
        # `virtual public` faisaient ignorer la classe (0 sur une réponse juste).
        api = {n: (c, m) for n, c, m in supervisor.cpp_object_api(
            "class Forme {\npublic:\n  Forme(int c) : c(c) {}\n  int aire() { return c * c; }\n"
            "protected:\n  int c;\n};\n"
            "class Carre final : public Forme {\npublic:\n  Carre(int c) : Forme(c) {}\n};\n"
            "class Cube : public Forme {\npublic:\n  using Forme::Forme;\n};\n"
            "class Calc {\npublic :\n  int add(int a, int b) { return a + b; }\n};\n"
            "struct Base { int un() { return 1; } };\n"
            "struct Derivee final : virtual public Base { };\n")}
        self.assertEqual(([["int"]], [("int", "aire", [])]), api["Carre"])
        # Aucun constructeur déclaré : le défaut (vérifié par moodit_cree), plus ceux repris.
        self.assertEqual(([[], ["int"]], [("int", "aire", [])]), api["Cube"])
        self.assertEqual([("int", "add", ["int", "int"])], api["Calc"][1])
        # Dérivée sans constructeur déclaré, base constructible sans argument : défaut implicite.
        self.assertEqual(([[]], [("int", "un", [])]), api["Derivee"])
        # Base sans constructeur par défaut, ou au constructeur protégé : la dérivée reçoit le
        # sien ; moodit_cree tranche à la compilation (revue #246).
        protege = {n: c for n, c, _m in supervisor.cpp_object_api(
            "class Forme {\nprotected:\n  Forme() {}\npublic:\n  int aire() { return 1; }\n};\n"
            "class Carre : public Forme {\npublic:\n  int cote() { return 2; }\n};\n")}
        self.assertEqual([[]], protege["Carre"])
        # `public::x` n'est pas une étiquette.
        self.assertEqual([], [n for n, _c, _m in supervisor.cpp_object_api(
            "class K {\n  int f() { return 1; }\n};\n")])

    def test_c_scalar_spellings(self):
        for text, expected in (("long int", "long"), ("signed", "int"), ("signed int", "int"),
                               ("long signed int", "long"), ("signed long", "long"),
                               ("double", "double"), ("long long", None), ("long double", None),
                               ("unsigned int", None), ("int int", None), ("", None)):
            with self.subTest(text=text):
                self.assertEqual(expected, supervisor.c_scalar_type(text))
        self.assertEqual([("long", "f", ["long", "int"]), ("int", "g", ["int"])],
                         supervisor.c_signatures("long int f(long int a, signed b) { return a; }\n"
                                                 "signed int g(signed int x) { return x; }\n"))
        self.assertEqual([], supervisor.c_signatures("long long h(long long x) { return x; }\n"
                                                     "long double k(long double x) { return x; }\n"))
        self.assertEqual(["long", "int"], supervisor._c_param_types("long int a, signed"))
        self.assertIsNone(supervisor._c_param_types("unsigned int a"))

    def test_cpp_return_type_on_its_own_line(self):
        api = {n: m for n, _c, m in supervisor.cpp_object_api(
            "class C {\npublic:\n  int\n  somme(int a) const { return a; }\n"
            "  [[nodiscard]]\n  long int\n  grand() { return 1; }\n"
            "#ifdef X\n  int cache() { return 0; }\n#endif\n};\n")}
        self.assertEqual({("int", "somme"), ("long", "grand"), ("int", "cache")},
                         {(r, n) for r, n, _t in api["C"]})

    def test_c_server_neutralizes_submitted_keyword_macros(self):
        server = supervisor.c_server_source([("int", "f", ["int"])], "#define int long long\n",
                                            cpp=True)
        self.assertLess(server.index("#define int long long"), server.index("#undef int\n"))
        self.assertLess(server.index("#undef int\n"), server.index("moodit_lit_int"))
        self.assertIn("(int) ::f(moodit_a0)", server)

    def test_c_preprocessor_segment(self):
        pre = ('# 1 "pp.c"\n# 1 "<built-in>"\nint builtin_noise;\n# 1 "/usr/include/stdio.h" 1 3\n'
               "int printf(const char *, ...);\n# 3 \"pp.c\" 2\nint doubler(int x) { return 2 * x; }\n")
        self.assertEqual("int doubler(int x) { return 2 * x; }",
                         supervisor.c_student_segment(pre, "pp.c"))
        # Revue #246 : le fichier qui s'inclut LUI-MÊME n'est compté qu'au niveau 0 — chaque
        # niveau d'inclusion le recopiait, 97 Ko devenaient 14 Mo d'extraction.
        nested = ('# 1 "pp.cpp"\nint a;\n# 1 "pp.cpp" 1\nint a;\n# 1 "pp.cpp" 1\nint a;\n'
                  '# 2 "pp.cpp" 2\n# 2 "pp.cpp" 2\nint b;\n# 1 "/usr/include/x.h" 1 3\nint h;\n'
                  '# 3 "pp.cpp" 2\nint c;\n')
        self.assertEqual("int a;\nint b;\nint c;", supervisor.c_student_segment(nested, "pp.cpp"))
        # Budget en octets : dépassé, None (repli sur le texte brut) — sans avoir lu la suite.
        self.assertIsNone(supervisor.c_student_segment(nested, "pp.cpp", budget=10))
        self.assertEqual("int a;\nint b;\nint c;",
                         supervisor.c_student_segment(nested, "pp.cpp", budget=30))

    def test_c_preprocessor_segment_is_streamed_within_budget(self):
        # Revue #246 : toute la sortie de `gcc -E` était décodée et découpée avant la borne ; des
        # millions de lignes courtes coûtaient plus de 500 Mio au superviseur. En flux, la
        # mémoire reste bornée par le budget, quelle que soit la longueur de la sortie.
        # La lecture s'arrête aussi au premier octet au-delà du budget : 10 000 octets de lignes
        # de 2 octets, soit 5 001 lignes consommées, jamais les 2 000 000.
        import tracemalloc
        consumed = 0

        def lines():
            nonlocal consumed
            yield b'# 1 "pp.c"\n'
            for _ in range(2_000_000):
                consumed += 1
                yield b"x\n"
        tracemalloc.start()
        try:
            result = supervisor.c_student_segment(lines(), "pp.c", budget=10_000)
            _current, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertIsNone(result)
        self.assertLess(peak, 2 * 1024 * 1024)
        self.assertEqual(5_001, consumed)

    def test_cpp_const_overload_gives_one_stub(self):
        api = {n: m for n, _c, m in supervisor.cpp_object_api(
            "class Compteur {\n  int v;\npublic:\n  Compteur(int x) : v(x) {}\n"
            "  int valeur() const { return v; }\n  int valeur() { return v; }\n};\n")}
        self.assertEqual([("int", "valeur", [])], api["Compteur"])
        # Sans directive conditionnelle : pas de préprocesseur (None), le texte brut est lu.
        self.assertIsNone(supervisor.c_directives_only_source("int f(int x) { return x; }", "gcc",
                                                              "-std=gnu17", ".", "c"))
        self.assertTrue(supervisor.C_CONDITIONAL.search("int a;\n  #  ifdef X\n"))
        self.assertFalse(supervisor.C_CONDITIONAL.search("#include <stdio.h>\n#define A 1\n"))

    def test_default_arities(self):
        self.assertEqual(0, supervisor.trailing_defaults("int a, int b"))
        self.assertEqual(2, supervisor.trailing_defaults("int a, int b = 1, int c = 2"))
        self.assertEqual(0, supervisor.trailing_defaults(""))
        # Arité réduite gardée seulement sans conflit : déclaration explicite de même arité, ou
        # deux entrées qui réduisent à la même signature (appel ambigu dans le serveur).
        self.assertEqual(
            [("int", "f", ["int", "int"]), ("int", "f", ["int"])],
            supervisor.with_default_arities([("int", "f", ["int", "int"], 1),
                                             ("int", "f", ["int"], 0)]))
        self.assertEqual(
            [("int", "g", ["int", "int"]), ("int", "g", ["int", "double"])],
            supervisor.with_default_arities([("int", "g", ["int", "int"], 1),
                                             ("int", "g", ["int", "double"], 1)]))
        self.assertEqual(
            [("long", "s", ["int", "int", "int"]), ("long", "s", ["int", "int"]), ("long", "s", ["int"])],
            supervisor.with_default_arities([("long", "s", ["int", "int", "int"], 2)]))
        # C# : statiques et méthodes d'instance.
        cs = chr(10).join(["class Solution {",
                           "    static int Somme(int n, int acc = 0) { return n == 0 ? acc : Somme(n - 1, acc + n); }",
                           "    public int Echelle(int x, int k = 2) { return x * k; }",
                           "}", ""])
        self.assertEqual([("int", "Somme", ["int", "int"]), ("int", "Somme", ["int"])],
                         supervisor.cs_signatures(cs))
        _ctors, methods = supervisor.cs_object_api(cs, "Solution")
        self.assertEqual([("int", "Echelle", ["int", "int"]), ("int", "Echelle", ["int"])], methods)
        # Serveur C# : arité réduite acceptée seulement sur des paramètres optionnels, et
        # surcharges essayées par nombre de paramètres croissant.
        server = supervisor.cs_server_source(["Solution"])
        self.assertIn("if (!attendus[i].IsOptional) { return false; }", server)
        self.assertIn("donnes[i] = attendus[i].DefaultValue", server)
        self.assertEqual(3, server.count("ParArite("))

    def test_cpp_reference_parameters(self):
        self.assertEqual(["int", "double"], supervisor._c_param_types("const int& x, const double &y"))
        self.assertEqual(["int"], supervisor._c_param_types("const int &"))
        self.assertEqual(["long"], supervisor._c_param_types("long const& x"))
        # Non constante : la modification ne reviendrait pas au harnais — écartée.
        self.assertIsNone(supervisor._c_param_types("int &a"))
        self.assertIsNone(supervisor._c_param_types("int& a, const int& b"))
        self.assertIsNone(supervisor._c_param_types("int&& x"))
        self.assertIsNone(supervisor._c_param_types("int *x"))
        # Construction testée sur des variables (lvalues), comme l'appel réel.
        stacks, _ = supervisor.cpp_object_dispatch([("Rect", [["int"]], [])])
        self.assertIn("__is_constructible(moodit_K, moodit_A&...)", stacks)

    def test_cpp_default_on_the_prototype_only(self):
        # Revue #246 : prototype en haut (valeur par défaut), définition après `main` (sans).
        src = ("int somme(int n, int acc = 0);\nint main() { return somme(3); }\n"
               "int somme(int n, int acc) { return n == 0 ? acc : somme(n - 1, acc + n); }\n")
        self.assertEqual([("int", "somme", ["int", "int"]), ("int", "somme", ["int"])],
                         supervisor.c_signatures(src, cpp=True))
        # En C, pas de valeur par défaut ; un prototype seul ne crée rien.
        self.assertEqual([], supervisor.c_signatures("int f(int x);\n", cpp=True))
        self.assertEqual([("int", "carre", ["int"])],
                         supervisor.c_signatures("int carre(const int& x) { return x * x; }\n", cpp=True))

    def test_go_promoted_methods_through_embedding(self):
        src = ("type Rectangle struct {\n\tl, h int\n}\n"
               "func (r *Rectangle) Aire() int { return r.l * r.h }\n"
               "func (r Rectangle) Perimetre() int { return 2 * (r.l + r.h) }\n"
               "type Carre struct {\n\t*Rectangle `json:\"r\"`\n\tnom string\n}\n"
               "func NewCarre(c int) *Carre { return &Carre{&Rectangle{c, c}, \"c\"} }\n"
               "func (c Carre) Perimetre(k int) int { return k }\n")
        self.assertEqual({"Carre": ["Rectangle"]}, supervisor.go_embedded_types(src))
        api = {t: m for t, _c, m in supervisor.go_object_api(src)}
        # `Aire` promue ; `Perimetre` de Carre MASQUE celle de Rectangle (règle de Go).
        self.assertEqual({("Perimetre", ("int",)), ("Aire", ())},
                         {(m[1], tuple(m[2])) for m in api["Carre"]})

    def test_rust_attribute_before_fn(self):
        self.assertEqual(["doubler", "tripler"], [n for _r, n, _t in supervisor.rust_signatures(
            "#[inline] pub fn doubler(x: i32) -> i32 { 2 * x }\n"
            "#[must_use] #[inline(always)] fn tripler(x: i32) -> i32 { 3 * x }\nfn main() {}\n")])

    def test_go_method_with_unnamed_receiver(self):
        src = ("type Calculatrice struct{}\n"
               "func (Calculatrice) Additionner(a, b int) int { return a + b }\n"
               "func (*Calculatrice) Un() int { return 1 }\n")
        self.assertEqual({"Additionner", "Un"},
                         {m[1] for m in supervisor.go_object_api(src)[0][2]})

    def test_rust_struct_with_attributes_or_restricted_visibility(self):
        for head in ("#[derive(Debug, Clone)] struct", "pub(crate) struct",
                     "#[derive(Debug)]\npub(crate) struct"):
            src = (head + " Rectangle { largeur: i32, hauteur: i32 }\n"
                   "impl Rectangle {\n    fn aire(&self) -> i32 { self.largeur * self.hauteur }\n}\n")
            with self.subTest(head=head):
                api = {t: (c, m) for t, c, m in supervisor.rust_object_api(src)}
                self.assertEqual({"aire"}, {m[1] for m in api["Rectangle"][1]})
                self.assertEqual(["largeur", "hauteur"],
                                 [f[0] for f in supervisor.rust_struct_fields(src)["Rectangle"]])
        self.assertIn("Unite", supervisor.RUST_UNIT_STRUCT.findall("#[derive(Debug)] pub(crate) struct Unite;"))

    def test_harness_mentions_ignores_comments_and_literals(self):
        # Un nom cité en commentaire faisait refuser la fonction d'aide d'une réponse juste.
        self.assertFalse(supervisor.harness_mentions(
            "// le plus grand (max) des trois\nreturn PlusGrand(1, 5, 3) == 5", "max"))
        self.assertFalse(supervisor.harness_mentions("/* abs */ return f(2) == 2;", "abs"))
        self.assertFalse(supervisor.harness_mentions('return s == "max" && r == `abs`', "max"))
        self.assertTrue(supervisor.harness_mentions("return max(f(1), 2) == 2 // max", "max"))
        self.assertEqual((["max"], [], []), supervisor.go_hidden_names(
            ["max"], "return max(PlusGrand(1, 5), 0) == 5"))
        self.assertEqual(([], [], ["max"]), supervisor.go_hidden_names(
            ["max"], "// max\nreturn PlusGrand(1, 5) == 5"))

    def test_java_default_method_through_a_parent_interface(self):
        polygone = ('Compiled from "S.java"\ninterface Polygone extends Forme, java.io.Serializable {\n}\n')
        self.assertEqual(["Forme", "java.io.Serializable"], supervisor.java_interfaces(polygone))
        merged = supervisor.inherit_instance_methods(
            {"Forme": ((), [("int", "doubleAire", [])]), "Polygone": ((), []),
             "Carre": ([[]], [("int", "aire", [])])},
            {"Carre": ["Polygone"], "Polygone": ["Forme"]})
        self.assertIn(("int", "doubleAire", []), merged["Carre"])

    def test_java_interface_default_methods(self):
        iface = ('Compiled from "S.java"\ninterface Forme {\n  public abstract int aire();\n'
                 '  public default int doubleAire();\n}\n')
        self.assertEqual(("Forme", [("int", "doubleAire", [])]),
                         supervisor.java_interface_defaults(iface))
        self.assertEqual((None, []), supervisor.java_interface_defaults(
            'Compiled from "S.java"\nclass Carre implements Forme {\n}\n'))
        self.assertEqual(["Forme", "java.lang.Comparable"], supervisor.java_interfaces(
            "class Cube extends Carre implements Forme, java.lang.Comparable<Cube> {\n"))
        merged = supervisor.inherit_instance_methods(
            {"Forme": ((), [("int", "doubleAire", [])]), "Carre": ([[]], [("int", "aire", [])])},
            {"Carre": ["Forme"]})
        self.assertEqual([("int", "aire", []), ("int", "doubleAire", [])], merged["Carre"])


class IsolationInvariantsTest(unittest.TestCase):
    """Revue #246 : ces propriétés de cloisonnement pouvaient régresser sans qu'aucun test
    unitaire ne rougisse (seuls les tests d'intégration contre les images les voyaient)."""

    def test_grader_runs_under_its_own_uid(self):
        self.assertNotEqual(supervisor.grader_uid(), supervisor.STUDENT_UID)
        calls = []
        with unittest.mock.patch.object(supervisor, "mark_oom_victim"), \
                unittest.mock.patch.object(supervisor, "resource", create=True), \
                unittest.mock.patch.object(supervisor.os, "setsid", create=True), \
                unittest.mock.patch.object(supervisor.os, "setgroups", create=True), \
                unittest.mock.patch.object(supervisor.os, "setgid", create=True,
                                           side_effect=lambda g: calls.append(("gid", g))), \
                unittest.mock.patch.object(supervisor.os, "setuid", create=True,
                                           side_effect=lambda u: calls.append(("uid", u))):
            supervisor.demote_grader()
        self.assertEqual([("gid", supervisor.grader_uid()), ("uid", supervisor.grader_uid())], calls)

    @unittest.skipUnless(os.name == "posix", "modes POSIX ; couvert en CI (Linux)")
    def test_private_file_is_0600_from_creation(self):
        directory = tempfile.mkdtemp()
        try:
            path = os.path.join(directory, "noteur.c")
            old = os.umask(0)
            try:
                supervisor.write_private(path, "secret")
            finally:
                os.umask(old)
            self.assertEqual(0o600, stat.S_IMODE(os.stat(path).st_mode))
        finally:
            supervisor.remove_tree(directory)

    def test_sources_are_locked_root_0700(self):
        directory = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(directory, "sous"))
            open(os.path.join(directory, "sous", "harnais_rpc.c"), "w").close()
            with unittest.mock.patch.object(supervisor.os, "chown", create=True) as chown, \
                    unittest.mock.patch.object(supervisor.os, "chmod") as chmod:
                supervisor.lock_sources(directory)
            modes = {call.args[1] for call in chmod.call_args_list}
            self.assertEqual({0o700}, modes)
            self.assertEqual(3, len(chmod.call_args_list))   # racine, dossier, fichier
            # Propriétaire root : un chown vers l'UID étudiant laisserait le harnais lisible.
            self.assertEqual({(0, 0)}, {call.args[1:3] for call in chown.call_args_list})
            self.assertEqual(3, len(chown.call_args_list))
        finally:
            supervisor.remove_tree(directory)

    def test_grader_dirs_are_never_built_in_the_student_work_dir(self):
        # Sous work/ (à l'étudiant), le dossier du noteur redevenait renommable par le code noté.
        import inspect
        for function in (supervisor.run_java_rpc, supervisor.finish_rpc_pair):
            source = inspect.getsource(function)
            self.assertIn("grader_dir(case_dir", source, function.__name__)
            self.assertNotIn("grader_dir(work", source, function.__name__)

    def test_every_case_source_is_locked_before_the_first_case_runs(self):
        import inspect
        source = inspect.getsource(supervisor.main)
        lock = source.index('lock_src_dir(os.path.join(BOX, "cases", str(case["index"])))')
        # Avant le MÉLANGE et la boucle des cas, pas seulement avant execute_case : déplacé dans
        # `for case in order:`, juste avant execute_case, un cas en cours lisait le harnais des
        # cas suivants (cas cachés compris).
        self.assertLess(lock, source.index("rng.shuffle(order)"))
        self.assertLess(lock, source.index("for case in order:"))
        self.assertLess(lock, source.index("execute_case("))


class InheritanceTest(unittest.TestCase):
    """Revue #246 : une méthode héritée et non redéfinie manquait au bouchon (Java, C#, C++) —
    `new Carre(3).aire()` ne compilait pas, 0 pour l'étudiant qui hérite au lieu de redéfinir."""

    def test_inherit_instance_methods(self):
        apis = {"Forme": ([["int"]], [("int", "aire", []), ("int", "cote", ["int"])]),
                "Carre": ([["int"]], [("int", "cote", ["int"])]),
                "Cube": ([["int"]], []),
                "A": ([], [("int", "a", [])]), "B": ([], [])}
        parents = {"Carre": "Forme", "Cube": "Carre", "Forme": None, "A": "B", "B": "A",
                   "Seule": "Inconnue"}
        merged = supervisor.inherit_instance_methods(apis, parents)
        # Redéfinie : celle de la classe, une seule fois ; héritée : ajoutée après les siennes.
        self.assertEqual([("int", "cote", ["int"]), ("int", "aire", [])], merged["Carre"])
        # Sur deux niveaux.
        self.assertEqual([("int", "cote", ["int"]), ("int", "aire", [])], merged["Cube"])
        self.assertEqual([("int", "aire", []), ("int", "cote", ["int"])], merged["Forme"])
        # Chaîne circulaire : s'arrête, sans boucle infinie.
        self.assertEqual([("int", "a", [])], merged["B"])
        # Mère hors du code soumis : rien à ajouter.
        self.assertNotIn("Seule", merged)

    def test_java_superclass(self):
        self.assertEqual("Forme", supervisor.java_superclass(
            'Compiled from "S.java"\nclass Carre extends Forme {\n  Carre(int);\n}\n'))
        self.assertEqual("Outer.Base", supervisor.java_superclass(
            "public final class Outer$Inner extends Outer$Base implements X {\n}\n"))
        self.assertIsNone(supervisor.java_superclass("class Forme {\n  int aire();\n}\n"))

    def test_csharp_inherited_methods(self):
        src = ("class Forme { protected int c; public Forme(int c) { this.c = c; }"
               " public int Aire() { return c * c; } }\n"
               "class Carre : Forme, System.IComparable { public Carre(int c) : base(c) {}"
               " public int CompareTo(object o) { return 0; } }\n")
        _ctors, methods = supervisor.cs_object_api(src, "Carre")
        self.assertIn(("int", "Aire", []), methods)
        self.assertIn("Carre", supervisor.cs_object_classes(src))

    def test_cpp_inherited_methods_public_base_only(self):
        src = ("class Forme { public: Forme(int c) : c(c) {} int aire() { return c * c; }"
               " protected: int c; };\n"
               "class Carre : public Forme { public: Carre(int c) : Forme(c) {} };\n"
               "class Cachee : Forme { public: Cachee(int c) : Forme(c) {} };\n"
               "struct Ouverte : Forme { Ouverte(int c) : Forme(c) {} };\n")
        api = {name: methods for name, _ctors, methods in supervisor.cpp_object_api(src)}
        self.assertEqual([("int", "aire", [])], api["Carre"])
        self.assertEqual([("int", "aire", [])], api["Ouverte"])
        # Héritage privé (défaut d'une `class`) : aire() n'est pas appelable de l'extérieur.
        self.assertNotIn("Cachee", api)

    def test_cpp_derived_declaration_hides_every_base_overload_of_that_name(self):
        # `aire(int)` dans Carre masque `aire()` de Forme (règle C++) : l'hériter quand même
        # faisait générer au serveur `->aire()`, qui ne compile pas — 0 sur une réponse juste.
        src = ("class Forme { public: Forme(int c) : c(c) {} int aire() { return c * c; }"
               " int cote() { return c; } int f() { return 1; } protected: int c; };\n"
               "class Carre : public Forme { public: Carre(int c) : Forme(c) {}"
               " int aire(int k) { return k * cote(); } int g = f(); };\n"
               "class Rond : public Forme { public: Rond(int c) : Forme(c) {}"
               " using Forme::aire; int aire(int k) { return k; } };\n"
               "class Cache : public Forme { public: Cache(int c) : Forme(c) {}"
               " private: void cote(std::string s) {} };\n")
        api = {name: {(n, tuple(t)) for _r, n, t in methods}
               for name, _ctors, methods in supervisor.cpp_object_api(src)}
        self.assertNotIn(("aire", ()), api["Carre"])
        self.assertIn(("aire", ("int",)), api["Carre"])
        # Un appel dans un corps (`cote()`) ou un champ initialisé (`g = f()`) ne déclare rien.
        self.assertIn(("cote", ()), api["Carre"])
        self.assertIn(("f", ()), api["Carre"])
        # `using Forme::aire;` rend les surcharges de la base visibles.
        self.assertIn(("aire", ()), api["Rond"])
        # Une déclaration privée, même non transportable, masque aussi.
        self.assertNotIn(("cote", ()), api["Cache"])

    def test_cpp_abstract_base_lends_its_methods(self):
        src = ("class Forme { public: virtual int aire() = 0; int double_aire() { return 2 * aire(); } };\n"
               "class Carre : public Forme { public: Carre(int c) : c(c) {} int aire() { return c * c; }"
               " private: int c; };\n")
        api = {name: methods for name, _ctors, methods in supervisor.cpp_object_api(src)}
        self.assertNotIn("Forme", api)
        self.assertEqual({("int", "aire", ()), ("int", "double_aire", ())},
                         {(r, n, tuple(t)) for r, n, t in api["Carre"]})


class RemoveTreeTest(unittest.TestCase):
    """Revue #246 : shutil.rmtree, récursif sous le Python des images, levait RecursionError sur
    une arborescence profonde que le code soumis crée en quelques millisecondes — le superviseur
    mourait sans JSON (502 « sans verdict » à la demande)."""

    def _deep(self, root, depth):
        # Comme le code soumis : mkdir puis chdir, niveau par niveau (os.makedirs est lui-même
        # récursif, et un chemin absolu dépasserait PATH_MAX).
        os.mkdir(root)
        here = os.getcwd()
        try:
            os.chdir(root)
            for _ in range(depth):
                os.mkdir("d")
                os.chdir("d")
            with open("f", "w") as f:
                f.write("x")
        finally:
            os.chdir(here)

    @unittest.skipUnless(os.name == "posix", "chemins profonds POSIX ; couvert en CI (Linux)")
    def test_deep_tree_removed_without_raising(self):
        for remover in (supervisor.remove_tree, supervisor._remove_tree_iterative):
            with self.subTest(remover=remover.__name__):
                root = tempfile.mkdtemp()
                try:
                    self._deep(os.path.join(root, "t"), 1500)
                    remover(os.path.join(root, "t"))
                    self.assertFalse(os.path.lexists(os.path.join(root, "t")))
                finally:
                    supervisor.remove_tree(root)

    @unittest.skipUnless(os.name == "posix", "chemins profonds POSIX ; couvert en CI (Linux)")
    def test_walk_tree_reaches_every_level_without_recursion(self):
        # os.walk est récursif avant Python 3.12 : un `package a.a.a…` de mille segments, que
        # javac déploie en dossiers, lui faisait lever RecursionError dans set_owner_mode_tree.
        root = tempfile.mkdtemp()
        try:
            self._deep(os.path.join(root, "t"), 1500)
            levels = list(supervisor.walk_tree(os.path.join(root, "t")))
            self.assertEqual(1501, len(levels))
            self.assertEqual(["f"], levels[-1][2])
            self.assertEqual([], list(supervisor.walk_tree(os.path.join(root, "absent"))))
        finally:
            supervisor.remove_tree(root)

    @unittest.skipUnless(os.name == "posix", "liens symboliques POSIX ; couvert en CI (Linux)")
    def test_walk_tree_lists_links_without_following_them(self):
        root = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(root, "cible", "dedans"))
            os.makedirs(os.path.join(root, "t", "sous"))
            os.symlink(os.path.join(root, "cible"), os.path.join(root, "t", "lien"))
            walked = {r: (sorted(d), sorted(o)) for r, d, o in supervisor.walk_tree(os.path.join(root, "t"))}
            self.assertEqual((["sous"], ["lien"]), walked[os.path.join(root, "t")])
            self.assertNotIn(os.path.join(root, "t", "lien"), walked)
        finally:
            supervisor.remove_tree(root)

    @unittest.skipUnless(os.name == "posix", "liens symboliques POSIX ; couvert en CI (Linux)")
    def test_link_is_removed_not_followed_and_missing_path_is_fine(self):
        root = tempfile.mkdtemp()
        try:
            target = os.path.join(root, "cible")
            os.makedirs(target)
            with open(os.path.join(target, "garde"), "w") as f:
                f.write("x")
            link = os.path.join(root, "lien")
            os.symlink(target, link)
            supervisor.remove_tree(link)
            self.assertFalse(os.path.lexists(link))
            self.assertTrue(os.path.exists(os.path.join(target, "garde")))
            supervisor.remove_tree(os.path.join(root, "absent"))   # ne lève pas
        finally:
            shutil.rmtree(root, ignore_errors=True)


class SubstitutePlaceholdersTest(unittest.TestCase):
    def test_substitutes_in_harness_only(self):
        # Le fichier ETUDIANT n'est jamais reecrit (defense en profondeur).
        with tempfile.TemporaryDirectory() as case_dir:
            src = os.path.join(case_dir, "src")
            os.makedirs(src)
            for ident in ("harnais_rpc.c", "solution.c"):
                with open(os.path.join(src, ident), "w", encoding="utf-8") as f:
                    f.write("a=__MOODIT_A__; b=__MOODIT_B__;")
            supervisor.substitute_placeholders(case_dir, {"__MOODIT_A__": "7",
                                                          "__MOODIT_B__": "7"})
            with open(os.path.join(src, "harnais_rpc.c"), encoding="utf-8") as f:
                self.assertEqual(f.read(), "a=7; b=7;")
            with open(os.path.join(src, "solution.c"), encoding="utf-8") as f:
                self.assertEqual(f.read(), "a=__MOODIT_A__; b=__MOODIT_B__;")


class ObjectApiTest(unittest.TestCase):
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

    def test_go_fields_and_api(self):
        self.assertEqual(supervisor.go_struct_fields(self.GO),
                         {"Rectangle": [("largeur", "int"), ("hauteur", "int")]})
        # Le dernier membre dit si le constructeur rend un POINTEUR : l'aiguillage doit le savoir
        # pour ne pas prendre l'adresse d'une adresse.
        self.assertEqual(supervisor.go_object_api(self.GO),
                         [("Rectangle", [("NewRectangle", ["int", "int"], False)],
                           [("int", "aire", [])])])

    def test_go_type_without_constructor_stays_proxied(self):
        # L'idiome Go : pas de constructeur, un littéral à champs nommés. Refuser ce cas
        # écartait la forme que les profs écrivent (et celle du quiz de démo).
        without_ctor = self.GO.replace(
            "func NewRectangle(l int, h int) Rectangle {\n"
            "\treturn Rectangle{largeur: l, hauteur: h}\n}\n\n", "")
        self.assertEqual(supervisor.go_object_api(without_ctor),
                         [("Rectangle", [], [("int", "aire", [])])])

    def test_go_stub_captures_fields(self):
        obj_list = supervisor.go_object_api(self.GO)
        field_list = supervisor.go_struct_fields(self.GO)
        stub_src = supervisor.go_object_stub(obj_list, field_list)
        # Le bouchon MIROITE les champs (le harnais écrit son littéral habituel) et la méthode
        # construit l'objet CHEZ l'étudiant au moment de l'appel.
        self.assertIn("type Rectangle struct {\n    largeur int\n    hauteur int\n}", stub_src)
        self.assertIn('mooditNouvelle("Rectangle", []interface{}{o.largeur, o.hauteur})', stub_src)
        # La fonction-constructeur reste proxifiée, en relisant les champs du résultat.
        self.assertIn('mooditChamps("NewRectangle"', stub_src)

    def test_go_dispatch_covers_literal_method_and_constructor(self):
        obj_list = supervisor.go_object_api(self.GO)
        field_list = supervisor.go_struct_fields(self.GO)
        new_branch, method_branch = supervisor.go_object_dispatch(obj_list, field_list)
        self.assertIn('case "Rectangle":', new_branch)
        self.assertIn('case "NewRectangle":', new_branch)
        # La boucle des méthodes ne doit PAS être sautée pour un type à champs capturés : elle
        # l'était, et tout appel de méthode remontait « methode inconnue ».
        self.assertIn('case "Rectangle.aire":', method_branch)

    def test_rust_fields_and_api(self):
        self.assertEqual(supervisor.rust_struct_fields(self.RUST),
                         {"Rectangle": [("largeur", "i32"), ("hauteur", "i32")]})
        self.assertEqual(supervisor.rust_object_api(self.RUST),
                         [("Rectangle", [("new", ["i32", "i32"])], [("i32", "aire", [])])])

    def test_rust_stub_and_dispatch(self):
        obj_list = supervisor.rust_object_api(self.RUST)
        field_list = supervisor.rust_struct_fields(self.RUST)
        stub_src = supervisor.rust_object_stub(obj_list, field_list)
        self.assertIn("struct Rectangle {\n    largeur: i32,\n    hauteur: i32,\n}", stub_src)
        self.assertIn('"|new|Rectangle"', stub_src)
        stacks, branches = supervisor.rust_object_dispatch(obj_list, field_list)
        self.assertIn("let mut moodit_rectangle: Vec<crate::Rectangle>", stacks)
        self.assertIn('"new|Rectangle" =>', branches)
        self.assertIn('"new|Rectangle::new" =>', branches)
        self.assertIn('"method|Rectangle.aire" =>', branches)
        self.assertNotIn("unsafe", stub_src + stacks + branches)

    def test_cpp_class_spans_and_api(self):
        self.assertEqual(len(supervisor.cpp_class_spans(self.CPP)), 1)
        self.assertEqual(supervisor.cpp_object_api(self.CPP),
                         [("Rectangle", [["int", "int"]], [("int", "aire", [])])])

    def test_cpp_private_method_excluded(self):
        _, _, method_list = supervisor.cpp_object_api(self.CPP)[0]
        self.assertEqual([n for _, n, _ in method_list], ["aire"])

    def test_cpp_method_not_taken_for_free_function(self):
        # Sans ce filtre, `int aire()` passait pour une fonction de premier niveau et le bouchon
        # généré appelait `aire()` sans objet : le code soumis ne compilait plus.
        self.assertEqual(supervisor.c_signatures(self.CPP, cpp=True),
                         [("int", "doubler", ["int"])])
        self.assertIn(("int", "aire", []), supervisor.c_signatures(self.CPP))

    def test_cpp_stub_and_dispatch(self):
        obj_list = supervisor.cpp_object_api(self.CPP)
        stub_src = supervisor.cpp_object_stub(obj_list)
        self.assertIn("class Rectangle {", stub_src)
        self.assertIn('"%s|new|Rectangle(int,int)|%d|%d"', stub_src)
        stacks, branches = supervisor.cpp_object_dispatch(obj_list)
        self.assertIn("static ::Rectangle **moodit_objets_Rectangle = 0;", stacks)
        self.assertIn('moodit_egal(moodit_nom, "Rectangle.aire()")', branches)

    def test_java_stub_when_public_class_is_the_object(self):
        # Classe publique `Rectangle`, AUCUNE méthode statique : le bouchon de premier niveau
        # doit porter le constructeur et les méthodes, sinon la question était refusée.
        source = supervisor.java_stub_source(
            "Rectangle", [], (), [["int", "int"]], [("int", "aire", [])])
        self.assertIn("public Rectangle(int a0, int a1) {", source)
        self.assertIn('MooditRpc.nouvelle("Rectangle(int,int)"', source)
        self.assertIn("public int aire() {", source)
        self.assertNotIn("private Rectangle() {}", source)

    def test_java_stub_without_object_keeps_private_constructor(self):
        source = supervisor.java_stub_source("Solution", [("int", "doubler", ["int"])])
        self.assertIn("private Solution() {}", source)


class TypeAndIdiomGenerationTest(unittest.TestCase):
    """Types de retour et idiomes que la première version du générateur ne savait pas produire.

    Chacun rendait « Échec de compilation » à un étudiant dont le code était juste : ce sont les
    régressions les plus coûteuses du chemin non falsifiable, et aucune n'était mesurée."""

    def test_java_return_types_without_reserved_word(self):
        # `long`, `double` et `boolean` sont des mots réservés : le nom de la méthode RPC ne peut
        # pas être dérivé du type. `MooditRpc.double(…)` ne compilait pas.
        for ret, expected in (("int", "MooditRpc.integer("), ("long", "MooditRpc.long_("),
                                ("double", "MooditRpc.double_("),
                                ("boolean", "MooditRpc.boolean_("),
                                ("java.lang.String", "MooditRpc.string(")):
            source = supervisor.java_stub_source("Solution", [(ret, "f", ["int"])])
            self.assertIn(expected, source, ret)
            for reserve in ("MooditRpc.double(", "MooditRpc.long(", "MooditRpc.boolean("):
                self.assertNotIn(reserve, source)

    def test_rust_method_passes_its_arguments(self):
        obj_list = [("Compteur", [], [("i32", "plus", ["i32"])])]
        field_list = {"Compteur": [("valeur", "i32")]}
        _, branches = supervisor.rust_object_dispatch(obj_list, field_list)
        self.assertIn("let a0 =", branches)
        self.assertIn(".plus(a0)", branches)

    def test_rust_single_new_arm_per_key(self):
        # Un type à champs capturés ET doté d'un constructeur recevait deux bras identiques ;
        # le second, inatteignable, valait un avertissement `unreachable_patterns`.
        obj_list = [("Rectangle", [("new", ["i32", "i32"])], [("i32", "aire", [])])]
        field_list = {"Rectangle": [("largeur", "i32"), ("hauteur", "i32")]}
        _, branches = supervisor.rust_object_dispatch(obj_list, field_list)
        self.assertEqual(branches.count('"new|Rectangle::new" =>'), 1)
        self.assertEqual(branches.count('"new|Rectangle" =>'), 1)

    def test_go_pointer_receiver(self):
        source = ("package main\n\n"
                  "type Compteur struct {\n\tvaleur int\n}\n\n"
                  "func NewCompteur(v int) *Compteur {\n\treturn &Compteur{valeur: v}\n}\n\n"
                  "func (c *Compteur) Plus(n int) int { return c.valeur + n }\n")
        # Le constructeur rendant *T était ignoré, donc le type n'était pas proxifié du tout.
        obj_list = supervisor.go_object_api(source)
        self.assertEqual(obj_list, [("Compteur", [("NewCompteur", ["int"], True)],
                                   [("int", "Plus", ["int"])])])
        # Un récepteur pointeur n'écarte plus la capture de champs : la modification de l'objet
        # est reportée par relecture des champs (test_go_pointer_receiver_keeps_field_capture).
        self.assertEqual(supervisor.go_capture_fields(source), {"Compteur": [("valeur", "int")]})
        self.assertEqual(supervisor.go_pointer_methods(source), {("Compteur", "Plus")})
        # Et l'objet est stocké par POINTEUR : une méthode à récepteur pointeur ne peut pas être
        # appelée sur le résultat d'une assertion de type, qui n'est pas adressable.
        new_branch, method_branch = supervisor.go_object_dispatch(obj_list, {})
        self.assertIn("mooditObjets = append(mooditObjets, moodit_cree)", new_branch)
        self.assertIn(".(*Compteur).Plus(", method_branch)
        self.assertIn("func NewCompteur(a0 int) *Compteur {",
                      supervisor.go_object_stub(obj_list, {}))

    def test_go_value_receiver_keeps_field_capture(self):
        source = ("package main\n\n"
                  "type Rectangle struct {\n\tlargeur int\n\thauteur int\n}\n\n"
                  "func (r Rectangle) aire() int { return r.largeur * r.hauteur }\n")
        self.assertEqual(supervisor.go_pointer_methods(source), set())
        self.assertIn("Rectangle", supervisor.go_capture_fields(source))

    def test_double_keeps_its_precision(self):
        # `%g` s'arrête à 6 chiffres significatifs, pour les arguments COMME pour les retours :
        # 3.14159265 arrivait tronqué et une réponse juste était notée fausse.
        self.assertEqual(supervisor.C_TYPES["double"], "%.17g")
        stub_src = supervisor.c_grader_source([("double", "moyenne", ["double", "double"])],
                                             "return 1;", "N")
        self.assertIn("%.17g", stub_src)
        # Aucun `%g` nu (`%.17g` ne contient pas cette sous-chaîne).
        self.assertNotIn("%g", stub_src)

    def test_rust_string_sent_as_hex(self):
        # Le fil est à champs séparés par « | », une ligne par message : un « | » dans la valeur
        # décalait tout l'appel.
        self.assertEqual(supervisor.rust_send_args(["String"]), ' + "|" + &moodit_hexe(&a0)')
        self.assertEqual(supervisor.rust_send_args(["i32"]), ' + "|" + &a0.to_string()')
        grader_dir = supervisor.rust_grader_source([("String", "copie", ["String"])], "true", "N")
        self.assertIn("moodit_hexe(&a0)", grader_dir)
        self.assertIn("moodit_dehexe(&brut)", grader_dir)
        server = supervisor.rust_server_source([("String", "copie", ["String"])], "fn copie() {}")
        self.assertIn("moodit_dehexe(args.next()", server)
        self.assertIn("moodit_hexe(&crate::copie(a0))", server)

    def test_csharp_string_and_culture(self):
        self.assertIn("MooditRpc.Hexe(a0)", supervisor.cs_send_args(["string"]))
        self.assertIn("CultureInfo.InvariantCulture", supervisor.cs_send_args(["double"]))
        self.assertEqual(supervisor.CS_READ["string"], "MooditRpc.Dehexe(v)")

    def test_csharp_no_handle_constructor(self):
        # Il collisionnait avec un constructeur du code soumis prenant un seul int, et C#
        # n'autorise pas la surcharge par accessibilité : le noteur ne compilait plus.
        source = supervisor.cs_grader_source([], "return true;", "N", "Compteur",
                                             ctors=[["int"]],
                                             instance=[("int", "Plus", ["int"])])
        self.assertNotIn("private Compteur(int h)", source)
        self.assertIn("public Compteur(int a0)", source)

    def test_rust_captured_string_field_sent_as_hex(self):
        obj_list = [("Personne", [], [("String", "carte", [])])]
        field_list = {"Personne": [("nom", "String"), ("age", "i32")]}
        stub_src = supervisor.rust_object_stub(obj_list, field_list)
        # Le lecteur d'en face déhexe : un champ String envoyé en clair revenait mutilé.
        self.assertIn("&moodit_hexe(&self.nom)", stub_src)
        self.assertIn("&self.age.to_string()", stub_src)

    def test_go_exact_integers_beyond_two_to_the_53(self):
        # Le JSON décodé dans un interface{} donne un float64 : au-delà de 2^53, une somme de
        # grands nombres revenait fausse, et une réponse juste était notée fausse.
        self.assertEqual(supervisor.GO_CONV["int64"], "mooditEntier(%s)")
        self.assertEqual(supervisor.GO_CONV["int"], "int(mooditEntier(%s))")
        for source in (supervisor.go_grader_source([("int64", "somme", ["int64"])], "true", "N"),
                       supervisor.go_server_source([("int64", "somme", ["int64"])])):
            self.assertIn(".UseNumber()", source)
            self.assertIn("func mooditEntier(", source)
            # Une seule table de conversion : l'aiguillage du serveur avait la sienne, restée sur
            # la lecture en flottant. Aucun chemin ne doit lire un entier autrement.
            self.assertNotIn("int64(mooditNombre(", source)
            self.assertNotIn("int(mooditNombre(", source)
        self.assertIn("mooditValeur = somme(mooditEntier(mooditDemande.Args[0]))",
                      supervisor.go_server_source([("int64", "somme", ["int64"])]))

    def test_go_pointer_constructor_with_field_capture(self):
        # La branche à poignée gardait la signature du constructeur, pas celle-ci : un harnais
        # rangeant le résultat dans un *T ne compilait que d'un côté.
        obj_list = [("Rectangle", [("NewRectangle", ["int", "int"], True)],
                   [("int", "aire", [])])]
        field_list = {"Rectangle": [("largeur", "int"), ("hauteur", "int")]}
        stub_src = supervisor.go_object_stub(obj_list, field_list)
        self.assertIn("func NewRectangle(a0 int, a1 int) *Rectangle {", stub_src)
        self.assertIn("return &Rectangle{", stub_src)

    def test_csharp_double_exact_round_trip(self):
        # Le format « G » par défaut n'est pas garanti exact. Et c'est « G17 », pas « R » : la
        # documentation .NET déconseille R pour l'aller-retour d'un double, et le runner tourne
        # sur mono, le runtime le plus ancien du parc.
        self.assertIn('a0.ToString("G17"', supervisor.cs_send_args(["double"]))
        self.assertIn('+ "|" + MooditRpc.Hexe(a0)', supervisor.cs_send_args(["string"]))
        server = supervisor.cs_server_source(["Solution"])
        self.assertIn('ToString("G17"', server)
        self.assertIn('ToString("G9"', server)

    def test_rust_associated_or_nested_function_is_not_free(self):
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
        server = supervisor.rust_server_source(supervisor.rust_signatures(source), source)
        for absent in ('"double" =>', '"aide" =>'):
            self.assertNotIn(absent, server)

    def test_rust_mutable_receiver_excludes_field_capture(self):
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

    def test_rust_immutable_receiver_keeps_field_capture(self):
        source = ("struct Rectangle { largeur: i32, hauteur: i32 }\n\n"
                  "impl Rectangle {\n"
                  "    fn aire(&self) -> i32 { self.largeur * self.hauteur }\n"
                  "}\n")
        self.assertEqual(supervisor.rust_mut_receivers(source), set())
        self.assertIn("Rectangle", supervisor.rust_capture_fields(source))

    def test_java_error_reply_carries_the_id(self):
        # Le noteur n'accepte qu'une ligne portant l'identifiant de SON appel : sans lui, une
        # exception du code soumis n'était jamais consommée et le couple s'attendait jusqu'au
        # temps limite. Les cinq autres langages tenaient déjà cet invariant.
        server = supervisor.java_server_source(["Solution"])
        self.assertIn('"{\\"ok\\":false,\\"id\\":\\""', server)
        self.assertIn('entre(ligne, "\\"id\\":\\"", "\\"")', server)

    def test_single_conversion_table_per_language(self):
        # Cause racine de trois tours de correctifs : une table dupliquée reste en arrière au
        # changement d'invariant suivant. Le garde-fou utile n'est pas « ce générateur-là utilise
        # la table » mais « il n'existe AUCUNE table littérale hors des constantes ».
        for t in supervisor.GO_CONV:
            self.assertIn(supervisor.GO_CONV[t] % "v",
                          supervisor.go_grader_source([(t, "f", [])], "true", "N"))
            self.assertIn(supervisor.GO_CONV[t] % "mooditDemande.Args[0]",
                          supervisor.go_server_source([("int", "f", [t])]))
        for t in supervisor.RUST_CONV:
            expected = supervisor.RUST_CONV[t] % 'args.next().unwrap_or("")'
            self.assertIn(expected,
                          supervisor.rust_server_source([("i32", "f", [t])], "fn f() {}"))
        for t, reader in supervisor.C_READ.items():
            self.assertIn("%s(moodit_valeur(id))" % reader,
                          supervisor.c_grader_source([(t, "f", [])], "return 1;", "N"))
        with open(supervisor.__file__, encoding="utf-8") as f:
            source = f.read()
        # Une seule DÉFINITION par table, et aucune copie littérale ailleurs.
        for fingerprint in ('"long": "atol"', '"int64": "mooditEntier', '"bool": "%s.parse::<bool>'):
            self.assertEqual(source.count(fingerprint), 1, fingerprint)

    def test_go_unrepresentable_value_does_not_block_the_pair(self):
        # json.Marshal échoue sur NaN et ±Inf : l'erreur ignorée donnait une ligne vide, que le
        # décodeur d'en face rejette — les deux processus s'attendaient jusqu'au temps limite.
        grader_dir = supervisor.go_grader_source([("float64", "moyenne", [])], "true", "N")
        self.assertIn("errReq != nil", grader_dir)
        self.assertIn("errRep != nil", supervisor.go_server_source([("float64", "moyenne", [])]))

    # Liste UNIQUE des répartiteurs. Ajouter un langage sans tenir l'invariant fait échouer la
    # CI : c'est le seul garde-fou qui ferme vraiment le motif « invariant tenu presque partout »,
    # celui qui a produit quatre des cinq tours de correctifs de cette série.
    DISPATCHERS = (
        ("java", lambda: supervisor.java_server_source(["Solution"])),
        ("go", lambda: supervisor.go_server_source([("int", "f", [])])),
        ("go objets", lambda: supervisor.go_server_source(
            [], [("R", [], [("int", "m", [])])], {"R": [("c", "int")]})),
        ("rust", lambda: supervisor.rust_server_source([("i32", "f", [])], "fn f() {}")),
        ("rust objets", lambda: supervisor.rust_server_source(
            [], "struct R { c: i32 }", [("R", [], [("i32", "m", [])])], {"R": [("c", "i32")]})),
        ("csharp", lambda: supervisor.cs_server_source(["Solution"])),
        ("c", lambda: supervisor.c_server_source([("int", "f", [])], "int f(void){return 1;}")),
        ("cpp", lambda: supervisor.c_server_source(
            [("int", "f", [])], "int f(void){return 1;}", cpp=True)),
        ("cpp objets", lambda: supervisor.c_server_source(
            [], "class R { public: R(int a){} int m(){return 1;} };", cpp=True,
            obj_list=[("R", [["int"]], [("int", "m", [])])])),
    )

    def test_every_reply_is_self_framed(self):
        """Le stdout du code noté EST le canal de réponse, et il partage son tampon.

        Une dernière écriture non terminée par un saut de ligne (`print(…, end="")`, `print!`,
        `System.out.print`) se collait au DÉBUT de la ligne de réponse, qui n'était alors plus
        reconnue : le couple s'attendait jusqu'au temps limite, et une réponse JUSTE était notée
        « Interrompu ». Un saut de ligne AVANT la réponse referme la ligne partielle, qui devient
        du bruit à part entière. L'invariant est vérifié sur CHAQUE site de réponse de CHAQUE
        répartiteur : il ne valait, au départ, que sur un seul des neuf."""
        import re as _re
        # Chaque langage du superviseur a son répartiteur dans la liste : un langage ajouté sans
        # entrée échoue ici, au lieu d'échapper à l'invariant.
        listed = {ident.split()[0] for ident, _ in self.DISPATCHERS}
        self.assertEqual(set(supervisor.RUNNERS), listed)
        # Les écritures sur l'ERREUR standard ne sont pas des réponses : ce sont des diagnostics,
        # et le noteur ne les lit pas comme telles.
        emitted = _re.compile(
            r"(?:System[.]out[.]print|fmt[.]Print|\bprint!|Console[.]Out[.]Write|\bprintf"
            r"|\bmoodit_printf)[(]")
        for ident, factory in self.DISPATCHERS:
            source = factory()
            sites = [l.strip() for l in source.splitlines()
                     if emitted.search(l) and "stderr" not in l and "__asm__" not in l]
            self.assertTrue(sites, "aucun site de réponse trouvé en " + ident)
            for site in sites:
                # Le PREMIER argument émis — l'expression entière (`"\n" + reponse + "\n"`) ou la
                # chaîne de format (`"\n%s|ok|%d\n"`, `"\n{}\n"`) — doit COMMENCER par un saut
                # de ligne (il referme une ligne partielle du code soumis, l'objet du test) et
                # FINIR par un (la réponse est une ligne entière). Chercher un `\n` dans les
                # premiers caractères ne voyait pas l'absence du premier : le `\n` final d'un
                # format court suffisait à rendre le test vert.
                emitted_arg = self.first_argument(site[emitted.search(site).end():])
                self.assertTrue(emitted_arg.startswith('"' + chr(92) + "n"),
                                "réponse sans saut de ligne AVANT en %s : %s" % (ident, site))
                self.assertTrue(emitted_arg.endswith(chr(92) + 'n"'),
                                "réponse sans saut de ligne APRÈS en %s : %s" % (ident, site))

    @staticmethod
    def first_argument(rest):
        """Premier argument d'un appel, `rest` commençant juste après sa parenthèse ouvrante :
        jusqu'à la première virgule ou parenthèse fermante de premier niveau hors littéral."""
        depth, quoted, i = 0, False, 0
        while i < len(rest):
            c = rest[i]
            if quoted:
                if c == chr(92):
                    i += 1
                elif c == '"':
                    quoted = False
            elif c == '"':
                quoted = True
            elif c == "(":
                depth += 1
            elif c == ")" and depth:
                depth -= 1
            elif c in ",)":
                break
            i += 1
        return rest[:i].strip()

    def test_depth_ignores_literals_and_comments(self):
        # Un comptage naïf se faisait déséquilibrer par une accolade en littéral, et toutes les
        # fonctions suivantes passaient pour imbriquées : un code CORRECT rendait « aucune
        # fonction exploitable ». C'était une régression du correctif précédent.
        branches = [
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
        for ident, source in branches:
            idents = [n for _, n, _ in supervisor.rust_signatures(source)]
            self.assertIn("doubler", idents, ident)
        # Et le filtre de premier niveau tient toujours.
        nested = ("impl Rect {\n    fn associee(x: i32) -> i32 { x }\n}\n"
                    "fn doubler(n: i32) -> i32 { n * 2 }\n")
        self.assertEqual([n for _, n, _ in supervisor.rust_signatures(nested)], ["doubler"])

    def test_cpp_digit_separator(self):
        # `1'000` : l'apostrophe n'ouvre pas de littéral. Elle faisait avaler la fin du
        # fichier par la plage de classe, et la fonction libre suivante disparaissait.
        source = ("class Grand {\npublic:\n    Grand() {}\n"
                  "    int mille() { return 1'000; }\n};\n\n"
                  "int doubler(int n) { return n * 2; }\n")
        self.assertEqual(supervisor.c_signatures(source, cpp=True),
                         [("int", "doubler", ["int"])])

    def test_shared_brace_matching(self):
        # Le même balayage sert aux quatre endroits qui appariaient des accolades à la main.
        source = ("class Rectangle {\n    int largeur, hauteur;\npublic:\n"
                  "    Rectangle(int l, int h) : largeur(l), hauteur(h) {}\n"
                  "    int aire() { return largeur * hauteur; }\n"
                  "    char ouvrante() { return '{'; }\n};\n\n"
                  "int doubler(int n) { return n * 2; }\n")
        self.assertEqual(supervisor.c_signatures(source, cpp=True),
                         [("int", "doubler", ["int"])])
        self.assertEqual([c for c, _, _ in supervisor.cpp_object_api(source)], ["Rectangle"])

    def test_rpc_verdict_fails_closed(self):
        # Le nonce ne vaut verdict que s'il occupe UNE LIGNE ENTIERE du stderr du noteur : en
        # sous-chaine, le relais d'un message d'erreur choisi par l'etudiant suffisait a
        # transformer toute fuite du nonce en « reussi ». La sonde exacte de la revue :
        self.assertEqual(supervisor.rpc_verdict(
            "1234567890123",
            "[MOODIT] harnais: appel refuse par le code soumis : 1234567890123" + chr(10),
            "")[0], False)
        self.assertEqual(supervisor.rpc_verdict("N", "bruit N bruit", "")[0], False)
        # La forme EMISE par les noteurs — le nonce encadre de sauts de ligne — passe, avec ou
        # sans retour chariot de fin (tubes Windows ou non).
        self.assertEqual(supervisor.rpc_verdict(
            "N", "contexte" + chr(10) + "N" + chr(10), ""), (True, None))
        self.assertEqual(supervisor.rpc_verdict(
            "N", "N" + chr(13) + chr(10), ""), (True, None))
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


class VisibilityNotRequiredTest(unittest.TestCase):
    """Un membre sans modificateur est l'ecriture la plus COURANTE d'un exercice.

    En C# un membre de classe est prive par defaut, en Java il a la visibilite du paquet :
    exiger `public` mettait en echec une soumission JUSTE. Le serveur sait invoquer ces
    membres des deux cotes (reflexion `NonPublic` en C#, `getDeclared*` + `setAccessible`
    en Java), donc l'extraction ne doit pas etre plus severe que lui — c'est cet ECART qui
    est teste ici, et il avait deja ete introduit une fois : la relaxation des statiques
    avait oublie le serveur C# et tout le chemin objet."""

    CS = ("class Rectangle {\n"
          "    int largeur;\n"
          "    int hauteur;\n"
          "    Rectangle(int largeur, int hauteur) {\n"
          "        this.largeur = largeur; this.hauteur = hauteur;\n"
          "    }\n"
          "    int Aire() { return largeur * hauteur; }\n"
          "    public int Perimetre() { return 2 * (largeur + hauteur); }\n"
          "    static int Zero() { return 0; }\n"
          "}\n"
          "class Prog {\n"
          "    static void Main() {\n"
          "        var r = new Rectangle(3, 4);\n"
          "    }\n"
          "}\n")

    JAVAP = ("Compiled from \"Rectangle.java\"\n"
             "class Rectangle {\n"
             "  int largeur;\n"
             "  int hauteur;\n"
             "  Rectangle(int, int);\n"
             "  int aire();\n"
             "  private int secret();\n"
             "  public int perimetre();\n"
             "  static int doubler(int);\n"
             "}\n")

    def test_cs_static_without_modifier_is_extracted(self):
        # Le cas nomme dans le message de commit : `static int Doubler(int n)` sans `public`.
        code = ("class Solution {\n"
                "    static int Doubler(int n) { return n * 2; }\n"
                "}")
        self.assertEqual(supervisor.cs_signatures(code), [("int", "Doubler", ["int"])])

    def test_cs_object_api_without_modifier(self):
        ctors, method_list = supervisor.cs_object_api(self.CS, "Rectangle")
        # Le constructeur a visibilite de paquet est vu UNE fois : `new Rectangle(3, 4)`,
        # au milieu d'une expression, ne doit pas passer pour une declaration. L'ancrage en
        # debut de ligne est la pour ca — sans lui, la relaxation inventait un second
        # constructeur, et le harnais du prof ne compilait plus.
        self.assertEqual(ctors, [["int", "int"]])
        self.assertEqual(sorted(n for _, n, _ in method_list), ["Aire", "Perimetre"])
        # Une STATIQUE n'est pas une methode d'instance : elle appartient a l'autre chemin.
        self.assertNotIn("Zero", [n for _, n, _ in method_list])

    def test_java_static_without_modifier_is_extracted(self):
        self.assertEqual(supervisor.java_signatures(self.JAVAP),
                         [("int", "doubler", ["int"])])

    def test_java_object_api_without_modifier(self):
        klass, ctors, method_list = supervisor.java_class_api(self.JAVAP)
        self.assertEqual(klass, "Rectangle")
        self.assertEqual(ctors, [["int", "int"]])
        self.assertEqual(sorted(n for _, n, _ in method_list),
                         ["aire", "perimetre", "secret"])
        # Un CHAMP (`int largeur;`) n'a pas de parenthese : il ne doit pas devenir une methode.
        self.assertNotIn("largeur", [n for _, n, _ in method_list])
        self.assertNotIn("doubler", [n for _, n, _ in method_list])

    def test_cs_server_invokes_non_public_members(self):
        # L'ECART extraction/serveur, verifie sur le texte genere : les TROIS resolutions du
        # serveur C# (statique, constructeur, methode d'instance) doivent accepter
        # NonPublic. Sinon le bouchon est genere, le noteur compile, puis l'appel echoue a
        # l'execution : une reponse JUSTE notee 0, avec un diagnostic qui accuse le code
        # de l'etudiant.
        server = supervisor.cs_server_source(["Solution"])
        self.assertEqual(server.count("BindingFlags.NonPublic"), 3)


class InsignificantModifiersTest(unittest.TestCase):
    """`final`, `synchronized`, `override`, `protected internal` : du code LEGAL.

    Les enumerer de travers refusait une soumission CORRECTE — aucun bouchon genere, donc
    « aucune fonction exploitable » ou un harnais qui ne compile pas, et 0 avec un message qui
    ne designe pas la cause. Ces tests fixent les formes acceptees ET les deux pieges de la
    relaxation : `static` doit continuer de choisir le chemin (fonction ou objet), et un APPEL
    ne doit jamais passer pour une declaration."""

    def test_java_static_with_final(self):
        javap = ("class Solution {\n"
                 "  static final int doubler(int);\n"
                 "  public static final int tripler(int);\n"
                 "}\n")
        self.assertEqual(sorted(n for _, n, _ in supervisor.java_signatures(javap)),
                         ["doubler", "tripler"])

    def test_java_instance_with_final_and_synchronized(self):
        javap = ("class Rectangle {\n"
                 "  Rectangle(int, int);\n"
                 "  final int aire();\n"
                 "  synchronized int perimetre();\n"
                 "  static int zero();\n"
                 "}\n")
        _, ctors, method_list = supervisor.java_class_api(javap)
        self.assertEqual(ctors, [["int", "int"]])
        self.assertEqual(sorted(n for _, n, _ in method_list), ["aire", "perimetre"])
        # `static` reste DECISIF : une statique proxifiee comme methode d'instance ferait
        # appeler une poignee qui n'existe pas.
        self.assertNotIn("zero", [n for _, n, _ in method_list])

    def test_cs_static_with_two_word_modifier(self):
        code = ("class Solution {\n"
                "    protected internal static int Mix(int a) { return a; }\n"
                "    static extern int Ext(int a);\n"
                "}\n")
        self.assertEqual(sorted(n for _, n, _ in supervisor.cs_signatures(code)),
                         ["Ext", "Mix"])

    def test_cs_instance_with_override(self):
        code = ("class Rectangle {\n"
                "    public override int Aire() { return 12; }\n"
                "    private protected int Secret() { return 1; }\n"
                "    public static int Zero() { return 0; }\n"
                "}\n")
        _, method_list = supervisor.cs_object_api(code, "Rectangle")
        self.assertEqual(sorted(n for _, n, _ in method_list), ["Aire", "Secret"])
        self.assertNotIn("Zero", [n for _, n, _ in method_list])

    def test_class_written_on_one_line(self):
        # La forme la plus compacte, et celle qu'un prof ecrit dans un enonce. Un ancrage en
        # debut de LIGNE la refusait : la methode n'etait plus extraite et une reponse JUSTE
        # retombait a 0. La frontiere est donc un debut de BLOC (`^`, `{`, `}` ou `;`), pas un
        # debut de ligne. Ce cas n'etait verrouille que par un test d'integration, qui exige
        # Docker et les images.
        one_line = ("class Solution { public static string Copie(string s) "
                     "{ return s; } }")
        self.assertEqual(supervisor.cs_signatures(one_line),
                         [("string", "Copie", ["string"])])
        oop = ("class Rectangle { int l; int h; Rectangle(int l, int h) "
               "{ this.l = l; this.h = h; } int Aire() { return l * h; } }")
        ctors, method_list = supervisor.cs_object_api(oop, "Rectangle")
        self.assertEqual(ctors, [["int", "int"]])
        self.assertEqual([n for _, n, _ in method_list], ["Aire"])

    def test_call_is_not_taken_for_declaration(self):
        # LE piege de la relaxation : avec « n'importe quel mot » en modificateur, `return` et
        # `new` en seraient, et cette ligne aurait invente un constructeur a un argument.
        code = ("class Prog {\n"
                "    static int Faire() {\n"
                "        return new Rectangle(3, 4).Aire();\n"
                "    }\n"
                "}\n")
        ctors, _ = supervisor.cs_object_api(code, "Rectangle")
        self.assertEqual(ctors, [])


class SecondaryClassesTest(unittest.TestCase):
    """Le serveur cherche dans le MEME perimetre que l'extraction et que le bouchon.

    L'extraction balaie toutes les classes du code soumis et le bouchon APLATIT leurs statiques
    dans la classe principale : `Solution.doubler(5)` compile donc meme si `doubler` vit dans
    `class Outils`. Un serveur qui ne cherchait que dans la principale levait alors a
    l'execution, et une reponse JUSTE etait notee 0 — l'invariant viole par le perimetre,
    apres l'avoir ete par la visibilite."""

    def test_cs_student_classes_all_main_first(self):
        source = ("class Solution {\n"
                  "    static int Entree(int n) { return Outils.Doubler(n); }\n"
                  "}\n"
                  "class Outils {\n"
                  "    static int Doubler(int n) { return n * 2; }\n"
                  "}\n")
        self.assertEqual(supervisor.cs_student_classes(source), ["Solution", "Outils"])
        # Sans doublon, et la principale reste en tete meme re-declaree plus bas.
        self.assertEqual(supervisor.cs_student_classes(source + "class Solution2 {}"),
                         ["Solution", "Outils", "Solution2"])

    def test_cs_server_covers_every_class(self):
        server = supervisor.cs_server_source(["Solution", "Outils"])
        self.assertIn("typeof(Solution), typeof(Outils)", server)

    def test_java_server_covers_every_class(self):
        server = supervisor.java_server_source(["Solution", "Outils", "Solution$Interne"])
        self.assertIn('new java.lang.String[] {"Solution", "Outils", "Solution$Interne"}', server)
        self.assertNotIn("__CLASSES__", server)


class WithoutCommentsTest(unittest.TestCase):
    """Un `class X` en commentaire ou dans une chaine ne doit leurrer NI le choix de la
    classe principale, NI la liste des typeof du serveur, NI les bouchons. Un etudiant
    qui garde une ancienne version en commentaire — reflexe courant — voyait sa
    soumission correcte echouer sur un type qu il n a pas ecrit."""

    def test_comments_and_strings_blanked(self):
        source = ("// class ligne" + chr(10) +
                  "/* class bloc */ class Solution {" + chr(10) +
                  "    static string S() { return " + chr(34) + "class chaine" + chr(34) + "; }" + chr(10) +
                  "}" + chr(10))
        cleaned = supervisor.cs_strip_comments(source)
        self.assertNotIn("ligne", cleaned)
        self.assertNotIn("bloc", cleaned)
        self.assertNotIn("chaine", cleaned)
        self.assertIn("class Solution {", cleaned)
        # Les LIGNES sont preservees : les regex ancrees en debut de ligne comptent dessus.
        self.assertEqual(cleaned.count(chr(10)), source.count(chr(10)))

    def test_verbatim_and_interpolated(self):
        # @"..." : "" echappe un guillemet, l antislash est LITTERAL (ne proteje rien).
        source = ("class Solution {" + chr(10) +
                  "    static string A() { return @" + chr(34) + "class P1 " + chr(34) + chr(34) + " suite " + chr(92) + chr(34) + "; }" + chr(10) +
                  "    static string B() { return $" + chr(34) + "class P2" + chr(34) + "; }" + chr(10) +
                  "}" + chr(10))
        cleaned = supervisor.cs_strip_comments(source)
        self.assertNotIn("P1", cleaned)
        self.assertNotIn("P2", cleaned)
        self.assertEqual(supervisor.cs_student_classes(cleaned), ["Solution"])

    def test_the_reported_decoy(self):
        decoy = ("// class principale" + chr(10) +
                  "class Solution { static int F(int n) { return n; } }" + chr(10))
        cleaned = supervisor.cs_strip_comments(decoy)
        self.assertEqual(supervisor.cs_student_class(cleaned), "Solution")
        # Et une methode COMMENTEE ne produit pas de bouchon fantome.
        with_dead = cleaned + "// static int Morte(int n) { return 0; }" + chr(10)
        idents = [n for _, n, _ in supervisor.cs_signatures(
            supervisor.cs_strip_comments(with_dead))]
        self.assertEqual(idents, ["F"])


class PackageJavaTest(unittest.TestCase):
    """Un `package ...;` colle depuis un IDE est reconnu sur la source BLANCHIE : la notation
    le rejette avec un diagnostic clair plutot que de donner 0 sur « aucune methode
    exploitable ». Un `package` en commentaire ou en chaine ne declenche rien."""

    def test_declaration_recognized(self):
        for src in ('package exo1;' + chr(10) + 'class Solution {}',
                    'package com.exo.tp1 ;' + chr(10) + 'class S {}'):
            self.assertTrue(supervisor.PACKAGE_JAVA.search(supervisor.blank_code(src)), src)

    def test_inert_package_does_not_trigger(self):
        for src in ('// package exo1;' + chr(10) + 'class Solution {}',
                    'class S { String p = ' + chr(34) + 'package x;' + chr(34) + '; }',
                    'class Solution { static int f(){ return 1; } }'):
            self.assertFalse(supervisor.PACKAGE_JAVA.search(supervisor.blank_code(src)), src)


class IncompleteGradingTest(unittest.TestCase):
    """Une PANNE ne doit jamais devenir une note ; une panne PROVOQUEE ne doit jamais devenir un
    reessai. grading_incomplete tranche entre les deux, et ces quatre cas la verrouillent."""

    def _o(self, **kw):
        return supervisor.CaseOutcome(False, **kw)

    def test_internal_error_makes_grading_incomplete(self):
        # Notre code a leve : jamais la faute de l'etudiant, meme s'il a aussi depasse un delai.
        self.assertTrue(supervisor.grading_incomplete([
            self._o(skipped=True, cause="erreur"),
            self._o(ran=True, timed_out=True)]))

    def test_exhausted_budget_stays_partial_grade(self):
        # Une solution correcte mais LENTE, sous le delai de chaque cas, epuise le budget de facon
        # reproductible : dans le conteneur, l'attente d'une place a deja eu lieu, le budget ne
        # mesure que le travail. En faire un 502 rendait la question impossible a noter (502 a
        # chaque renvoi) et bloquait une place a chaque essai : c'est une note PARTIELLE.
        self.assertFalse(supervisor.grading_incomplete([
            supervisor.CaseOutcome(True, ran=True),
            self._o(skipped=True, cause="budget")]))

    def test_budget_exhausted_by_student_stays_a_grade(self):
        # LE garde-fou anti-reessai : si un cas a atteint son delai, c'est l'etudiant qui a
        # consomme le budget — le rendre « incomplet » lui offrirait une tentative de plus
        # chaque fois qu'il fait tourner son code jusqu'au delai.
        self.assertFalse(supervisor.grading_incomplete([
            self._o(ran=True, timed_out=True),
            self._o(skipped=True, cause="budget")]))

    def test_full_disk_stays_a_grade(self):
        # C'est le code soumis qui ecrit : la cause est imputable, quel que soit le reste.
        self.assertFalse(supervisor.grading_incomplete([
            supervisor.CaseOutcome(True, ran=True),
            self._o(skipped=True, cause="espace")]))
        # Et une notation ordinaire n'est evidemment pas incomplete.
        self.assertFalse(supervisor.grading_incomplete([
            supervisor.CaseOutcome(True, ran=True), self._o(ran=True)]))


class Review24Test(unittest.TestCase):
    """Champs lus sur la source nettoyee, `pub` Rust, import serveur aliase, classe Java de
    premier niveau, zombies. Chaque test garde aussi la forme qui marchait deja."""

    NL, TAB, BT, Q = chr(10), chr(9), chr(96), chr(34)

    def test_rust_field_comment_loses_nothing(self):
        # PRECONDITION seulement : la capture fonctionne sur la source NETTOYEE. Le defaut etait
        # a l'APPEL (run_rust_rpc lui passait la source brute), invisible ici : il est garde par
        # rust_commented_field_graded_correctly dans RpcGradingIntegrationTest.
        src = self.NL.join(["struct Rectangle {",
                            "    largeur: i32, // en cm, environ",
                            "    hauteur: i32,",
                            "}", ""])
        field_list = supervisor.rust_capture_fields(supervisor.blank_code(src, rust=True))
        self.assertEqual(field_list.get("Rectangle"), [("largeur", "i32"), ("hauteur", "i32")])

    def test_rust_pub_fields(self):
        src = self.NL.join(["pub struct Rectangle {",
                            "    pub largeur: i32,",
                            "    pub(crate) hauteur: i32,",
                            "}", ""])
        self.assertEqual(supervisor.rust_struct_fields(src).get("Rectangle"),
                         [("largeur", "i32"), ("hauteur", "i32")])
        # La forme sans visibilite marche toujours.
        bare = self.NL.join(["struct Rectangle {", "    largeur: i32,", "    hauteur: i32,",
                           "}", ""])
        self.assertEqual(supervisor.rust_struct_fields(bare).get("Rectangle"),
                         [("largeur", "i32"), ("hauteur", "i32")])

    def test_go_field_tag_loses_nothing(self):
        # PRECONDITION seulement, comme ci-dessus : l'appel (run_go_rpc) est garde par
        # go_tagged_field_graded_correctly dans RpcGradingIntegrationTest.
        label = self.BT + "json:" + self.Q + "l" + self.Q + self.BT
        src = self.NL.join(["type Rectangle struct {",
                            self.TAB + "Largeur int " + label,
                            self.TAB + "Hauteur int",
                            "}", ""])
        field_list = supervisor.go_capture_fields(supervisor.blank_code(src, backticks=True))
        self.assertEqual(field_list.get("Rectangle"), [("Largeur", "int"), ("Hauteur", "int")])

    def test_rust_server_import_aliased(self):
        server = supervisor.rust_server_source(
            [("i32", "doubler", ["i32"])], "fn doubler(n: i32) -> i32 { n * 2 }")
        self.assertIn("Write as MooditWrite", server)
        self.assertNotIn("use std::io::{BufRead, Write};", server)

    def test_java_top_level_class_outside_the_shell(self):
        stub = supervisor.java_stub_source("Solution", [], objects=[
            ("Rectangle", [["int", "int"]], [("int", "aire", [])]),
            ("Solution.Carre", [["int"]], [("int", "aire", [])])])
        solution_end = stub.index(self.NL + "}" + self.NL)
        # Premier niveau : classe du fichier, accessible comme « new Rectangle(...) ».
        self.assertIn(self.NL + "final class Rectangle {", stub)
        self.assertNotIn("public static final class Rectangle", stub)
        self.assertGreater(stub.index("final class Rectangle"), solution_end)
        # Imbriquee : reste dans sa coquille, « new Solution.Carre(...) » marche toujours.
        self.assertIn("public static final class Carre", stub)
        self.assertLess(stub.index("class Carre"), solution_end)

    def test_zombie_with_live_threads_is_a_survivor(self):
        # Le fil PRINCIPAL sorti affiche le processus en Z alors que ses autres fils tournent :
        # le juger mort le laissait survivre au cas suivant (regression de la 24e passe).
        self.assertTrue(supervisor.tasks_alive(["Z", "S"]))
        self.assertTrue(supervisor.tasks_alive(["R"]))
        # Mort pour de bon : rien a tuer, seulement a recolter.
        self.assertFalse(supervisor.tasks_alive(["Z"]))
        self.assertFalse(supervisor.tasks_alive(["Z", "X"]))
        status_text = self.NL.join(["Name:" + self.TAB + "x", "State:" + self.TAB + "Z (zombie)",
                               "Uid:" + self.TAB + "1300" + self.TAB + "1300", ""])
        self.assertEqual(supervisor.real_uid(status_text), "1300")
        self.assertIsNone(supervisor.real_uid("Name:" + self.TAB + "x"))
        # Le nom du programme peut contenir « ) S » : on lit apres la DERNIERE parenthese.
        self.assertEqual(supervisor.task_state("42 (a) S (b) R 1 2 3"), "R")


class Review25Test(unittest.TestCase):
    """Lecteurs de parametres uniques (C, C#), alias C#, qualificatifs C, cause d'une exception,
    liens jamais suivis."""

    NL = chr(10)

    def test_c_qualifiers_and_const(self):
        for src in ("static int doubler(int n) { return n * 2; }",
                    "inline int doubler(int n) { return n * 2; }",
                    "int doubler(const int n) { return n * 2; }"):
            self.assertEqual(supervisor.c_signatures(src), [("int", "doubler", ["int"])], src)
        # La forme nue marche toujours, et un pointeur reste ecarte.
        self.assertEqual(supervisor.c_signatures("int doubler(int n) { return n * 2; }"),
                         [("int", "doubler", ["int"])])
        self.assertEqual(supervisor.c_signatures("int somme(int *t, int n) { return 0; }"), [])

    def test_cpp_object_reads_params_like_free_functions(self):
        # Le chemin OBJET avait sa propre copie du lecteur, qui prenait `int *t` pour `int` :
        # le meme code etait ecarte en fonction libre et mal bouchonne en constructeur.
        src = self.NL.join(["class R {", "public:",
                            "    R(int *t) { }",
                            "    R(const int l, int h) { }",
                            "    int aire() { return 0; }",
                            "};", ""])
        (klass, ctors, method_list), = supervisor.cpp_object_api(src)
        self.assertEqual(klass, "R")
        self.assertEqual(ctors, [["int", "int"]])

    def test_cpp_default_argument_keeps_the_signature(self):
        # `int b = 0` etait lu comme quatre morceaux : la fonction n'etait pas bouchonnee, et un
        # constructeur a valeurs par defaut faisait disparaitre la classe entiere (le
        # constructeur implicite n'est plus fourni des qu'un constructeur est declare). Une
        # reponse juste etait notee 0, sans que le « Tester » du prof le revele.
        # Revue #246 : chaque arité RÉDUITE aussi — `somme(4)` ne compilait pas dans le noteur.
        self.assertEqual(
            supervisor.c_signatures("int somme(int a, int b = 0) { return a + b; }\n", cpp=True),
            [("int", "somme", ["int", "int"]), ("int", "somme", ["int"])])
        self.assertEqual(
            supervisor.c_signatures("double mi(const double x=1.5) { return x / 2; }\n", cpp=True),
            [("double", "mi", ["double"]), ("double", "mi", [])])
        src = self.NL.join(["class Rect {", "public:",
                            "    Rect(int w = 1, int h = 1) { }",
                            "    int aire(int facteur = 1) { return 0; }",
                            "};", ""])
        (klass, ctors, method_list), = supervisor.cpp_object_api(src)
        self.assertEqual(klass, "Rect")
        self.assertEqual(ctors, [["int", "int"], ["int"], []])
        self.assertEqual(method_list, [("int", "aire", ["int"]), ("int", "aire", [])])
        # Un type non transportable reste ecarte, valeur par defaut ou non.
        self.assertEqual(
            supervisor.c_signatures("int f(long double x = 0) { return 0; }\n", cpp=True), [])

    def test_cs_long_names_mapped_to_keyword(self):
        src = self.NL.join(["class Solution {",
                            "    public static String Inverse(String s) { return s; }",
                            "    static System.Int32 Doubler(System.Int32 n) { return n * 2; }",
                            "}", ""])
        canon = supervisor.cs_canonical_types(src)
        self.assertEqual(sorted(supervisor.cs_signatures(canon)),
                         [("int", "Doubler", ["int"]), ("string", "Inverse", ["string"])])
        # Un identifiant qui CONTIENT un nom long n'est pas touche.
        self.assertIn("MyString", supervisor.cs_canonical_types("class MyString {}"))

    def test_cs_default_value_and_in_but_not_ref(self):
        self.assertEqual(supervisor._cs_param_types("int n = 5, in int m"), ["int", "int"])
        self.assertIsNone(supervisor._cs_param_types("ref int n"))
        self.assertEqual(supervisor._cs_param_types("int n"), ["int"])
        # Le chemin objet utilise le MEME lecteur.
        ctors, _ = supervisor.cs_object_api(
            "class R {" + self.NL + "    public R(int l, int h = 1) { }" + self.NL + "}", "R")
        self.assertEqual(ctors, [["int", "int"], ["int"]])

    def test_environment_error_is_not_a_bug(self):
        # OSError (disque, lien, processus) : l'etudiant peut la provoquer -> une note, pas un
        # 502 qui lui offrirait un reessai.
        self.assertEqual(supervisor.exception_cause(OSError(28, "No space left")), "environnement")
        self.assertEqual(supervisor.exception_cause(PermissionError()), "environnement")
        # Bogue de logique du superviseur : seul cas non imputable.
        self.assertEqual(supervisor.exception_cause(KeyError("x")), "erreur")
        self.assertFalse(supervisor.grading_incomplete(
            [supervisor.CaseOutcome(False, skipped=True, cause="environnement")]))

    @unittest.skipUnless(os.name == "posix", "liens symboliques POSIX ; couvert en CI (Linux)")
    def test_root_never_follows_a_link(self):
        # `/box/cargo -> /` : root suivait le lien et verrouillait la cible entiere. Une racine
        # qui est un lien est ignoree, sans meme tenter de la changer.
        with tempfile.TemporaryDirectory() as d:
            target_file = os.path.join(d, "cible")
            os.makedirs(target_file)
            file_path = os.path.join(target_file, "f")
            with open(file_path, "w") as f:
                f.write("x")
            os.chmod(file_path, 0o644)
            link = os.path.join(d, "lien")
            os.symlink(target_file, link)
            supervisor.lock_sources(link)
            self.assertEqual(os.stat(file_path).st_mode & 0o777, 0o644)
            # chown_tree : un chown vers son propre UID ne laisse aucune trace, on relève donc les
            # appels. Ni la cible ni rien dessous ne doit être visé (root y donnait la cible —
            # `/` pour un lien posé par l'étudiant — à l'étudiant).
            with unittest.mock.patch.object(supervisor.os, "chown") as chown:
                supervisor.chown_tree(link, 4242, 4242)
            self.assertEqual([], chown.call_args_list)


class Review26Test(unittest.TestCase):
    """Correctifs qu'aucun test ne faisait rougir (trouves par mutation) : priorite des canaris
    sur « incomplet », noteur tue non concluant."""

    def _err(self):
        return supervisor.CaseOutcome(False, skipped=True, cause="erreur")

    def test_forgery_never_becomes_a_retry(self):
        self.assertFalse(supervisor.job_incomplete("incoherents", [self._err()]))
        # Sans falsification, l'erreur de logique rend bien le job incomplet...
        self.assertTrue(supervisor.job_incomplete("ok", [self._err()]))
        # ...et un job ordinaire ne l'est pas.
        self.assertFalse(supervisor.job_incomplete("ok", [supervisor.CaseOutcome(True, ran=True)]))

    def test_grader_killed_by_signal_is_inconclusive(self):
        self.assertTrue(supervisor.grader_killed(-9, False))
        # Un verdict obtenu, une sortie normale, ou pas de code : pas « tue ».
        self.assertFalse(supervisor.grader_killed(-9, True))
        self.assertFalse(supervisor.grader_killed(0, False))
        self.assertFalse(supervisor.grader_killed(1, False))
        self.assertFalse(supervisor.grader_killed(None, False))

    def test_grader_exit_zero_without_token_is_lost_output(self):
        # Les noteurs ne rendent 0 qu'apres avoir ecrit le jeton : 0 sans jeton = ecriture
        # perdue chez le noteur (stderr sur un /box plein), pas un harnais qui renvoie faux.
        self.assertTrue(supervisor.grader_output_lost(0, False))
        self.assertFalse(supervisor.grader_output_lost(0, True))      # jeton recu
        self.assertFalse(supervisor.grader_output_lost(1, False))     # harnais faux
        self.assertFalse(supervisor.grader_output_lost(-9, False))    # tue : grader_killed
        self.assertFalse(supervisor.grader_output_lost(None, False))  # lancement impossible
        saved_state, saved_events = supervisor.EXIT_STATE, list(supervisor.EVENTS)
        try:
            supervisor.EXIT_STATE = supervisor.ExitState(3)
            supervisor.note_grader_output_lost(1, False)
            self.assertFalse(supervisor.EXIT_STATE.lost)
            supervisor.note_grader_output_lost(0, False)
            self.assertTrue(supervisor.EXIT_STATE.lost)
            self.assertEqual(supervisor.EVENTS[-1]["type"], "espace_sature")
            self.assertEqual(supervisor.EVENTS[-1]["case"], 3)
        finally:
            supervisor.EXIT_STATE = saved_state
            supervisor.EVENTS[:] = saved_events


class Review27Test(unittest.TestCase):
    """root ne suit aucun lien ; le noteur nait prive ; l'analyse des sources est lineaire."""

    @unittest.skipUnless(os.name == "posix", "POSIX ; couvert en CI (Linux)")
    def test_permissions_do_not_follow_a_link(self):
        with tempfile.TemporaryDirectory() as d:
            target_file = os.path.join(d, "cible")
            with open(target_file, "w") as f:
                f.write("x")
            os.chmod(target_file, 0o644)
            link = os.path.join(d, "lien")
            os.symlink(target_file, link)
            with self.assertRaises(OSError):
                supervisor.set_owner_mode(link, os.getuid(), os.getgid(), 0o600)
            self.assertEqual(os.stat(target_file).st_mode & 0o777, 0o644)
            # Un fichier ordinaire, lui, recoit bien ses droits.
            supervisor.set_owner_mode(target_file, os.getuid(), os.getgid(), 0o600)
            self.assertEqual(os.stat(target_file).st_mode & 0o777, 0o600)
            # Arbre : le lien est ignore, le reste est change.
            os.chmod(target_file, 0o644)
            subdir = os.path.join(d, "arbre")
            os.makedirs(subdir)
            os.symlink(target_file, os.path.join(subdir, "l"))
            with open(os.path.join(subdir, "f"), "w") as f:
                f.write("y")
            supervisor.set_owner_mode_tree(subdir, os.getuid(), os.getgid(), 0o600, 0o700)
            self.assertEqual(os.stat(target_file).st_mode & 0o777, 0o644)
            self.assertEqual(os.stat(os.path.join(subdir, "f")).st_mode & 0o777, 0o600)
            self.assertEqual(os.stat(subdir).st_mode & 0o777, 0o700)

    @unittest.skipUnless(os.name == "posix", "POSIX ; couvert en CI (Linux)")
    def test_reread_follows_neither_link_nor_fifo(self):
        with tempfile.TemporaryDirectory() as d:
            secret = os.path.join(d, "secret")
            with open(secret, "w") as f:
                f.write("contenu")
            link = os.path.join(d, "run.out")
            os.symlink(secret, link)
            self.assertEqual(supervisor.read_capped(link), "")
            fifo = os.path.join(d, "fifo")
            os.mkfifo(fifo)
            # Sans O_NONBLOCK, cette lecture bloquait jusqu'au mur du conteneur.
            self.assertEqual(supervisor.read_capped(fifo), "")
            # Et une FIFO garnie n'est pas relue non plus : seul un fichier ORDINAIRE l'est.
            pipe_end = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
            try:
                os.write(pipe_end, b"donnees")
                self.assertEqual(supervisor.read_capped(fifo), "")
            finally:
                os.close(pipe_end)
            self.assertEqual(supervisor.read_capped(secret), "contenu")

    @unittest.skipUnless(os.name == "posix", "POSIX ; couvert en CI (Linux)")
    def test_root_compiler_creates_private_files(self):
        r = subprocess.run(["sh", "-c", "umask"], capture_output=True, text=True,
                           preexec_fn=supervisor.preexec_compile)
        self.assertEqual(r.stdout.strip(), "0077")

    def test_control_char_output_stays_bounded_once_escaped(self):
        cap = supervisor.EXEC_OUTPUT_CAP
        full_output = chr(1) * cap + "VERDICT"
        bounded = supervisor.bound_json(full_output)
        self.assertLessEqual(len(json.dumps(bounded, ensure_ascii=False)), supervisor.EXEC_JSON_CAP)
        self.assertTrue(bounded.endswith("VERDICT"))      # la queue, qui porte le verdict, reste
        # Le PIRE texte ordinaire au plafond de read_capped (que des sauts de ligne et des
        # guillemets, deux octets chacun une fois echappes) passe INTACT : un dump SQL en depend.
        worst = (chr(10) + chr(34)) * (cap // 2)
        self.assertEqual(supervisor.bound_json(worst), worst)

    def test_source_analysis_is_linear(self):
        # Une tete en \s* multiligne, ou des parametres jamais fermes, faisaient repartir le
        # moteur de chaque ligne jusqu'au bout : 100 000 caracteres prenaient des minutes, a
        # chaque cas, hors de tout delai de compilation. Lineaire, chaque motif repond en
        # millisecondes ; le seuil laisse une marge large a une machine de CI lente.
        n = 200_000
        inputs = ["\t\n" * (n // 2), "\n" * n, " " * n, "static " * (n // 7),
                   "int a(" * (n // 6), "fn a(" * (n // 5), "{static int a(" * (n // 14),
                   "\n  static int a(" * (n // 16), "struct a {" * (n // 10),
                   "class a " * (n // 8), "package a" * (n // 9), "impl a " * (n // 7),
                   # Une ancre ^ par LIGNE : sur une seule ligne, aucun motif ancre ne repart.
                   "\nint a(" * (n // 7), "\nfn a(" * (n // 6), "\nstruct a {" * (n // 11),
                   # Revue #246 : ouvertures jamais fermees (template C++, groupe Go, espace
                   # de noms, constructeur C#).
                   "template<" * (n // 9), "\nvar (" * (n // 6), "namespace a " * (n // 12),
                   "\na(" * (n // 3),
                   # Qualificatif repete UN PAR LIGNE : son `\s+` franchit la fin de ligne, et
                   # un groupe non borne repartait de chaque ligne (C_FUNC, RUST_MAIN) ; corps
                   # de structure Go jamais ferme (GO_STRUCT_BODY).
                   "static\n" * (n // 7), "const\n" * (n // 6), "inline\n" * (n // 7),
                   "async\n" * (n // 6), "unsafe\n" * (n // 7),
                   "const\nasync\nunsafe\n" * (n // 19), "type A struct{\n" * (n // 15),
                   # Revue #246 (4e passe) : restriction de visibilite et attribut Rust jamais
                   # fermes, repetes sur UNE ligne apres un `;` (RUST_FN, RUST_MAIN).
                   ";pub(" * (n // 5), ";#[" * (n // 3), ";pub (" * (n // 6),
                   ";#[a]" * (n // 5)]
        patterns = [(ident, m) for ident, m in vars(supervisor).items() if isinstance(m, re.Pattern)]
        patterns.append(("CS_CTOR_TPL", re.compile(supervisor.CS_CTOR_TPL % "R", re.M)))
        slow = []
        for ident, pattern in patterns:
            for src_text in inputs:
                begin = time.perf_counter()
                for _ in pattern.finditer(src_text):
                    pass
                if time.perf_counter() - begin > 1.0:
                    slow.append(ident)
                    break
        self.assertEqual(slow, [])


class Review28Test(unittest.TestCase):
    """Reponses justes notees 0 en C#, Rust et C/C++ ; analyse lineaire."""

    NL = chr(10)

    def test_cs_double_return_keeps_InvariantCulture(self):
        stub = supervisor.cs_object_stub("R", [["int"]], [("double", "Aire", []),
                                                         ("int", "Cote", [])])
        self.assertNotIn("Inbrutariant", stub)
        self.assertIn("InvariantCulture", stub)
        self.assertIn("(brut", stub)

    def test_rust_constructor_returning_self(self):
        src = self.NL.join(["pub struct Rect { l: i64, h: i64 }",
                            "impl Rect {",
                            "    pub fn new(l: i64, h: i64) -> Self { Rect { l, h } }",
                            "    pub fn aire(&self) -> i64 { self.l * self.h }",
                            "}", ""])
        (typ, ctors, method_list), = supervisor.rust_object_api(src)
        self.assertEqual(ctors, [("new", ["i64", "i64"])])
        # La forme `-> Rect` marche toujours.
        (_, ctors2, _), = supervisor.rust_object_api(src.replace("-> Self", "-> Rect"))
        self.assertEqual(ctors2, [("new", ["i64", "i64"])])

    def test_c_overloads_told_apart_by_signature(self):
        src = self.NL.join(["class Rect {", "public:", "    Rect() { }",
                            "    Rect(int l, int h) { }", "    int aire() { return 0; }",
                            "};", ""])
        obj_list = supervisor.cpp_object_api(src)
        stub = supervisor.cpp_object_stub(obj_list)
        _, branches = supervisor.cpp_object_dispatch(obj_list)
        # Chaque surcharge porte SA cle, des deux cotes du fil.
        for dedup_key in ("Rect()", "Rect(int,int)"):
            self.assertIn("|new|" + dedup_key, stub)
            self.assertIn('moodit_egal(moodit_nom, "%s")' % dedup_key, branches)
        server = supervisor.c_server_source([("int", "f", ["int"]), ("int", "f", ["double"])],
                                             "", cpp=True)
        self.assertIn('moodit_egal(moodit_nom, "f(int)")', server)
        self.assertIn('moodit_egal(moodit_nom, "f(double)")', server)

    def test_c_stub_not_static(self):
        grader_dir = supervisor.c_grader_source([("int", "abs", ["int"])], "return abs(-1) == 1;", "1")
        self.assertIn("int moodit_f_abs(int a0) {", grader_dir)
        self.assertIn("#define abs moodit_f_abs", grader_dir)
        self.assertNotIn("static int moodit_f_abs", grader_dir)

    def test_cpp_explicit_et_virtual(self):
        src = self.NL.join(["class Rect {", "public:", "    explicit Rect(int c) { }",
                            "    virtual int aire() { return 0; }", "};", ""])
        self.assertEqual(supervisor.cpp_object_api(src), [("Rect", [["int"]], [("int", "aire", [])])])

    def test_cpp_membres_sur_une_meme_ligne(self):
        # Constructeur et méthode sur UNE ligne : la méthode n'était pas extraite (0 sur une
        # réponse juste). Les sections d'accès en ligne restent respectées.
        src = self.NL.join(["class Rect {", "    int w, h;", "public:",
                            "    Rect(int w, int h):w(w),h(h) {} int aire() { return w*h; }",
                            "private: int g() { return 0; } public: double k() { return 1; }",
                            "};", ""])
        self.assertEqual(supervisor.cpp_object_api(supervisor.blank_code(src)),
                         [("Rect", [["int", "int"]], [("int", "aire", []), ("double", "k", [])])])

    def test_member_pieces_redonnent_le_corps(self):
        body = " int a; int f() { return 1; } int g();\n  Rect(int x) {}\n"
        src = "class R {" + body + "};"
        depths = supervisor.code_depths(src)
        pieces = supervisor._member_pieces(body, len("class R {"), depths, 1)
        self.assertEqual("".join(pieces), body)
        self.assertEqual([p.strip() for p in pieces if p.strip()],
                         ["int a;", "int f() { return 1; }", "int g();", "Rect(int x) {}"])

    def test_cs_method_named_Double(self):
        src = "class Solution { public static int Double(int n) { return 2 * n; } }"
        canon = supervisor.cs_canonical_types(src)
        self.assertEqual(supervisor.cs_signatures(canon), [("int", "Double", ["int"])])
        # En position de type, le nom long est toujours ramene au mot-cle.
        self.assertEqual(supervisor.cs_signatures(supervisor.cs_canonical_types(
            "class S { public static Double Moitie(Double x) { return x / 2; } }")),
            [("double", "Moitie", ["double"])])

    def test_cs_classes_namespace_nesting_and_helper(self):
        src = self.NL.join(["namespace Quiz {", "    class Aide { }",
                            "    class Solution {", "        class Interne { }",
                            "        public static int F(int n) { return n; }", "    }",
                            "}", ""])
        self.assertEqual(supervisor.cs_top_level_classes(src), ["Aide", "Solution"])
        self.assertEqual(supervisor.cs_namespaces(src), ["Quiz"])
        # Le harnais nomme Solution : c'est elle, pas la premiere classe.
        self.assertEqual(supervisor.cs_student_class(src, "return Solution.F(2) == 2;"),
                         "Solution")
        self.assertEqual(supervisor.cs_student_classes(src, "return Solution.F(2) == 2;"),
                         ["Solution", "Aide"])
        self.assertTrue(supervisor.cs_server_source(["Solution"], ["Quiz"])
                        .startswith("using Quiz;"))
        # Sans indice dans le harnais : Solution, sinon la premiere.
        self.assertEqual(supervisor.cs_student_class("class A { } class Solution { }"), "Solution")
        self.assertEqual(supervisor.cs_student_class("class A { } class B { }"), "A")

    def test_cs_implicit_constructor(self):
        src = "class Rect { public int Aire() { return 1; } }"
        self.assertEqual(supervisor.cs_object_api(src, "Rect"), ([[]], [("int", "Aire", [])]))
        # Un constructeur declare remplace l'implicite.
        self.assertEqual(supervisor.cs_object_api(
            "class Rect { public Rect(int c) { } public int Aire() { return 1; } }", "Rect")[0],
            [["int"]])

    def test_full_extraction_is_linear(self):
        # block_end recalculait les profondeurs a chaque classe, et rust_capture_fields etait
        # relu a chaque impl : 400 classes C++ prenaient 44 s par cas, hors de tout budget.
        n = 1500
        NL = self.NL
        cpp = NL.join("class C%d {%spublic:%s    C%d(int a) { }%s    int f(int x) { return x; }%s};"
                      % (i, NL, NL, i, NL, NL) for i in range(n))
        rust = NL.join("pub struct S%d { pub a: i64 }%simpl S%d {%s    pub fn new(a: i64) -> Self "
                       "{ S%d { a } }%s    pub fn f(&self, x: i64) -> i64 { x }%s}"
                       % (i, NL, i, NL, i, NL, NL) for i in range(n))
        cs = NL.join("class C%d {%s    public C%d(int a) { }%s    public int F(int x) { return x; }%s}"
                     % (i, NL, i, NL, NL) for i in range(n))
        begin = time.perf_counter()
        supervisor.cpp_object_api(supervisor.blank_code(cpp))
        ext = supervisor.blank_code(rust, rust=True)
        supervisor.rust_object_api(ext)
        supervisor.rust_capture_fields(ext)
        supervisor.cs_student_classes(cs)
        supervisor.cs_object_api(cs, "C0")
        self.assertLess(time.perf_counter() - begin, 10.0)

    def test_cpp_headers_without_body_do_not_share_one_brace(self):
        # Des milliers d'en-tetes sans corps devant UN gros corps : chacun prenait la meme
        # accolade, et le corps etait redecoupe pour chacun (92 s par cas pour 100 Ko, 147 s
        # avec des declarations anticipees). Seul le DERNIER en-tete possede ce corps.
        NL = self.NL
        body = "{" + NL + "public:" + NL + ("    int m(int a);" + NL) * 3000 + "};" + NL
        for head in ("class A" + NL, "struct A;" + NL):
            src = head * 6000 + "class Reel" + NL + body
            self.assertLessEqual(len(src), 200_000)
            begin = time.perf_counter()
            api = supervisor.cpp_object_api(supervisor.blank_code(src))
            self.assertLess(time.perf_counter() - begin, 5.0)
            self.assertEqual([name for name, _, _ in api], ["Reel"])

    def test_cpp_forward_declaration_does_not_take_the_next_body(self):
        # `class B;` recevait le corps de la classe suivante : un bouchon B, qui ne compilait pas.
        src = self.NL.join(["class B;", "class A {", "public:", "    A(int x) { }",
                            "    int f() { return 1; }", "};", ""])
        self.assertEqual(supervisor.cpp_object_api(supervisor.blank_code(src)),
                         [("A", [["int"]], [("int", "f", [])])])
        # Accolade sur la ligne suivante, heritage et `final` : toujours le corps de l'en-tete.
        # Un `struct` / `class` dans la CLAUSE DE BASE n'est pas un autre en-tete.
        for head in ("class A" + self.NL + "{", "class A final : public Base {",
                     "struct A : Base<int> {", "class A : public Base<struct Tag> {",
                     "class A : public Base<class T>, public Autre {"):
            # Constructeur DECLARE : une classe derivee n'a pas de constructeur implicite proxifie.
            src = self.NL.join([head, "public:", "    A(int x) { }",
                                "    int f() { return 1; }", "};"])
            api = supervisor.cpp_object_api(supervisor.blank_code(src))
            self.assertEqual([name for name, _, _ in api], ["A"], head)

    def test_rust_extraction_chains_are_linear(self):
        # Les CHAINES completes, pas seulement les motifs : `;pub(` et `;#[` repetes sur une
        # ligne tenaient rust_signatures et rust_without_main 8 a 12 s par cas pour 100 Ko.
        for src in (";pub(" * 20_000, ";#[" * 33_000):
            begin = time.perf_counter()
            supervisor.rust_signatures(supervisor.blank_code(src, rust=True))
            supervisor.rust_without_main(src)
            self.assertLess(time.perf_counter() - begin, 3.0)

    def test_attribute_lines_and_trait_headers_are_linear(self):
        # Revue #246 : la répétition des attributs franchissait les fins de ligne, et chaque ligne
        # d'attribut faisait relire tout le reste — 80 s (C++) et 130 s (Rust) par cas pour
        # 100 Ko, hors de tout délai ; `trait a` sans accolade, 3,5 s.
        cpp = "[[a]]\n" * 16_000 + "int f(int x) { return x; }\n"
        rust = "#[a]\n" * 19_000 + "pub struct S { pub a: i64 }\nfn f(x: i64) -> i64 { x }\n"
        begin = time.perf_counter()
        self.assertEqual(supervisor.c_signatures(supervisor.blank_code(cpp), cpp=True),
                         [("int", "f", ["int"])])
        ext = supervisor.blank_code(rust, rust=True)
        supervisor.rust_signatures(ext)
        supervisor.rust_object_api(ext)
        supervisor.rust_capture_fields(ext)
        supervisor.rust_object_api(supervisor.blank_code("trait a\n" * 12_000, rust=True))
        self.assertLess(time.perf_counter() - begin, 3.0)
        # Un attribut seul sur sa ligne, ou plusieurs devant la signature : toujours reconnus.
        self.assertEqual(supervisor.c_signatures(supervisor.blank_code(
            "[[nodiscard]]\nint f(int x) { return x; }\n"
            "[[nodiscard]] [[maybe_unused]] int g(int x) { return x; }\n"), cpp=True),
            [("int", "f", ["int"]), ("int", "g", ["int"])])
        self.assertEqual(supervisor.rust_object_api(supervisor.blank_code(
            "#[derive(Debug)]\n#[allow(dead_code)]\npub struct R { pub a: i64 }\n"
            "impl R { pub fn new(a: i64) -> Self { R { a } } pub fn g(&self) -> i64 { self.a } }\n",
            rust=True)), [("R", [("new", ["i64"])], [("i64", "g", [])])])

    def test_harness_mentions_blanks_the_harness_once(self):
        # Revue #246 : le harnais était reblanchi pour CHAQUE nom soumis (3,8 s par cas pour
        # 4 000 fonctions soumises).
        harness = "// commentaire max\nreturn f(1) == 1 && g(2) == 2;\n" * 1_000
        with unittest.mock.patch.object(supervisor, "blank_code",
                                        wraps=supervisor.blank_code) as blank:
            supervisor._harness_words.cache_clear()
            hits = [n for n in ("f%d" % i for i in range(4_000)) if supervisor.harness_mentions(harness, n)]
            self.assertTrue(supervisor.harness_mentions(harness, "g"))
            self.assertFalse(supervisor.harness_mentions(harness, "max"))
        self.assertEqual([], hits)
        self.assertEqual(1, blank.call_count)

    def test_rust_visibility_and_attributes_still_recognised(self):
        self.assertEqual(
            supervisor.rust_signatures("pub(in crate::outils) fn f(a: i32) -> i32 { a }"),
            [("i32", "f", ["i32"])])
        renamed = supervisor.rust_without_main(
            "#[allow(dead_code)] #[inline] pub(crate) fn main() {}")
        self.assertIn("fn __moodit_student_main()", renamed)
        self.assertNotIn("fn main()", renamed)


class Review30Test(unittest.TestCase):
    """Une statique homonyme dans deux classes ne donne qu'UN bouchon (Java et C#)."""

    NL = chr(10)

    def test_java_same_static_in_nested_class(self):
        javap = self.NL.join([
            "Compiled from \"Solution.java\"",
            "public class Solution {",
            "  public static int calcul(int);",
            "}",
            "Compiled from \"Solution.java\"",
            "class Solution$Aide {",
            "  static int calcul(int);",
            "  static int autre(int);",
            "}", ""])
        self.assertEqual(supervisor.java_signatures(javap),
                         [("int", "calcul", ["int"]), ("int", "autre", ["int"])])

    def test_cs_same_static_in_two_classes(self):
        src = self.NL.join(["class Solution {", "    public static int Calcul(int n) { return n; }",
                            "}", "class Aide {", "    public static int Calcul(int n) { return 0; }",
                            "    public static int Calcul(int a, int b) { return 0; }", "}", ""])
        # La surcharge d'une AUTRE signature reste : seul le doublon exact part.
        self.assertEqual(supervisor.cs_signatures(src),
                         [("int", "Calcul", ["int"]), ("int", "Calcul", ["int", "int"])])


class Review31Test(unittest.TestCase):
    """Bouchons objet bornes a LEUR classe, dans chaque langage ; en-tetes du noteur C/C++."""

    NL = chr(10)

    def test_cs_methods_of_target_class_only(self):
        src = self.NL.join(["class Rectangle {", "  public Rectangle(int l, int h) { }",
                            "  public int Aire() { return 1; }", "}",
                            "class Carre {", "  public Carre(int c) { }",
                            "  public int Aire() { return 2; }", "  public int Cote() { return 2; }",
                            "}", ""])
        self.assertEqual(supervisor.cs_object_api(src, "Rectangle"),
                         ([["int", "int"]], [("int", "Aire", [])]))
        self.assertEqual(supervisor.cs_object_api(src, "Carre"),
                         ([["int"]], [("int", "Aire", []), ("int", "Cote", [])]))

    def test_cs_inheritance_and_nested_class(self):
        src = self.NL.join(["abstract class Forme {", "  public abstract int Aire();", "}",
                            "class Carre : Forme {", "  public Carre(int c) { }",
                            "  public override int Aire() { return 4; }",
                            "  class Detail { public int Aire() { return 0; } }", "}", ""])
        self.assertEqual(supervisor.cs_object_api(src, "Carre"), ([["int"]], [("int", "Aire", [])]))

    def test_rust_several_impl_blocks(self):
        src = self.NL.join(["pub struct R { l: i64 }", "impl R {",
                            "    pub fn new(l: i64) -> Self { R { l } }", "}",
                            "impl R {", "    pub fn aire(&self) -> i64 { self.l }", "}", ""])
        self.assertEqual(supervisor.rust_object_api(src), [("R", [("new", ["i64"])], [("i64", "aire", [])])])

    def test_cpp_nested_class(self):
        src = self.NL.join(["class A {", "public:", "  class B {", "  public:", "    B(int x) { }",
                            "    int g() { return 1; }", "  };", "  A(int x) { }",
                            "  int f() { return 1; }", "};", ""])
        # B ne s'ecrit que A::B : ni proxifiee, ni ses membres pris pour ceux de A.
        self.assertEqual(supervisor.cpp_object_api(src), [("A", [["int"]], [("int", "f", [])])])

    def test_c_grader_provides_math_and_bool_and_renames_stubs(self):
        grader_dir = supervisor.c_grader_source([("int", "arrondi", ["int"]), ("double", "f", ["double"]),
                                             ("double", "f", ["int"])],
                                            "return fabs(f(1.0) - 2.5) < 1e-9 && true;", "1",
                                            cpp=True)
        self.assertTrue(grader_dir.startswith("#include <math.h>" + self.NL + "#include <stdbool.h>"))
        self.assertIn("int moodit_f_arrondi(int a0) {", grader_dir)
        # Un seul #define par nom, meme surcharge ; place AVANT le harnais.
        self.assertEqual(grader_dir.count("#define f moodit_f_f"), 1)
        self.assertLess(grader_dir.index("#define arrondi moodit_f_arrondi"), grader_dir.index("moodit_harnais(void)"))


class ReservedNamesTest(unittest.TestCase):
    """Une fonction soumise au nom d'un OUTIL du harnais (fabs, isnan, max en Go…) prenait sa
    place dans le noteur : une `fabs` qui renvoie 0 faisait passer tout harnais flottant."""

    def test_c_probe_uses_the_grader_headers_and_catches_macros(self):
        probe = supervisor.c_probe_source(["fabs", "isnan"])
        self.assertTrue(probe.startswith(supervisor.C_GRADER_HEADER))
        for header in ("<stdio.h>", "<stdlib.h>", "<string.h>"):
            self.assertIn("#include " + header, probe)
        self.assertIn("#ifdef isnan\n#error moodit_reserve\n#endif\nint isnan;\n", probe)
        self.assertIn("int fabs;\n", probe)

    def test_c_reserved_names_with_the_real_compilers(self):
        # run_proc vide /tmp et tue les processus etudiants entre deux cas : neutralises ici,
        # sinon la sonde effacait son propre dossier temporaire (et le /tmp de la machine de CI).
        self.addCleanup(unittest.mock.patch.stopall)
        unittest.mock.patch.object(supervisor, "purge_shared_dirs", lambda: None).start()
        unittest.mock.patch.object(supervisor, "kill_student_survivors", lambda: None).start()
        compilers = [c for c in (("gcc", "-std=gnu17"), ("g++", "-std=c++20")) if shutil.which(c[0])]
        if not compilers:
            self.skipTest("gcc et g++ absents")
        for compiler, std in compilers:
            with self.subTest(compiler=compiler), tempfile.TemporaryDirectory() as d:
                found = supervisor.c_reserved_names(
                    ["moitie", "fabs", "sqrt", "isnan", "abs", "true", "f", "fabs"],
                    compiler, std, d, dict(os.environ))
                self.assertEqual(found, ["fabs", "sqrt", "isnan", "abs", "true"])
                self.assertEqual(supervisor.c_reserved_names(["moitie", "f"], compiler, std, d,
                                                             dict(os.environ)), [])

    def test_c_implementation_reserved_names(self):
        # `HUGE_VAL` se developpe en `__builtin_huge_val ()` : une fonction soumise de ce nom,
        # renommee par #define dans le noteur, detournait la constante vers le code note.
        self.assertEqual(supervisor.c_implementation_reserved(
            ["__builtin_huge_val", "_Exit", "a__b", "moitie", "_x", "f_", "__builtin_huge_val"]),
            ["__builtin_huge_val", "_Exit", "a__b"])

    def test_c_reserved_names_refuses_implementation_names_without_compiling(self):
        calls = []
        self.addCleanup(unittest.mock.patch.stopall)
        unittest.mock.patch.object(
            supervisor, "run_proc", lambda *a, **k: calls.append(a) or (0, False)).start()
        with tempfile.TemporaryDirectory() as d:
            found = supervisor.c_reserved_names(["__builtin_isnan", "moitie"], "gcc",
                                                "-std=gnu17", d, {})
        self.assertEqual(found, ["__builtin_isnan"])
        self.assertEqual(len(calls), 1)    # une seule sonde, pour le nom ordinaire

    def test_go_predeclared_names(self):
        self.assertEqual(supervisor.go_reserved_names(["doubler", "max", "min", "len", "max"]),
                         ["max", "min", "len"])
        self.assertEqual(supervisor.go_reserved_names(["Max", "abs"]), [])

    def test_message_names_every_offender(self):
        one = supervisor.reserved_name_message(["fabs"], "la bibliothèque standard")
        self.assertIn("« fabs » est déjà fourni au harnais par la bibliothèque standard", one)
        many = supervisor.reserved_name_message(["max", "min"], "le langage Go")
        self.assertIn("« max », « min » sont déjà fournis au harnais", many)


class Review246Test(unittest.TestCase):
    """Revue de la PR #246 : reponses Java/C# justes notees 0 ou fausses."""

    def test_java_anonymous_and_local_classes_are_not_nameable(self):
        self.assertTrue(supervisor.java_nameable_class("Solution"))
        self.assertTrue(supervisor.java_nameable_class("Solution$Rectangle"))
        self.assertFalse(supervisor.java_nameable_class("Solution$1"))
        self.assertFalse(supervisor.java_nameable_class("Solution$1Aide"))
        self.assertFalse(supervisor.java_nameable_class("Solution$1$Interne"))

    def test_java_anonymous_class_yields_no_stub(self):
        # Sortie javap d'un `new Comparator<Integer>() { ... }` dans une methode statique : le
        # constructeur sans parametre faisait passer la classe, et le bouchon `class 1 { ... }`
        # empechait le noteur de compiler -- reponse juste notee 0.
        javap = ("Compiled from \"Solution.java\"\n"
                 "final class Solution$1 implements java.util.Comparator<java.lang.Integer> {\n"
                 "  Solution$1();\n"
                 "  public int compare(java.lang.Integer, java.lang.Integer);\n"
                 "}\n")
        self.assertEqual(supervisor.java_class_api(javap), (None, [], []))
        local = ("Compiled from \"Solution.java\"\n"
                 "class Solution$1Acc {\n"
                 "  int t;\n"
                 "  Solution$1Acc();\n"
                 "  int total();\n"
                 "}\n")
        self.assertEqual(supervisor.java_class_api(local), (None, [], []))

    def test_rpc_name_carries_parameter_types(self):
        self.assertEqual(supervisor.rpc_name("f", ["int", "double"]), "f(int,double)")
        self.assertEqual(supervisor.rpc_name("f", []), "f()")

    def test_java_stubs_send_the_full_signature(self):
        stub = supervisor.java_stub_source(
            "Solution", [("int", "moitie", ["int"]), ("double", "moitie", ["double"])],
            objects=[("Solution.Rect", [["int"], ["double"]], [("int", "plus", ["int"])])])
        self.assertIn('MooditRpc.integer("moitie(int)"', stub)
        self.assertIn('MooditRpc.double_("moitie(double)"', stub)
        self.assertIn('MooditRpc.nouvelle("Solution.Rect(int)"', stub)
        self.assertIn('MooditRpc.nouvelle("Solution.Rect(double)"', stub)
        self.assertIn('MooditRpc.minteger(__h, "plus(int)"', stub)

    def test_java_server_resolves_by_parameter_types(self):
        server = supervisor.java_server_source(["Solution"])
        # Les resolutions (statique, constructeur, instance, methode `default` d'interface)
        # passent par `signe`, plus aucune par la seule arite.
        self.assertEqual(server.count("signe(m.getParameterTypes(), appel, args.length)"), 3)
        self.assertIn("m.isDefault()", server)
        self.assertIn("signe(c.getParameterTypes(), appel, args.length)", server)
        self.assertNotIn("getParameterCount()", server)

    def test_cs_stubs_and_server_use_the_full_signature(self):
        source = supervisor.cs_grader_source(
            [("int", "Moitie", ["int"]), ("double", "Moitie", ["double"])], "return true;",
            "N", "Rect", ctors=[["int"], ["double"]], instance=[("int", "Plus", ["int"])])
        self.assertIn('"|Moitie(int)"', source)
        self.assertIn('"|Moitie(double)"', source)
        self.assertIn('"|new|Rect(double)"', source)
        self.assertIn('"|Plus(int)"', source)
        server = supervisor.cs_server_source(["Solution"])
        self.assertEqual(server.count("Signe(c.GetParameters(), parts[2], parts.Length - 3)"), 1)
        self.assertEqual(server.count("Signe(m.GetParameters(), parts[3], parts.Length - 4)"), 1)
        self.assertEqual(server.count("Signe(m.GetParameters(), nom, parts.Length - 2)"), 1)


class Review246bTest(unittest.TestCase):
    """Seconde revue de la PR #246 : faux verdicts sur du code juste, et masquage de java.lang."""

    NL = "\n"

    def test_cs_object_api_check_ignores_the_harness(self):
        # Solution ne porte qu'un Main ; l'objet note est Rectangle. Le harnais d'un canari ne
        # nomme aucune classe : le controle doit trouver Rectangle quand meme, sinon le canari
        # etait refuse alors que le vrai cas passait -> « falsification probable ».
        src = self.NL.join([
            "class Solution { static void Main() { } }",
            "class Rectangle {",
            "    int l, h;",
            "    public Rectangle(int l, int h) { this.l = l; this.h = h; }",
            "    public int aire() { return l * h; }",
            "}", ""])
        self.assertEqual(supervisor.cs_student_class(src, "return __MOODIT_A__ == __MOODIT_B__;"),
                         "Solution")
        self.assertTrue(supervisor.cs_has_object_api(src))
        self.assertFalse(supervisor.cs_has_object_api("class Solution { static void Main() { } }"))

    def test_cs_generic_class_left_out_of_typeof(self):
        src = self.NL.join([
            "public class Pile<T> { public void Empile(T x) { } }",
            "public class Solution { public static int F(int n) { return n; } }", ""])
        self.assertEqual(supervisor.cs_top_level_classes(src), ["Solution"])
        server = supervisor.cs_server_source(supervisor.cs_student_classes(src))
        self.assertNotIn("typeof(Pile)", server)
        self.assertIn("typeof(Solution)", server)
        # Un heritage d'interface generique n'est pas une classe generique.
        self.assertEqual(supervisor.cs_top_level_classes(
            "class Note : System.IComparable<Note> { }"), ["Note"])

    def test_rust_two_new_functions_get_distinct_arms(self):
        obj_list = [("Compteur", [("new", ["i32"])], [("i32", "plus", ["i32"])]),
                    ("Pile", [("new", [])], [("i32", "taille", [])])]
        stub = supervisor.rust_object_stub(obj_list)
        self.assertIn('"|new|Compteur::new"', stub)
        self.assertIn('"|new|Pile::new"', stub)
        _, branches = supervisor.rust_object_dispatch(obj_list)
        self.assertEqual(branches.count('"new|Compteur::new" =>'), 1)
        self.assertEqual(branches.count('"new|Pile::new" =>'), 1)
        self.assertNotIn('"new|new" =>', branches)
        # Avec capture de champs aussi : meme cle des deux cotes.
        fields = {"Compteur": [("v", "i32")], "Pile": [("n", "i32")]}
        stub = supervisor.rust_object_stub(obj_list, fields)
        _, branches = supervisor.rust_object_dispatch(obj_list, fields)
        for typ in ("Compteur", "Pile"):
            self.assertIn('"|new|%s::new"' % typ, stub)
            self.assertEqual(branches.count('"new|%s::new" =>' % typ), 1)

    def test_java_class_shadowing_java_lang_used_by_harness(self):
        harness = "return new StringBuffer(\"abc\").reverse().toString().equals(Solution.inv(\"abc\"));"
        self.assertEqual(supervisor.java_shadowed_names(["Solution", "StringBuffer"], harness),
                         ["StringBuffer"])
        # Nom absent du harnais (ou seulement en commentaire / chaine) : rien a refuser.
        self.assertEqual(supervisor.java_shadowed_names(["Process"], "return Solution.f() == 1;"), [])
        self.assertEqual(supervisor.java_shadowed_names(
            ["Process"], "// Process\nreturn \"Process\".length() == 7;"), [])
        self.assertEqual(supervisor.java_shadowed_names(["Rectangle"], "new Rectangle(1, 2)"), [])

    def test_java_lang_named_helper_class_gets_no_stub(self):
        # Une `class Long` d'aide, que le harnais ne nomme pas : son bouchon masquait
        # java.lang.Long dans le runtime du noteur (`Long.toHexString`) — « Le harnais ne
        # compile pas » sur une réponse juste. Elle n'a plus de bouchon ; les autres le gardent.
        long_class = ("Long", [["int"]], [("int", "get", [])])
        rect = ("Rectangle", [["int", "int"]], [("int", "aire", [])])
        nested = ("Solution.Object", [[]], [("int", "f", [])])
        harness = "// Long\nreturn Solution.doubler(2) == 4 && new Rectangle(1, 2).aire() == 2;"
        kept = supervisor.java_grader_objects([long_class, rect, nested], harness)
        self.assertEqual(kept, [rect])
        stub = supervisor.java_stub_source("Solution", [("int", "doubler", ["int"])], kept)
        self.assertNotIn("class Long", stub)
        self.assertIn("final class Rectangle", stub)
        # Nommée par le harnais : le bouchon reste (et java_shadowed_names la refuse en amont).
        self.assertEqual(supervisor.java_grader_objects([long_class], "return new Long(1).get() == 1;"),
                         [long_class])

    def test_java_server_names_java_lang_types_in_full(self):
        # Le serveur est compilé dans le paquet du code soumis : une `class Long` (ou String,
        # Object…) soumise masquait le type de java.lang, et le serveur ne compilait plus.
        source = supervisor.java_server_source(["Solution", "Long"])
        self.assertIn("public static void main(java.lang.String[] args)", source)
        self.assertIn("type == java.lang.Long.class", source)
        # Les noms des classes soumises restent des chaînes intactes, rien n'est qualifié deux fois.
        self.assertIn('new java.lang.String[] {"Solution", "Long"}', source)
        self.assertNotIn("java.lang.java.lang", source)
        # Plus AUCUN type de java.lang en nom simple dans le serveur généré.
        bare = supervisor.blank_code(source)
        for name in supervisor.JAVA_LANG_TYPES:
            self.assertIsNone(re.search(r"(?<![\w.$@])%s(?![\w$])" % name, bare), name)
        # Un nom déjà qualifié, un membre et une annotation ne sont pas touchés.
        self.assertEqual(supervisor.java_qualify_lang("java.lang.String a; x.Long; @Override Longue"),
                         "java.lang.String a; x.Long; @Override Longue")

    def test_rust_main_with_modifiers_is_renamed(self):
        # `pub fn main()` restait en place : deux `main` avec celui du serveur (E0428), et 0
        # sur une réponse juste.
        renamed = "fn __moodit_student_main()"
        for head in ("fn main()", "pub fn main()", "pub(crate) fn main()", "pub  fn main ( )",
                     "unsafe fn main()", "pub const fn main()", "    fn main()"):
            out = supervisor.rust_without_main("fn f() {}\n" + head + " { }\n")
            self.assertIn(renamed, out, head)
            self.assertNotRegex(out, r"fn\s+main\b", head)
        # Les modificateurs restent, le type de retour aussi.
        self.assertEqual(supervisor.rust_without_main("pub fn main() -> Result<(), String> {"),
                         "pub fn __moodit_student_main() -> Result<(), String> {")
        # Pas un `main` de premier niveau : un sous-module, un autre nom, un appel.
        for kept in ("mod outils {\n    pub fn main() {}\n}\n", "pub fn main_loop() {}\n",
                     "pub fn main(n: i32) {}\n", "fn f() { main(); }\n"):
            self.assertEqual(supervisor.rust_without_main(kept), kept)

    def test_rust_only_the_top_level_main_is_renamed(self):
        # Un `fn main()` nu de sous-module, d'impl ou de trait était renommé sans que ses appels
        # le soient : le code soumis ne compilait plus, 0 sur une réponse juste.
        for kept in ("mod outils {\n    fn main() -> i32 { 2 }\n    pub fn deux() -> i32 { main() }\n}\n",
                     "impl App for A {\n    fn main() -> i32 { 2 }\n}\n",
                     "trait App {\n    fn main() -> i32;\n}\n",
                     "mod a {\n    mod b {\n        pub fn main() {}\n    }\n}\n"):
            self.assertEqual(supervisor.rust_without_main(kept), kept)
        # Le `main` de premier niveau qui suit un sous-module est renommé, lui, même indenté et
        # même après une accolade en littéral ou en commentaire.
        source = ("mod outils {\n    fn main() -> i32 { 2 }\n}\n"
                  "const C: char = '{'; // {\n"
                  "  pub fn main() { }\n")
        out = supervisor.rust_without_main(source)
        self.assertIn("    fn main() -> i32 { 2 }", out)
        self.assertIn("  pub fn __moodit_student_main() { }", out)

    def test_rust_main_after_code_or_attribute_on_its_line_is_renamed(self):
        # L'ancre de début de ligne seule laissait ces `main` en place : doublon avec celui du
        # serveur (E0428), 0 sur une réponse juste.
        renamed = "fn __moodit_student_main()"
        for source in ("fn doubler(n: i32) -> i32 { n * 2 } fn main() {}\n",
                       "struct S; pub fn main() {}\n",
                       "#[allow(dead_code)] fn main() {}\n",
                       "#[allow(dead_code)]\n#[inline] pub fn main() {}\n"):
            out = supervisor.rust_without_main(source)
            self.assertIn(renamed, out, source)
            self.assertNotRegex(out, r"fn\s+main\b", source)
        # Le reste de la ligne est intact, attributs compris.
        self.assertEqual(
            supervisor.rust_without_main("fn f() -> i32 { 2 } #[inline] fn main() {}"),
            "fn f() -> i32 { 2 } #[inline] fn __moodit_student_main() {}")
        # Sur une même ligne aussi, seul le premier niveau est renommé.
        for kept in ("mod m { fn main() {} }\n", "impl A { #[inline] fn main() {} }\n"):
            self.assertEqual(supervisor.rust_without_main(kept), kept)

    def test_digit_separator_follows_the_numeric_token_only(self):
        # Le jeton est suivi pendant le balayage au lieu d'être retrouvé en remontant : mêmes
        # décisions qu'avant sur les formes réelles.
        blank = supervisor.blank_code
        for kept in ("long a = 1'000'000;", "int b = 0xFF'FF;", "int c = 0b1010'1010;"):
            self.assertEqual(blank(kept), kept)
        # Un littéral de caractère, préfixé ou non, est blanchi : aucun jeton numérique devant.
        self.assertEqual(blank("char c = 'a'; int f();"), "char c =    ; int f();")
        self.assertEqual(blank("wchar_t c = L'a'; int f();"), "wchar_t c = L   ; int f();")
        self.assertEqual(blank("x = y1'a'; int f();"), "x = y1   ; int f();")
        # Un commentaire ou une chaîne coupe le jeton : l'apostrophe qui suit ouvre un littéral.
        self.assertEqual(blank("1/**/'0'; int f();"), "1       ; int f();")
        # Multi-lignes : le modificateur et le type sur deux lignes restent lus en C#.
        self.assertEqual(supervisor.cs_signatures("class S {\n    public\n    static int F(int a) { return a; }\n}"),
                         [("int", "F", ["int"])])

    def test_rust_impl_blocks_keep_only_their_direct_functions(self):
        # Lecture en une passe : chaque bloc garde ses fonctions directes, pas celles d'un
        # voisin, d'une fonction imbriquée ni d'un bloc qui le suit à la même profondeur.
        source = ("struct A; struct B;\n"
                  "impl A {\n    fn un(&self) -> i32 {\n        fn dedans() -> i32 { 1 }\n"
                  "        dedans()\n    }\n}\n"
                  "fn libre() -> i32 { 0 }\n"
                  "impl B { fn deux(&mut self) -> i32 { 2 } fn trois() -> B { B } }\n")
        self.assertEqual(supervisor.rust_impl_blocks(source),
                         [("A", [("un", "&self", "i32")]),
                          ("B", [("deux", "&mut self", "i32"), ("trois", "", "B")])])
        self.assertEqual(supervisor.rust_mut_receivers(source), {"B"})
        self.assertEqual(supervisor.rust_impl_blocks(None), [])

    def test_apostrophe_in_a_directive_does_not_blank_the_rest(self):
        # L'apostrophe d'une directive ouvrait un littéral de caractère jamais fermé : tout le
        # reste du fichier était blanchi, « aucune méthode exploitable » sur une réponse juste.
        cs = ("public class Solution {\n"
              "    #region Méthodes d'aide\n"
              "    public static int Doubler(int n) { return n * 2; }\n"
              "    #endregion\n"
              "}\n")
        cleaned = supervisor.cs_strip_comments(cs)
        self.assertNotIn("aide", cleaned)
        self.assertEqual(cleaned.count("\n"), cs.count("\n"))
        self.assertEqual([n for _, n, _ in supervisor.cs_signatures(cleaned)], ["Doubler"])
        # Un `#` qui n'ouvre pas la ligne n'est pas une directive.
        self.assertIn("int b = 2;", supervisor.cs_strip_comments('var s = "#"; int b = 2;\n'))
        # C et C++ : même défaut, le littéral de caractère s'arrête à la fin de sa ligne.
        c = ("#pragma message(\"l'entrée\")\n"
             "#error l'entrée manque\n"
             "int doubler(int n) { return n * 2; }\n")
        bare = supervisor.blank_code(c)
        self.assertEqual(bare.count("\n"), c.count("\n"))
        self.assertEqual([n for _, n, _ in supervisor.c_signatures(bare)], ["doubler"])
        # Un vrai littéral de caractère reste blanchi.
        self.assertNotIn("{", supervisor.blank_code("char c = '{'; char d = '\\'';"))

    def test_python_grader_runs_isolated_from_its_directory(self):
        # Sans -I, sys.path[0] = /box/src, inscriptible par le code soumis : un module déposé
        # là était importé PAR LE NOTEUR (via l'`import numpy` du harnais) et y lisait le nonce.
        _, run_cmd = supervisor.exec_commands("python", "grader.py")
        self.assertEqual(run_cmd, ["python3", "-I", "grader.py"])

    def test_java_instance_method_null_string_is_null(self):
        source = supervisor.java_grader_source("return true;", "N")
        body = source[source.index("static String mstring("):]
        body = body[:body.index("static int integer(")]
        self.assertIn('if (v.equals("null")) { return null; }', body)

    def test_rust_exec_uses_the_grading_edition(self):
        # Sans --edition, rustc compile en 2015 : « Exécuter » refusait du code que la
        # notation (édition 2021) acceptait.
        build, _ = supervisor.exec_commands("rust", "main.rs")
        self.assertEqual(build[build.index("--edition") + 1], "2021")


class Review246cTest(unittest.TestCase):
    """Troisième revue de la PR #246 : réponses justes notées fausses par les générateurs."""

    NL = "\n"

    CS_SRC = NL.join([
        "class Solution { public int Somme(int a, int b) => Calcul.Somme(a, b); }",
        "static class Calcul { public static int Somme(int a, int b) => a + b; }", ""])

    def test_cs_canary_grader_has_no_duplicate_member(self):
        # Le harnais d'un canari ne nomme aucune classe : les bouchons vont dans Solution, qui
        # porte une méthode d'instance de même signature que la statique de Calcul. Deux
        # membres identiques (CS0111) : le canari ne compilait pas, un vrai cas si → 0 et
        # « falsification probable » sur une réponse juste.
        extraction = supervisor.cs_canonical_types(supervisor.cs_strip_comments(self.CS_SRC))
        methods = supervisor.cs_signatures(extraction)
        canary_harness = "return __MOODIT_A__ == __MOODIT_B__;"
        klass = supervisor.cs_student_class(extraction, canary_harness)
        self.assertEqual(klass, "Solution")
        ctors, instance = supervisor.cs_object_api(extraction, klass)
        source = supervisor.cs_grader_source(methods, canary_harness, "N", klass, ctors, instance)
        self.assertEqual(len(re.findall(r"public (?:static )?int Somme\(int a0, int a1\)", source)), 1)
        self.assertIn("public int Somme(int a0, int a1)", source)
        # Le vrai cas (harnais qui nomme Calcul) garde, lui, sa statique.
        real = "return Calcul.Somme(2, 3) == 5;"
        klass = supervisor.cs_student_class(extraction, real)
        ctors, instance = supervisor.cs_object_api(extraction, klass)
        source = supervisor.cs_grader_source(methods, real, "N", klass, ctors, instance)
        self.assertIn("public static int Somme(int a0, int a1)", source)

    def test_cs_static_named_like_the_class_is_left_out(self):
        source = supervisor.cs_grader_source([("int", "Rect", ["int"]), ("int", "F", [])],
                                             "return true;", "N", "Rect")
        self.assertNotIn("public static int Rect(", source)
        self.assertIn("public static int F(", source)

    def test_canary_grader_build_failure_never_accuses(self):
        cases = [{"index": 0}, {"index": 1, "canary": "pass"}, {"index": 2, "canary": "fail"}]
        broken = supervisor.CaseOutcome(False, "x", ran=False, harness_build=True)
        outcomes = {0: outcome(True), 1: broken, 2: outcome(False)}
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
        # Un échec de compilation du CODE SOUMIS limité aux canaris, lui, accuse toujours.
        outcomes = {0: outcome(True), 1: outcome(False, ran=False), 2: outcome(False)}
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "incoherents")

    def test_canary_reserve_returned_as_canaries_run(self):
        self.assertEqual(supervisor.pending_canary_reserve(80.0, 2, 2), 80.0)
        self.assertEqual(supervisor.pending_canary_reserve(80.0, 2, 1), 40.0)
        self.assertEqual(supervisor.pending_canary_reserve(80.0, 2, 0), 0.0)
        self.assertEqual(supervisor.pending_canary_reserve(80.0, 0, 0), 0.0)

    def test_grader_dirs_live_outside_the_student_work_dir(self):
        directory = tempfile.mkdtemp()
        try:
            with unittest.mock.patch.object(supervisor.os, "chown", create=True) as chown:
                path = supervisor.grader_dir(directory, "noteur_tmp")
            self.assertEqual(os.path.dirname(path), directory)
            self.assertNotIn("work", os.path.relpath(path, directory))
            chown.assert_called_once_with(path, supervisor.grader_uid(), supervisor.grader_uid())
        finally:
            shutil.rmtree(directory, ignore_errors=True)
        # Sites d'appel : cf. IsolationInvariantsTest.test_grader_dirs_are_never_built_in_the_student_work_dir.

    def test_cpp_digit_separator_keeps_following_functions(self):
        src = self.NL.join([
            "const long LIMITE = 1'000;",
            "long carre(long x) { return x * x; }",
            "long moitie(long x) { return x / 2; }", ""])
        names = [ident for _, ident, _ in supervisor.c_signatures(supervisor.blank_code(src), cpp=True)]
        self.assertEqual(names, ["carre", "moitie"])
        self.assertIn("0xFF'FF", supervisor.blank_code("int m = 0xFF'FF;"))
        # Les vrais littéraux de caractère restent blanchis, préfixes compris.
        for literal in ("'{'", "L'{'", "u'{'", "'\\''"):
            self.assertNotIn("{", supervisor.blank_code("char c = %s;" % literal), literal)

    def test_rust_method_consuming_self_is_not_proxied(self):
        src = self.NL.join([
            "struct Rect { l: i64, h: i64 }",
            "impl Rect {",
            "    fn new(l: i64, h: i64) -> Rect { Rect { l, h } }",
            "    fn aire(&self) -> i64 { self.l * self.h }",
            "    fn agrandir(&mut self, k: i64) -> i64 { self.l *= k; self.l }",
            "    fn en_texte(self) -> String { format!(\"{}\", self.l) }",
            "    fn detruire(mut self) -> i64 { self.l = 0; self.l }",
            "}", ""])
        (typ, _, methods), = supervisor.rust_object_api(supervisor.blank_code(src, rust=True))
        self.assertEqual(typ, "Rect")
        self.assertEqual([m[1] for m in methods], ["aire", "agrandir"])

    def test_go_generated_imports_do_not_collide_with_submitted_names(self):
        methods = [("string", "hex", ["int"]), ("int", "json", []), ("int", "bufio", [])]
        harness = 'return strings.Contains(hex(255), "f") && fmt.Sprint(1) == "1"'
        grader = supervisor.go_grader_source(methods, harness, "N")
        server = supervisor.go_server_source(methods)
        for alias in ("moodit_hex \"encoding/hex\"", "moodit_json \"encoding/json\"",
                      "moodit_bufio \"bufio\"", "moodit_os \"os\"", "moodit_rand \"crypto/rand\""):
            self.assertIn(alias, grader)
        self.assertIn("moodit_hex.EncodeToString", grader)
        # Le harnais du prof n'est jamais réécrit, et garde fmt, math et strings par leur nom.
        self.assertIn(harness, grader)
        for plain in ('    "fmt"\n', '    "math"\n', '    "strings"\n'):
            self.assertIn(plain, grader)
        for alias in ("moodit_json", "moodit_fmt", "moodit_os", "moodit_strings", "moodit_bufio"):
            self.assertIn('    %s "' % alias, server)
        # Aucune référence nue à un paquet aliasé dans le code généré.
        for code, names in ((grader.replace(harness, ""), ("hex", "json", "bufio", "os", "rand")),
                            (server, ("json", "fmt", "os", "strings", "bufio"))):
            for name in names:
                self.assertIsNone(re.search(r"(?<![\w.])%s\." % name, code), name)
        self.assertEqual(supervisor.go_harness_package_names(["strings", "f", "math", "hex"]),
                         ["strings", "math"])

    def test_null_strings_travel_as_null(self):
        java_server = supervisor.java_server_source(["Solution"])
        self.assertIn('if (v.equals("null") && !type.isPrimitive()) { return null; }', java_server)
        grader = supervisor.cs_grader_source([("string", "F", ["string"])], "return true;", "N", "Solution")
        server = supervisor.cs_server_source(["Solution"])
        for source in (grader, server):
            self.assertIn('if (s == null) { return "N"; }', source)
            self.assertIn('if (v == "N") { return null; }', source)
        self.assertIn("if (v == null) { return Hexe(null); }", server)


class Review246dTest(unittest.TestCase):
    """Revue #246 (suite) : échec de compilation du noteur, protocole Rust, `in` en C#,
    dossiers Go de l'étudiant."""

    def test_aborted_harness_build_has_its_own_prefix(self):
        # Expirée ou tuée : pas de diagnostic, et JAMAIS le préfixe que
        # deploy/check-compiled-harnesses.py classe BLOQUANT.
        for expired, code in ((True, None), (True, 0), (False, -9)):
            with self.subTest(expired=expired, code=code):
                detail = supervisor.harness_build_failure(expired, code, "contre le code soumis",
                                                          "")
                self.assertTrue(detail.startswith(supervisor.HARNESS_BUILD_ABORTED))
                self.assertFalse(detail.startswith(supervisor.HARNESS_BUILD_ERROR))
                self.assertTrue(supervisor.is_harness_build_failure(detail))
        detail = supervisor.harness_build_failure(False, 1, "contre le code soumis", "CS0117")
        self.assertEqual(detail, supervisor.HARNESS_BUILD_ERROR + " contre le code soumis :\nCS0117")
        self.assertTrue(supervisor.is_harness_build_failure(detail))
        self.assertFalse(supervisor.is_harness_build_failure(
            "Échec de compilation :\n" + supervisor.HARNESS_BUILD_ABORTED))
        self.assertFalse(supervisor.is_harness_build_failure(None))

    def test_aborted_harness_build_stays_inconclusive(self):
        runners = dict(supervisor.RUNNERS)
        directory = tempfile.mkdtemp()
        box, base_env = supervisor.BOX, supervisor.base_env
        supervisor.BOX = directory
        supervisor.base_env = lambda case_dir: {"HOME": directory, "TMPDIR": directory}
        try:
            supervisor.RUNNERS["Java"] = lambda *a: (None, supervisor.harness_build_failure(
                True, None, "contre le code soumis", ""))
            issue = supervisor.execute_case("Java", {"index": 0}, 10)[0]
            self.assertTrue(issue.harness_build)
            self.assertTrue(supervisor.inconclusive(issue))
        finally:
            supervisor.BOX, supervisor.base_env = box, base_env
            supervisor.RUNNERS.clear()
            supervisor.RUNNERS.update(runners)
            shutil.rmtree(directory, ignore_errors=True)

    def test_rust_free_functions_named_like_object_ops(self):
        # Une fonction libre `method` ou `new` était prise pour une opération objet : le
        # serveur répondait « fonction inconnue » à une réponse juste.
        methods = [("i32", "method", ["i32"]), ("i32", "new", [])]
        grader = supervisor.rust_grader_source(methods, "method(3) == 6", "N")
        self.assertIn('id.clone() + "|call|method"', grader)
        self.assertIn('id.clone() + "|call|new"', grader)
        server = supervisor.rust_server_source(methods, "fn method(x: i32) -> i32 { x * 2 }")
        self.assertIn('} else if premier == "call" {', server)
        self.assertIn('        "method" => {', server)
        self.assertNotIn("premier.clone()", server)

    def test_csharp_in_parameter_converted_by_value(self):
        server = supervisor.cs_server_source(["Solution"])
        self.assertIn("if (pt.IsByRef) { pt = pt.GetElementType(); }", server)
        self.assertIn("Convert.ChangeType(brut, pt,", server)
        self.assertNotIn("Convert.ChangeType(brut, attendus[i].ParameterType", server)

    @unittest.skipUnless(os.name == "posix", "liens symboliques : POSIX requis")
    def test_go_student_dirs_reset_between_cases(self):
        # chown SIMULÉ : le vrai exige root, et ce test ne tournait alors nulle part (la CI
        # lance la suite sous un compte ordinaire). Le propriétaire demandé reste vérifié.
        directory = tempfile.mkdtemp()
        box = supervisor.BOX
        supervisor.BOX = directory
        try:
            with unittest.mock.patch.object(supervisor.os, "chown", create=True) as chown:
                supervisor.reset_go_student_dirs()
                for name in supervisor.GO_STUDENT_DIRS:
                    chown.assert_any_call(os.path.join(directory, name),
                                          supervisor.STUDENT_UID, supervisor.STUDENT_GID)
                    with open(os.path.join(directory, name, "plein"), "w") as f:
                        f.write("x")
                supervisor.reset_go_student_dirs(keep_cache=True)
                self.assertEqual(os.listdir(os.path.join(directory, "gopath_etu")), [])
                self.assertEqual(os.listdir(os.path.join(directory, "gocache_etu")), ["plein"])
                # Un lien posé par l'étudiant est retiré, jamais suivi.
                shutil.rmtree(os.path.join(directory, "gopath_etu"))
                cible = tempfile.mkdtemp()
                open(os.path.join(cible, "garde"), "w").close()
                os.symlink(cible, os.path.join(directory, "gopath_etu"))
                supervisor.reset_go_student_dirs(keep_cache=True)
                self.assertFalse(os.path.islink(os.path.join(directory, "gopath_etu")))
                self.assertTrue(os.path.exists(os.path.join(cible, "garde")))
                shutil.rmtree(cible, ignore_errors=True)
        finally:
            supervisor.BOX = box
            shutil.rmtree(directory, ignore_errors=True)

    def test_go_student_dirs_only_for_go(self):
        # Les dossiers ne sont plus créés au démarrage pour tous les langages.
        with open(supervisor.__file__, encoding="utf-8") as f:
            source = f.read()
        main_body = source.split("\ndef main():", 1)[1]
        # Un seul appel, et sous la garde du langage Go.
        self.assertEqual(1, main_body.count("reset_go_student_dirs("))
        call = main_body.index("reset_go_student_dirs(")
        guard = main_body.rfind('if language == "go":', 0, call)
        self.assertGreaterEqual(guard, 0)
        self.assertEqual(0, main_body.count("\n    if ", guard + 1, call))


class Review246eTest(unittest.TestCase):
    """Revue exhaustive de la PR #246 : réponses justes notées 0 ou accusées à tort."""

    NL = "\n"

    def setUp(self):
        supervisor.EVENTS.clear()

    # ── Canaris ──────────────────────────────────────────────────────────────────────────
    def test_frozen_pass_canary_does_not_accuse_when_the_other_is_confirmed(self):
        # Hôte chargé : le canari « pass » expire ou son noteur est tué, le canari « fail »
        # échoue normalement, un cas réel passe. Aucune falsification possible ici.
        cases = [{"index": 0, "canary": "pass"}, {"index": 1, "canary": "fail"}, {"index": 2}]
        for frozen in (supervisor.CaseOutcome(False, "expire", ran=True, timed_out=True),
                       supervisor.CaseOutcome(False, "tue", ran=True, killed=True)):
            outcomes = {0: frozen,
                        1: supervisor.CaseOutcome(False, "echoue comme prevu", ran=True),
                        2: supervisor.CaseOutcome(True, None, ran=True)}
            self.assertEqual(supervisor.canary_verdict(cases, outcomes), "indetermines")
            self.assertEqual(supervisor.EVENTS, [])

    def test_frozen_fail_canary_confirms_nothing(self):
        # Les DEUX canaris gelés, un cas réel vert : le canari « fail » gelé a « échoué », mais
        # ce n'est pas une confirmation — le gel sélectif reste accusé, tué comme expiré.
        cases = [{"index": 0, "canary": "pass"}, {"index": 1, "canary": "fail"}, {"index": 2}]
        outcomes = {0: supervisor.CaseOutcome(False, "tue", ran=True, killed=True),
                    1: supervisor.CaseOutcome(False, "expire", ran=True, timed_out=True),
                    2: supervisor.CaseOutcome(True, None, ran=True)}
        self.assertEqual(supervisor.canary_verdict(cases, outcomes), "incoherents")

    # ── Go ───────────────────────────────────────────────────────────────────────────────
    GO_POINTER = ("package main\n\n"
                  "type Rectangle struct {\n\tlargeur int\n\thauteur int\n}\n\n"
                  "func (r *Rectangle) aire() int { return r.largeur * r.hauteur }\n"
                  "func (r *Rectangle) agrandir(k int) int { r.largeur *= k; return r.largeur }\n"
                  "func (r Rectangle) perimetre() int { return 2 * (r.largeur + r.hauteur) }\n")

    def test_go_pointer_receiver_keeps_field_capture(self):
        # Question 15 de la démo : le harnais construit par littéral, et l'étudiant a choisi
        # un récepteur pointeur. « Aucune fonction exploitable » sur une réponse juste.
        fields = supervisor.go_capture_fields(self.GO_POINTER)
        obj_list = supervisor.go_object_api(self.GO_POINTER)
        self.assertEqual([t for t, _, _ in obj_list], ["Rectangle"])
        pointers = supervisor.go_pointer_methods(self.GO_POINTER)
        self.assertEqual(pointers, {("Rectangle", "aire"), ("Rectangle", "agrandir")})
        stub = supervisor.go_object_stub(obj_list, fields, pointers)
        # Récepteur pointeur conservé, et champs RECOPIÉS après l'appel.
        self.assertIn("func (o *Rectangle) agrandir(a0 int) int {", stub)
        self.assertIn('mooditMethode(moodit_h, "Rectangle.#champs"', stub)
        self.assertIn("o.largeur = int(mooditEntier(mooditIndex(moodit_c, 0)))", stub)
        self.assertIn("o.hauteur = int(mooditEntier(mooditIndex(moodit_c, 1)))", stub)
        # Le récepteur valeur garde sa forme : `Rectangle{…}.perimetre()` doit compiler.
        self.assertIn("func (o Rectangle) perimetre() int {", stub)
        _, method_branch = supervisor.go_object_dispatch(obj_list, fields)
        self.assertIn('case "Rectangle.#champs":', method_branch)
        self.assertIn("mooditValeur = []interface{}{moodit_lu.largeur, moodit_lu.hauteur}", method_branch)
        # Sans l'information de récepteur, aucune relecture (comportement d'avant).
        self.assertNotIn("#champs", supervisor.go_object_stub(obj_list, fields))

    def test_go_struct_without_field_is_proxied(self):
        source = ("package main\n\ntype Calculatrice struct{}\n\n"
                  "func NewCalculatrice() Calculatrice { return Calculatrice{} }\n"
                  "func (c *Calculatrice) additionner(a, b int) int { return a + b }\n")
        fields = supervisor.go_capture_fields(source)
        self.assertEqual(fields, {"Calculatrice": []})
        obj_list = supervisor.go_object_api(source)
        self.assertEqual([t for t, _, _ in obj_list], ["Calculatrice"])
        stub = supervisor.go_object_stub(obj_list, fields, supervisor.go_pointer_methods(source))
        # Rien à relire : ni variable inutilisée (refus du compilateur), ni relecture de champs.
        self.assertIn('_ = mooditChamps("NewCalculatrice"', stub)
        self.assertNotIn("champs :=", stub)
        self.assertNotIn("#champs", stub)
        self.assertIn("func (o *Calculatrice) additionner(a0 int, a1 int) int {", stub)
        new_branch, method_branch = supervisor.go_object_dispatch(obj_list, fields)
        self.assertIn("_ = moodit_cree", new_branch)
        self.assertNotIn("#champs", method_branch)
        # Un champ non transportable écarte toujours la structure.
        self.assertEqual(supervisor.go_capture_fields(
            "type T struct {\n\tm map[string]int\n}\n"), {})

    def test_go_reserved_name_refused_only_when_the_harness_uses_it(self):
        # `func max` d'aide, que le harnais n'appelle pas : omise du noteur, pas refusée.
        self.assertEqual(supervisor.go_hidden_names(["max", "plusGrand"],
                                                    "return plusGrand(2, 3) == 3"),
                         ([], [], ["max"]))
        # Le harnais emploie `max` : il ne pourrait plus désigner l'intégrée.
        self.assertEqual(supervisor.go_hidden_names(["max"], "return max(2, 3) == 3"),
                         (["max"], [], []))
        # Le serveur généré a besoin de `len` : refusé même si le harnais ne le nomme pas.
        self.assertEqual(supervisor.go_hidden_names(["len"], "return f() == 1"),
                         (["len"], [], []))
        self.assertEqual(supervisor.go_hidden_names(["math", "strings"],
                                                    "return math.Abs(f() - 1) < 1e-9"),
                         ([], ["math"], ["strings"]))
        methods = [("int", "max", ["int", "int"]), ("int", "f", [])]
        objects = [("T", [("new", [], False), ("NewT", [], False)], [("int", "m", [])]),
                   ("clear", [], [("int", "m", [])])]
        self.assertEqual(supervisor.go_without_hidden(methods, objects, ["max", "new", "clear"]),
                         ([("int", "f", [])],
                          [("T", [("NewT", [], False)], [("int", "m", [])])]))

    def test_go_server_predeclared_list_matches_the_generated_server(self):
        # Tout identifiant prédéclaré dont le serveur généré se sert doit rester refusé.
        obj_list = [("T", [("NewT", ["int"], True)], [("bool", "m", ["string", "float64"])])]
        server = supervisor.go_server_source([("int64", "f", ["int"])], obj_list,
                                             {"T": [("x", "int")]})
        # Hors chaînes et étiquettes (`json:"error"`, "new") : ce ne sont pas des identifiants.
        code = supervisor.blank_code(server, backticks=True)
        used = set(re.findall(r"\w+", code)) & supervisor.GO_PREDECLARED
        self.assertEqual(used - supervisor.GO_SERVER_PREDECLARED, set())

    def test_harness_mentions_whole_words_only(self):
        self.assertTrue(supervisor.harness_mentions("return max(1, 2) == 2", "max"))
        self.assertFalse(supervisor.harness_mentions("return maximum(1, 2) == 2", "max"))
        self.assertFalse(supervisor.harness_mentions("return le_max(1, 2) == 2", "max"))
        self.assertFalse(supervisor.harness_mentions(None, "max"))
        # Une chaîne ou un commentaire n'appelle rien (revue #246 : un `max` cité en commentaire
        # faisait refuser la fonction d'aide d'une réponse juste).
        self.assertFalse(supervisor.harness_mentions('return f() == "max"', "max"))

    # ── C / C++ ──────────────────────────────────────────────────────────────────────────
    def test_c_probe_plan_is_bounded(self):
        names = ["f%d" % i for i in range(5000)]
        plan = supervisor.c_probe_plan(names)
        self.assertEqual(len(plan), supervisor.C_PROBE_MAX + 1)
        self.assertEqual([n for group in plan for n in group], names)
        self.assertEqual(supervisor.c_probe_plan(["a", "b"]), [["a"], ["b"]])

    def test_c_reserved_probes_do_not_grow_with_the_names(self):
        calls = []

        def fake_run_proc(cmd, *args):
            calls.append(cmd)
            return 1, False                    # toute sonde échoue : pire cas

        directory = tempfile.mkdtemp()
        try:
            with unittest.mock.patch.object(supervisor, "run_proc", fake_run_proc), \
                    unittest.mock.patch.object(supervisor, "write_private"):
                found = supervisor.c_reserved_names(["f%d" % i for i in range(3000)],
                                                    "g++", "-std=c++17", directory, {})
        finally:
            shutil.rmtree(directory, ignore_errors=True)
        self.assertEqual(len(found), 3000)
        self.assertEqual(len(calls), supervisor.C_PROBE_MAX + 2)

    def test_cpp_abstract_and_template_classes_are_not_proxied(self):
        src = self.NL.join([
            "class Forme {",
            "public:",
            "    Forme(double l, double h) : l(l), h(h) {}",
            "    virtual double aire() const = 0;",
            "protected:",
            "    double l, h;",
            "};",
            "class Rectangle : public Forme {",
            "public:",
            "    Rectangle(double l, double h) : Forme(l, h) {}",
            "    double aire() const override { return l * h; }",
            "};",
            "template <typename T>",
            "class Boite {",
            "public:",
            "    Boite(int n) {}",
            "    int taille() { return 1; }",
            "};", ""])
        obj_list = supervisor.cpp_object_api(supervisor.blank_code(src))
        self.assertEqual(obj_list, [("Rectangle", [["double", "double"]],
                                     [("double", "aire", [])])])
        stacks, _ = supervisor.cpp_object_dispatch(obj_list)
        self.assertNotIn("Forme", stacks)
        self.assertNotIn("Boite", stacks)

    def test_cpp_class_without_declared_constructor_gets_the_default_one(self):
        src = self.NL.join([
            "class Calculatrice {",
            "public:",
            "    int additionner(int a, int b) { return a + b; }",
            "};",
            "class Fermee {",
            "    Fermee() {}",                       # constructeur PRIVÉ : pas de défaut implicite
            "public:",
            "    int f() { return 1; }",
            "};",
            "class Base {",
            "public:",
            "    Base(int n) {}",
            "    int g() { return 1; }",
            "};",
            "class Derivee : public Base {",         # dérivée : `Derivee()` peut ne pas compiler
            "public:",
            "    int h() { return 2; }",
            "};", ""])
        obj_list = supervisor.cpp_object_api(supervisor.blank_code(src))
        # La DÉRIVÉE reçoit aussi le constructeur par défaut : le serveur le construit par
        # moodit_cree, qui le refuse à l'exécution s'il ne compile pas (ici, Base(int) seul),
        # au lieu de casser le programme de l'étudiant.
        self.assertEqual(obj_list, [
            ("Calculatrice", [[]], [("int", "additionner", ["int", "int"])]),
            ("Base", [["int"]], [("int", "g", [])]),
            ("Derivee", [[]], [("int", "h", []), ("int", "g", [])])])
        self.assertIn("    Calculatrice() {", supervisor.cpp_object_stub(obj_list))
        stacks, branches = supervisor.cpp_object_dispatch(obj_list)
        self.assertIn("::Calculatrice *moodit_o = moodit_cree< ::Calculatrice >();", branches)
        self.assertIn("__is_constructible(moodit_K, moodit_A&...)", stacks)
        self.assertNotIn("new ::", branches)

    # ── Rust ─────────────────────────────────────────────────────────────────────────────
    def test_rust_unit_struct_is_proxied(self):
        for declaration in ("struct Calculatrice;", "struct Calculatrice {}"):
            src = self.NL.join([
                declaration,
                "impl Calculatrice {",
                "    fn additionner(&self, a: i32, b: i32) -> i32 { a + b }",
                "}", ""])
            extraction = supervisor.blank_code(src, rust=True)
            fields = supervisor.rust_capture_fields(extraction)
            self.assertEqual(fields, {"Calculatrice": []}, declaration)
            obj_list = supervisor.rust_object_api(extraction)
            self.assertEqual([t for t, _, _ in obj_list], ["Calculatrice"], declaration)
            # Structure unité côté noteur : le harnais écrit `Calculatrice` ou `Calculatrice {}`.
            self.assertIn("struct Calculatrice;", supervisor.rust_object_stub(obj_list, fields))
            self.assertIn("moodit_calculatrice.push(crate::Calculatrice {  });",
                          supervisor.rust_object_dispatch(obj_list, fields)[1])
        self.assertEqual(supervisor.rust_struct_fields("struct P(i32);\n"), {})

    # ── Java / C# ────────────────────────────────────────────────────────────────────────
    def test_java_secondary_class_keeps_its_own_statics(self):
        statics = [("int", "carre", ["int"]), ("int", "sommeCarres", ["int", "int"])]
        source = supervisor.java_stub_source(
            "Aide", statics, [("Solution", [[]], [])],
            class_statics={"Solution": [("int", "sommeCarres", ["int", "int"])]})
        solution = source.split("final class Solution {", 1)[1]
        self.assertIn("public static int sommeCarres(int a0, int a1) {", solution)
        # La classe voyage avec le nom : le serveur cherche dans CETTE classe, et non d'abord
        # dans la principale, qui peut avoir une statique homonyme.
        self.assertIn('MooditRpc.integer("Solution#%s"' % supervisor.rpc_name("sommeCarres", ["int", "int"]),
                      solution)
        server = supervisor.java_server_source(["Aide", "Solution"])
        self.assertIn("int diese = appel.indexOf('#');", server)
        # Classe imbriquée : même règle, dans sa coquille.
        nested = supervisor.java_stub_source(
            "Solution", [], [("Solution.Outil", [[]], [])],
            class_statics={"Solution.Outil": [("int", "f", [])]})
        self.assertIn("        public static int f() {", nested)

    def test_java_flattened_static_does_not_duplicate_an_instance_method(self):
        source = supervisor.java_stub_source(
            "Solution", [("int", "calcul", ["int"]), ("int", "autre", [])],
            self_ctors=[[]], self_instance=[("int", "calcul", ["int"])])
        self.assertEqual(len(re.findall(r"int calcul\(int a0\)", source)), 1)
        self.assertIn("public int calcul(int a0) {", source)
        self.assertIn("public static int autre() {", source)

    def test_java_server_calls_statics_only_and_relays_the_cause(self):
        server = supervisor.java_server_source(["Solution"])
        self.assertIn("java.lang.reflect.Modifier.isStatic(m.getModifiers())", server)
        self.assertIn("t instanceof java.lang.reflect.InvocationTargetException", server)
        self.assertIn("String.valueOf(cause)", server)
        self.assertNotIn("String.valueOf(t)", server)

    def test_csharp_static_constructor_does_not_duplicate_the_default_one(self):
        src = self.NL.join([
            "class Compteur {",
            "    static int total;",
            "    static Compteur() { total = 0; }",
            "    public Compteur() { }",
            "    public Compteur(int depart) { }",
            "    public int Valeur() { return 1; }",
            "}", ""])
        extraction = supervisor.cs_canonical_types(supervisor.cs_strip_comments(src))
        ctors, _ = supervisor.cs_object_api(extraction, "Compteur")
        self.assertEqual(ctors, [[], ["int"]])


class ServerLocalsDoNotShadowSubmittedFunctionsTest(unittest.TestCase):
    """Le serveur généré partage la portée du code soumis : aucune de ses locales ne doit porter
    un nom qu'une fonction soumise peut porter (réponse juste notée 0, faute de compiler)."""

    def test_rust_calls_submitted_functions_by_absolute_path(self):
        server = supervisor.rust_server_source(
            [("bool", "premier", ["i32"]), ("i32", "id", ["i32"]), ("String", "cle", ["String"])],
            "")
        self.assertIn("crate::premier(a0)", server)
        self.assertIn("crate::id(a0)", server)
        self.assertIn("moodit_hexe(&crate::cle(a0))", server)
        # Aucun appel par nom nu : il viserait la locale du serveur.
        self.assertIsNone(re.search(r"(?<![:\w])(premier|id|cle)\(a0\)", server))

    def test_rust_field_locals_are_prefixed(self):
        obj_list = [("Point", [], [("i32", "somme", [])])]
        _, branches = supervisor.rust_object_dispatch(obj_list, {"Point": [("id", "i32"),
                                                                            ("args", "i32")]})
        self.assertIn("let moodit_c_id = ", branches)
        self.assertIn("Point { id: moodit_c_id, args: moodit_c_args }", branches)
        self.assertNotIn("let id = ", branches)
        self.assertNotIn("let args = ", branches)

    def test_go_server_declares_only_prefixed_locals_where_it_calls(self):
        server = supervisor.go_server_source([("int", "valeur", ["int"])])
        self.assertIn("mooditValeur = valeur(int(mooditEntier(mooditDemande.Args[0])))", server)
        body = server.split("func mooditServe() {", 1)[1].split("\nfunc main() {", 1)[0]
        # Tout ce qui est en portée à l'appel porte le préfixe ; restent `r` (dans le defer) et
        # `brut` / `errRep`, déclarées après la fermeture qui appelle le code soumis.
        declared = set(re.findall(r"\bvar (\w+)", body))
        for group in re.findall(r"([\w, ]+?) :=", body):
            declared.update(n.strip() for n in group.split(",") if n.strip() != "if")
        declared = {n.split()[-1] for n in declared}
        self.assertEqual({n for n in declared if not n.startswith("moodit")},
                         {"r", "brut", "errRep"})

    def test_go_object_dispatch_uses_the_prefixed_locals(self):
        new_branch, method_branch = supervisor.go_object_dispatch(
            [("Compteur", [("NewCompteur", ["int"], True)], [("int", "valeur", [])])])
        both = new_branch + method_branch
        self.assertIn("mooditValeur = mooditObjets[mooditDemande.Handle].(*Compteur).valeur()",
                      both)
        self.assertIsNone(re.search(r"(?<!\w)(req|valeur) ?[.=]", both.replace(".valeur()", "")))

    def test_c_server_locals_and_parameters_are_prefixed(self):
        for cpp in (False, True):
            server = supervisor.c_server_source([("int", "id", ["int"]), ("int", "nom", ["int"])],
                                                 "", cpp=cpp)
            self.assertIn("moodit_traite(const char *moodit_id, const char *moodit_op,", server)
            self.assertIn("int moodit_a0 = moodit_lit_int(moodit_jeton());", server)
            # En C++, l'appel est qualifié : `using namespace std;` rendait ambiguë une fonction
            # soumise au nom d'un type de la bibliothèque (`divides`, `modulus`, `plus`…).
            scope = "::" if cpp else ""
            self.assertIn('moodit_id, (int) %sid(moodit_a0));' % scope, server)
            self.assertIn('moodit_id, (int) %snom(moodit_a0));' % scope, server)
            traite = server.split("static void moodit_traite(", 1)[1].split("\nint main(void)")[0]
            self.assertIsNone(re.search(r"(?<![\w\"|])(id|op|nom|a0)(?![\w(\"])", traite))

    def test_c_multiword_parameter_type_is_not_read_as_its_first_word(self):
        # `long double x` passait pour un `long` : le bouchon tronquait l'argument, et une
        # réponse juste était notée fausse. Hors des types transportables : pas de bouchon.
        for cpp in (False, True):
            self.assertEqual(supervisor.c_signatures(
                "double racine(long double x) { return 0; }\n", cpp=cpp), [])
            self.assertEqual(supervisor.c_signatures(
                "long somme(long long a, long b) { return 0; }\n", cpp=cpp), [])
            self.assertEqual(supervisor.c_signatures(
                "int f(const int n, long m) { return 0; }\n", cpp=cpp), [("int", "f", ["int", "long"])])

    def test_rust_functions_are_read_wherever_they_start_on_the_line(self):
        # `impl R { fn get(&self) -> i32 { self.v } }` sur une ligne : la méthode n'était pas
        # vue (ancre de début de ligne), et une réponse juste rendait « aucune fonction
        # exploitable ». Même chose pour une seconde fonction sur la même ligne.
        one_line = "struct R { v: i32 }\nimpl R { fn get(&self) -> i32 { self.v } }\n"
        self.assertEqual(supervisor.rust_object_api(one_line), [("R", [], [("i32", "get", [])])])
        two = "struct R { v: i32 }\nimpl R {\n    fn new(a: i32) -> R { R { v: a } } pub fn get(&self) -> i32 { self.v }\n}\n"
        self.assertEqual(supervisor.rust_object_api(two),
                         [("R", [("new", ["i32"])], [("i32", "get", [])])])
        self.assertEqual(
            supervisor.rust_signatures("fn a(x: i32) -> i32 { x } fn b(x: i32) -> i32 { x }\n"),
            [("i32", "a", ["i32"]), ("i32", "b", ["i32"])])
        # Une fonction IMBRIQUÉE n'est ni une méthode du type ni une fonction libre.
        nested = ("struct R { v: i32 }\nimpl R {\n    fn get(&self) -> i32 {\n"
                  "        fn aide(x: i32) -> i32 { x }\n        aide(self.v)\n    }\n}\n")
        self.assertEqual(supervisor.rust_object_api(nested), [("R", [], [("i32", "get", [])])])
        self.assertEqual(supervisor.rust_signatures(
            "fn a(x: i32) -> i32 {\n    fn dedans(y: i32) -> i32 { y }\n    dedans(x)\n}\n"),
            [("i32", "a", ["i32"])])
        self.assertEqual(supervisor.rust_mut_receivers(
            "struct R { v: i32 }\nimpl R { fn inc(&mut self) -> i32 { self.v += 1; self.v } }\n"),
            {"R"})

    def test_rust_server_lives_in_its_own_module(self):
        # Un module enfant ne voit aucun nom du parent sans le nommer : une `const id`, un
        # `static args`, un `type Result<T>` ou une `struct Vec` soumis ne peuvent plus prendre
        # la place d'un nom du serveur.
        obj_list = [("Rect", [("new", ["i32"])], [("i32", "aire", [])])]
        server = supervisor.rust_server_source([("i32", "f", ["i32"])], "const id: i32 = 1;\n",
                                               obj_list)
        head, module = server.split("\nmod moodit_srv {\n", 1)
        self.assertIn("const id: i32 = 1;", head)
        self.assertNotIn("fn moodit_", head)
        body, tail = module.rsplit("\n}\n\nfn main() {\n", 1)
        self.assertEqual(tail, "    moodit_srv::moodit_serve();\n}\n")
        self.assertIn("pub fn moodit_serve() {", body)
        # Tout ce qui vient du code soumis est atteint par un chemin absolu.
        self.assertIn("crate::f(a0)", body)
        self.assertIn("Vec<crate::Rect>", body)
        self.assertIn("crate::Rect::new(a0)", body)
        self.assertIsNone(re.search(r"(?<!crate::)\bRect\b(?!\")", body.replace("|Rect", "")))

    def test_go_package_names_cover_every_kind_of_declaration(self):
        src = ("package main\n\nvar string = 3\nconst (\n\ttrue = 1\n\tautre, len = 2, 3\n)\n"
               "type nil struct{}\nfunc int(xs []int) int { return 0 }\n"
               "func (r nil) panic() int { return 0 }\nvar (\n\tx int\n)\n")
        self.assertEqual(supervisor.go_package_names(src),
                         ["string", "nil", "int", "true", "autre", "len", "x"])
        # Une MÉTHODE n'est pas un nom de paquet : `panic` ne masque rien.
        self.assertEqual(supervisor.go_server_hidden(src), ["string", "nil", "int", "true", "len"])
        self.assertEqual(supervisor.go_server_hidden("package main\n\nvar max = 3\n"), [])

    def test_c_server_includes_no_header_and_names_only_its_own_identifiers(self):
        # Compilé APRÈS le code soumis, dans la même unité : tout en-tête y déclarait des
        # centaines de noms que l'étudiant a le droit de porter (une fonction d'aide `index`,
        # `remove`, `div`, `rand`, `exit`…, une macro `abs(x)`), et sa réponse ne compilait plus.
        keywords = set("""static extern const char int long double void if else return while for
            sizeof new ifdef endif __asm__ __SIZE_TYPE__ __cplusplus define undef main C
            template class constexpr __is_constructible
            __moodit_student_main""".split())
        cases = (
            (False, [("int", "f", ["int", "long", "double"])], ()),
            (True, [("double", "f", ["double"])], [("Rect", [["int"]], [("int", "aire", ["int"])])]),
        )
        for cpp, methods, obj_list in cases:
            server = supervisor.c_server_source(methods, "", cpp=cpp, obj_list=obj_list)
            self.assertNotIn("#include", server)
            # Hors chaînes, littéraux de caractère et commentaires.
            code = re.sub(r'"(?:[^"\\]|\\.)*"' + r"|'(?:[^'\\]|\\.)*'" + r"|/\*.*?\*/", " ",
                          server, flags=re.S)
            foreign = {w for w in re.findall(r"[A-Za-z_]\w*", code)
                       if not w.startswith("moodit_") and w not in keywords
                       and w not in ("f", "Rect", "aire")}
            self.assertEqual(foreign, set(), "noms hors du serveur : %s" % sorted(foreign))

    def test_c_symbols_defined_in_binary_keeps_only_bare_names(self):
        # Sortie réelle de `nm --defined-only` dans l'image : la copie de relocalisation d'un
        # symbole de la libc porte sa version, une surcharge C++ est décorée.
        clean = ("0000000000404050 B stdin@GLIBC_2.2.5\n0000000000404040 B stdout@GLIBC_2.2.5\n"
                 "00000000004011d6 T _Z4freeP1N\n0000000000401136 T doubler\n"
                 "0000000000401196 t moodit_jeton\n")
        self.assertEqual(supervisor.c_symbols_defined_in_binary(clean), [])
        self.assertEqual(supervisor.c_symbols_defined_in_binary(
            clean + "00000000004011b6 T printf\n0000000000404060 B stdout\n"
                    "00000000004011c6 t malloc\n00000000004011d6 T free\n"),
            ["printf", "malloc", "free", "stdout"])
        self.assertEqual(supervisor.c_symbols_defined_in_binary(""), [])
        self.assertEqual(supervisor.c_symbols_defined_in_binary(None), [])

    def test_c_versioned_function_is_a_submitted_definition_versioned_data_is_not(self):
        # Une DONNÉE versionnée est la copie de relocalisation d'un symbole de la libc ; une
        # FONCTION versionnée ne peut venir que du code soumis (`.symver mon_free,free@@GLIBC…`).
        self.assertEqual(supervisor.c_symbols_defined_in_binary(
            "0000000000404050 B stdin@GLIBC_2.2.5\n0000000000404040 B stdout@GLIBC_2.2.5\n"), [])
        self.assertEqual(supervisor.c_symbols_defined_in_binary(
            "0000000000401126 T free@@GLIBC_2.2.5\n0000000000401136 t printf@GLIBC_2.2.5\n"
            "0000000000404040 B stdout@GLIBC_2.2.5\n"), ["printf", "free"])
        # Texte ou lignes, avec ou sans fin de ligne.
        self.assertEqual(supervisor.c_symbols_defined_in_binary(
            ["0000000000401126 T malloc\n", "\n", "U\n"]), ["malloc"])

    def test_c_nm_output_is_read_whole_not_head_and_tail(self):
        # Au-delà du plafond, read_capped ne rend que la tête et la queue : une coupure au milieu
        # de `liste_free` fabriquait le nom `free` (réponse honnête refusée), et une vraie
        # redéfinition placée au milieu n'était plus vue.
        cap = supervisor.OUTPUT_CAP
        line = "0000000000401126 T %s\n"
        padding = "".join(line % ("a_%06d" % i) for i in range(cap // 20))
        filler = "".join(line % ("z_%06d" % i) for i in range(cap // 20))
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "nm.out")
            # 1. Coupure fabriquée : la tête de read_capped (cap // 2 octets) s'arrête sur `free`,
            #    au milieu de `free_liste`.
            cut = "0000000000401126 T free"
            room = cap // 2 - len(cut)
            whole = room // len(line % "a_000000") - 1
            head = padding[:whole * len(line % "a_000000")]
            head += line % ("p" * (room - len(head) - len(line % "")))
            self.assertEqual(len(head + cut), cap // 2)
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(head + cut + "_liste\n" + filler + filler)
            self.assertGreater(os.path.getsize(path), cap)
            self.assertEqual(supervisor.c_symbols_defined_in_binary(
                supervisor.read_capped(path)), ["free"])          # le défaut d'origine
            self.assertEqual(supervisor.c_binary_linked_symbols(0, False, path), [])
            # 2. Redéfinition au milieu : invisible par tête + queue, vue en entier.
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(padding + line % "free" + filler)
            self.assertEqual(supervisor.c_symbols_defined_in_binary(
                supervisor.read_capped(path)), [])                # le défaut d'origine
            self.assertEqual(supervisor.c_binary_linked_symbols(0, False, path), ["free"])

    def test_c_failed_nm_refuses_nothing(self):
        # nm en échec, expiré ou sans sortie lisible : pas de refus. Ce n'est qu'un diagnostic.
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "nm.out")
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write("0000000000401126 T free\n")
            self.assertEqual(supervisor.c_binary_linked_symbols(0, False, path), ["free"])
            self.assertEqual(supervisor.c_binary_linked_symbols(1, False, path), [])
            self.assertEqual(supervisor.c_binary_linked_symbols(-9, False, path), [])
            self.assertEqual(supervisor.c_binary_linked_symbols(0, True, path), [])
            self.assertEqual(supervisor.c_binary_linked_symbols(
                0, False, os.path.join(d, "absent")), [])
            self.assertEqual(supervisor.c_binary_linked_symbols(0, False, d), [])

    def test_cpp_object_dispatch_locals_are_prefixed(self):
        _, branches = supervisor.cpp_object_dispatch([("Rect", [["int"]], [("int", "aire", [])])])
        self.assertIn("int moodit_h = moodit_lit_int(moodit_jeton());", branches)
        self.assertIn("moodit_objets_Rect[moodit_h]->aire()", branches)
        self.assertIn("moodit_cree< ::Rect >(moodit_a0)", branches)
        self.assertIsNone(re.search(r"(?<![\w\"|])(id|op|nom|h|a0)(?![\w(\"])", branches))


class SqliteExecTest(unittest.TestCase):
    """Revue #246 : le programme SQL porte les sentinelles au nonce, et le code soumis tourne
    dans le meme processus sqlite3. Mode -safe, et programme livre par stdin (root l'ouvre)."""

    def test_sqlite_runs_in_safe_mode_and_reads_its_program_from_stdin(self):
        compile_cmd, run_cmd = supervisor.exec_commands("sqlite3", "main.sql")
        self.assertIsNone(compile_cmd)
        self.assertEqual(run_cmd, ["sqlite3", "-safe", "-bail", "-batch", ":memory:"])
        # Le fichier n'est plus ouvert par le processus lui-meme (redirection d'un sh).
        self.assertNotIn("main.sql", " ".join(run_cmd))


class Review246ExtractionTest(unittest.TestCase):
    """Revue #246 : extraction bornee en temps (C++, Go, C#), espace de noms C++ nomme, et
    processus soumis designe a l'OOM avant le superviseur."""

    NL = chr(10)

    def test_extraction_stays_linear_on_hostile_sources(self):
        # Chaque entree tenait le superviseur de 12 s a plus de 5 min PAR CAS, avant toute
        # compilation et hors de tout delai (conteneur tue au mur, 502, tentative supprimee).
        # Lineaire, chacune repond en une fraction de seconde ; le seuil laisse une marge large.
        NL = self.NL
        cases = [
            ("template C++", lambda s: supervisor.cpp_object_api(s),
             "template<" * 3000 + NL + ("class K : B" + NL) * 6000),
            ("template C++ ferme", lambda s: supervisor.cpp_object_api(s),
             "template<T>" * 4000 + NL + ("class K : B" + NL) * 4000),
            ("classes C++ vides", lambda s: (supervisor.cpp_object_api(s),
                                             supervisor.c_signatures(s, cpp=True)),
             "".join("class K%d {};%sint f%d(int a) { return a; }%s" % (i, NL, i, NL)
                     for i in range(4000))),
            ("espaces de noms C++", lambda s: supervisor.c_signatures(s, cpp=True),
             ("namespace a {" + NL) * 8000),
            ("groupes Go jamais fermes", supervisor.go_package_names, ("var (" + NL) * 16000),
            ("groupes Go fermes", supervisor.go_package_names,
             ("var (" + NL + "a = 1" + NL + ")" + NL) * 8000),
            ("classes C# vides", supervisor.cs_has_object_api,
             "".join("class C%d { }%s" % (i, NL) for i in range(8000))),
            ("classes C# homonymes imbriquees",
             lambda s: (supervisor.cs_has_object_api(s), supervisor.cs_object_api(s, "X")),
             "class X {" * 10000),
            ("en-tetes C# sans corps", supervisor.cs_has_object_api, "class a " * 12000),
            # L'ancre de debut de ligne et une repetition de modificateurs sans borne : chaque
            # ligne relisait toutes les suivantes.
            ("lignes C# d'un seul modificateur",
             lambda s: (supervisor.cs_signatures(s), supervisor.cs_object_api(s, "X")),
             ("static" + NL) * 14000),
            ("lignes C# `new`", lambda s: supervisor.cs_object_api("class X {" + NL + s, "X"),
             ("new" + NL) * 14000),
            # Chaque apostrophe remontait jusqu'au debut de son jeton : quatre minutes a 100 Ko.
            ("separateurs de chiffres en chaine", supervisor.blank_code,
             "int x = 1" + "'a" * 50000 + ";"),
            # Chaque `impl` ouvert couvre tout le reste du fichier : redecoupe et relu a chaque
            # bloc, 20 Ko prenaient plus d'une minute. 100 Ko, le plafond d'une soumission.
            ("impl Rust jamais fermes",
             lambda s: (supervisor.rust_object_api(s), supervisor.rust_capture_fields(s)),
             "struct A;" + NL + ("impl A {" + NL) * 11000),
            ("impl Rust imbriques avec methodes",
             lambda s: (supervisor.rust_object_api(s), supervisor.rust_capture_fields(s)),
             "struct A;" + NL + ("impl A {" + NL + "fn f(&mut self) -> i32 {" + NL) * 3000),
        ]
        slow = []
        for label, analysis, src_text in cases:
            begin = time.perf_counter()
            analysis(src_text)
            if time.perf_counter() - begin > 5.0:
                slow.append(label)
        self.assertEqual(slow, [])

    def test_cpp_template_head_only_right_before_the_class(self):
        NL = self.NL
        plain = NL.join(["class R {", "public:", "    R(int a) { }",
                         "    int f() { return 1; }", "};", ""])
        self.assertEqual([c[0] for c in supervisor.cpp_object_api(plain)], ["R"])
        # Sur la ligne precedente, sur plusieurs lignes, ou apres une directive sans `;`.
        for head in ("template <typename T>" + NL,
                     "template <typename T," + NL + "          typename U>" + NL + NL,
                     "#include <vector>" + NL + "template<class T> "+ NL):
            self.assertEqual(supervisor.cpp_object_api(head + plain), [], head)
        # Un template TERMINE avant la classe (fonction, alias) ne la concerne pas, ni un `>`
        # sans `template` depuis la derniere instruction.
        for before in ("template <typename T> T ident(T x) { return x; }" + NL,
                       "template <typename T> using V = T;" + NL,
                       "#include <vector>" + NL):
            self.assertEqual([c[0] for c in supervisor.cpp_object_api(before + plain)],
                             ["R"], before)

    def test_cpp_named_namespace_members_are_not_proxied(self):
        NL = self.NL
        src = NL.join(["namespace util {", "int carre(int x) { return x * x; }",
                       "class Aide {", "public:", "    Aide() { }",
                       "    int f() { return 1; }", "};", "}",
                       "namespace a::b {", "int profond(int x) { return x; }", "}",
                       "namespace {", "int cache(int x) { return x; }", "}",
                       "using namespace std;",
                       "int somme_carres(int a, int b) { return util::carre(a) + util::carre(b); }",
                       "class Rect {", "public:", "    Rect(int c) { }",
                       "    int aire() { return 1; }", "};", ""])
        # `::carre` et `::Aide` n'existent pas : le serveur genere ne compilait plus, sur une
        # reponse juste. L'espace ANONYME, lui, reste atteint par `::cache`.
        self.assertEqual([m[1] for m in supervisor.c_signatures(src, cpp=True)],
                         ["cache", "somme_carres"])
        self.assertEqual([c[0] for c in supervisor.cpp_object_api(src)], ["Rect"])
        server = supervisor.c_server_source(supervisor.c_signatures(src, cpp=True), "", cpp=True)
        self.assertNotIn("carre(moodit_a0)", server.replace("somme_carres(", ""))
        # En C, `namespace` n'est pas un mot du langage : rien n'est ecarte.
        self.assertEqual([m[1] for m in supervisor.c_signatures(src, cpp=False)],
                         ["carre", "f", "profond", "cache", "somme_carres", "aire"])

    def test_covered_is_strict_and_handles_nesting(self):
        cover = supervisor.span_cover([(10, 50), (20, 30), (60, 70)])
        self.assertEqual([p for p in (5, 10, 11, 25, 40, 50, 55, 60, 65, 70, 80)
                          if supervisor.covered(cover, p)], [11, 25, 40, 65])
        self.assertFalse(supervisor.covered(supervisor.span_cover([]), 3))

    def test_go_group_bodies(self):
        NL = self.NL
        src = NL.join(["var (", "    a = 1", "    b, c int", ")", "const (", "", "    Pi = 3", ")",
                       "type (", "    T int", ")", "func f() {", "    var (", "        x = 1",
                       "    )", "}", ""])
        self.assertEqual(supervisor.go_package_names(src),
                         ["f", "a", "b", "c", "Pi", "T"])
        # Groupe jamais ferme : rien n'en sort, et rien ne leve.
        self.assertEqual(supervisor.go_group_bodies("var (" + NL + "a = 1" + NL), [])
        self.assertEqual(supervisor.go_group_bodies(None), [])

    def test_cs_object_classes(self):
        NL = self.NL
        nested = NL.join(["namespace Quiz {", "    class Aide { }", "    class Rect;",
                          "    class Carre {",
                          "        class Interne { public int G() { return 1; } }",
                          "        public Carre(int c) { }", "    }",
                          "    class Rect {", "        int l;",
                          "        public Rect(int l) { this.l = l; }",
                          "        public double Aire() { return l; }",
                          "        public int Cote() { return l; }", "    }", "}",
                          "class Pile<T> { public int Taille() { return 0; } }", ""])
        expected = [
            ("class Solution { static void Main() { } }", []),
            ("class Rect { public int Aire() { return 1; } }", ["Rect"]),
            ("class Rect { public Rect(int c) { } public int Aire() { return 1; } }", ["Rect"]),
            # Constructeur aux types non transportables : pas d'API objet.
            ("class Rect { public Rect(int[] c) { } public int Aire() { return 1; } }", []),
            # Seulement une statique, ou seulement Main.
            ("class S { public static int F(int n) { return n; } }", []),
            ("class S { public int Main() { return 0; } }", []),
            # Aide et Carre n'ont aucune methode a elles (G est a Interne, imbriquee) ; la
            # declaration anticipee `class Rect;` ne prend pas le corps de Carre.
            (nested, ["Rect"]),
        ]
        for src, classes in expected:
            self.assertEqual(supervisor.cs_object_classes(src), classes, src)
            self.assertEqual(supervisor.cs_has_object_api(src), bool(classes), src)
            # Meme reponse que cs_object_api, classe par classe.
            for ident in supervisor.cs_top_level_classes(src):
                ctors, instance = supervisor.cs_object_api(src, ident)
                self.assertEqual(bool(ctors and instance), ident in classes, (src, ident))
        # Membres DIRECTS seulement, dans l'ordre du texte ; le resultat memoise n'est pas
        # expose (une liste de types modifiee par l'appelant ne change pas l'appel suivant).
        self.assertEqual(supervisor.cs_object_api(nested, "Rect"),
                         ([["int"]], [("double", "Aire", []), ("int", "Cote", [])]))
        self.assertEqual(supervisor.cs_object_api(nested, "Carre"), ([["int"]], []))
        self.assertEqual(supervisor.cs_object_api(nested, "Interne")[1], [("int", "G", [])])
        supervisor.cs_object_api(nested, "Rect")[1][0][2].append("int")
        self.assertEqual(supervisor.cs_object_api(nested, "Rect")[1][0], ("double", "Aire", []))
        self.assertEqual(supervisor.cs_object_classes(None), [])

    @unittest.skipUnless(os.path.exists("/proc/self/oom_score_adj"), "Linux ; couvert en CI")
    def test_student_process_is_the_oom_victim(self):
        r = subprocess.run(["cat", "/proc/self/oom_score_adj"], capture_output=True, text=True,
                           preexec_fn=supervisor.mark_oom_victim)
        self.assertEqual(r.stdout.strip(), "1000")


def run_bpf(program, arch, nr, arg1):
    """Interprète le sous-ensemble BPF du filtre étudiant (ld abs, jeq k, ret k)."""
    data = {0: nr & 0xFFFFFFFF, 4: arch, 24: arg1 & 0xFFFFFFFF}
    acc, pc = 0, 0
    while True:
        code, jt, jf, k = program[pc]
        if code == 0x20:
            acc = data[k]
            pc += 1
        elif code == 0x15:
            pc += 1 + (jt if acc == k else jf)
        elif code == 0x06:
            return k
        else:
            raise AssertionError("instruction inattendue %r" % (program[pc],))


class OomAndLockIsolationTest(unittest.TestCase):
    """Le superviseur (PID 1) est à -1000 : CHAQUE processus qu'il lance doit remonter son
    oom_score_adj, sans quoi il hériterait d'un -1000 intuable ; et les processus de l'UID
    étudiant ne posent aucun verrou d'enregistrement (mémoire noyau que le cgroup ne compte pas)."""

    def launch_calls(self, preexec):
        """Appels de mark_oom_victim / install_student_filter faits par un preexec_fn, sans rien
        changer au processus de test (setuid, setsid… et rlimits remplacés)."""
        marks, locks = [], []
        # create=True : setsid, setuid… n'existent pas sous Windows, où ces tests tournent aussi.
        with unittest.mock.patch.multiple(
                supervisor.os, create=True, setsid=unittest.mock.DEFAULT,
                setgroups=unittest.mock.DEFAULT,
                setgid=unittest.mock.DEFAULT, setuid=unittest.mock.DEFAULT,
                umask=unittest.mock.DEFAULT), \
                unittest.mock.patch.object(supervisor, "resource", unittest.mock.Mock()), \
                unittest.mock.patch.object(supervisor, "mark_oom_victim",
                                           lambda *a: marks.append(a)), \
                unittest.mock.patch.object(supervisor, "install_student_filter",
                                           lambda: locks.append(True)):
            preexec()
        return marks, locks

    def test_every_launch_raises_its_oom_score(self):
        # Le code soumis (exécution, compilation) est la PREMIÈRE victime ; le noteur et les
        # compilations root passent après lui. Aucun ne garde le -1000 du superviseur.
        self.assertEqual(self.launch_calls(supervisor.demote_student)[0], [()])
        self.assertEqual(self.launch_calls(supervisor.preexec_student_compile)[0], [()])
        self.assertEqual(self.launch_calls(supervisor.demote_grader)[0],
                         [(supervisor.OOM_ADJ_TRUSTED,)])
        self.assertEqual(self.launch_calls(supervisor.preexec_compile)[0],
                         [(supervisor.OOM_ADJ_TRUSTED,)])
        self.assertEqual(supervisor.OOM_ADJ_SUBMITTED, 1000)
        self.assertGreater(supervisor.OOM_ADJ_SUBMITTED, supervisor.OOM_ADJ_TRUSTED)
        self.assertGreater(supervisor.OOM_ADJ_TRUSTED, 0)

    def test_launch_wrapper_raises_first_then_lets_the_preexec_choose(self):
        calls = []
        with unittest.mock.patch.object(supervisor, "mark_oom_victim",
                                        lambda *a: calls.append(("mark",) + a)):
            supervisor.oom_victim_first(None)()
            supervisor.oom_victim_first(lambda: calls.append(("preexec",)))()
        self.assertEqual(calls, [("mark",), ("mark",), ("preexec",)])

    @unittest.skipUnless(os.name == "posix", "O_NOFOLLOW : POSIX ; couvert en CI")
    def test_run_proc_and_run_pair_always_wrap_their_preexec(self):
        # Garde contre un lancement FUTUR : même sans preexec, le processus quitte le -1000.
        captured = []

        def fake_popen(*args, **kwargs):
            captured.append(kwargs["preexec_fn"])
            raise OSError("lancement simulé")

        marks = []
        with tempfile.TemporaryDirectory() as d, \
                unittest.mock.patch.object(supervisor.subprocess, "Popen", fake_popen), \
                unittest.mock.patch.object(supervisor, "event", lambda *a, **k: None), \
                unittest.mock.patch.object(supervisor, "EXIT_STATE", supervisor.ExitState()), \
                unittest.mock.patch.object(supervisor, "demote_grader", lambda: None), \
                unittest.mock.patch.object(supervisor, "demote_student", lambda: None):
            supervisor.run_proc(["true"], d, {}, 1, os.path.join(d, "o"), os.path.join(d, "e"),
                                None)
            supervisor.run_pair(["g"], ["s"], d, {}, {}, 1, os.path.join(d, "ge"),
                                os.path.join(d, "se"))
        self.assertEqual(len(captured), 2)
        with unittest.mock.patch.object(supervisor, "mark_oom_victim",
                                        lambda *a: marks.append(a)):
            for preexec in captured:
                preexec()
        self.assertEqual(marks, [(), ()])

    def test_only_student_uid_processes_get_the_lock_filter(self):
        self.assertEqual(self.launch_calls(supervisor.demote_student)[1], [True])
        self.assertEqual(self.launch_calls(supervisor.preexec_student_compile)[1], [True])
        self.assertEqual(self.launch_calls(supervisor.demote_grader)[1], [])
        self.assertEqual(self.launch_calls(supervisor.preexec_compile)[1], [])

    @unittest.skipUnless(os.path.exists("/proc/self/oom_score_adj"), "Linux ; couvert en CI")
    def test_trusted_processes_are_second_victims(self):
        r = subprocess.run(["cat", "/proc/self/oom_score_adj"], capture_output=True, text=True,
                           preexec_fn=lambda: supervisor.mark_oom_victim(
                               supervisor.OOM_ADJ_TRUSTED))
        self.assertEqual(r.stdout.strip(), "500")

    def test_student_filter_denies_record_locks_and_aio_on_every_abi(self):
        program = supervisor.student_filter_program()
        deny = supervisor.SECCOMP_RET_ERRNO | 37
        nosys = supervisor.SECCOMP_RET_ERRNO | 38
        allow = supervisor.SECCOMP_RET_ALLOW
        for at, (code, jt, jf, k) in enumerate(program):
            # BPF n'accepte que des sauts EN AVANT et dans le programme.
            self.assertLess(at + 1 + max(jt, jf), len(program) + (1 if code == 0x06 else 0))
        x86_64, aarch64, i386, arm = 0xC000003E, 0xC00000B7, 0x40000003, 0x40000028
        cases = [
            (x86_64, 72, 6, deny), (x86_64, 72, 7, deny), (x86_64, 72, 37, deny),
            (x86_64, 72, 38, deny),
            (x86_64, 72, 6 + (1 << 32), deny),        # le noyau lit le mot de poids faible
            (x86_64, 0x40000000 | 72, 6, deny),       # x32
            (x86_64, 72, 5, allow), (x86_64, 72, 36, allow), (x86_64, 72, 3, allow),
            (x86_64, 73, 6, allow),                   # flock : permis
            (x86_64, 0, 6, allow),                    # autre appel, même argument
            (x86_64, 72, 13, allow),                  # F_SETLK64 n'existe pas en 64 bits
            (aarch64, 25, 6, deny), (aarch64, 25, 38, deny), (aarch64, 72, 6, allow),
            (i386, 221, 13, deny), (i386, 221, 14, deny), (i386, 55, 6, deny),
            (i386, 221, 37, deny), (i386, 221, 3, allow),
            (arm, 221, 13, deny), (arm, 55, 7, deny), (arm, 25, 6, allow),
            (0x12345678, 72, 6, allow),               # architecture inconnue : Docker décide
            # io_setup : refusé quel que soit l'argument, sur chaque ABI.
            (x86_64, 206, 0, nosys), (x86_64, 0x40000000 | 543, 0, nosys),
            (aarch64, 0, 0, nosys), (i386, 245, 0, nosys), (arm, 243, 0, nosys),
            (x86_64, 207, 0, allow), (x86_64, 209, 0, allow),   # io_destroy, io_submit : sans contexte
            (aarch64, 1, 0, allow), (i386, 243, 0, allow),       # 243 n'est io_setup qu'en arm
        ]
        for arch, nr, cmd, expected in cases:
            self.assertEqual(run_bpf(program, arch, nr, cmd), expected, (hex(arch), nr, cmd))

    @unittest.skipUnless(sys.platform.startswith("linux"), "seccomp : Linux ; couvert en CI")
    def test_student_filter_really_refuses_record_locks_and_aio(self):
        import fcntl
        with tempfile.TemporaryDirectory() as d:
            target = os.path.join(d, "verrou")
            pid = os.fork()
            if pid == 0:   # pragma: no cover — processus fils
                status = 1
                try:
                    supervisor.install_student_filter()
                    fd = os.open(target, os.O_RDWR | os.O_CREAT, 0o600)
                    try:
                        fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        status = 2          # verrou posé : le filtre ne tient pas
                    except OSError as e:
                        if e.errno == 37:
                            fcntl.flock(fd, fcntl.LOCK_EX)   # flock reste permis
                            status = 0
                    # io_setup (206 sur x86_64, 0 sur aarch64) : ENOSYS.
                    import ctypes
                    import platform
                    libc = ctypes.CDLL(None, use_errno=True)
                    context = ctypes.c_ulong(0)
                    number = {"x86_64": 206, "aarch64": 0}.get(platform.machine())
                    if number is not None and status == 0:
                        refused = libc.syscall(number, 1, ctypes.byref(context)) == -1
                        status = 0 if refused and ctypes.get_errno() == 38 else 3
                finally:
                    os._exit(status)
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)

    def test_code_depths_is_linear(self):
        # Chaque `r` tentait une chaîne brute sur une COPIE du reste du texte : quadratique, 6 s
        # pour 100 000 caractères de code soumis, refaites à chaque cas. Mesuré par un RAPPORT
        # (growth_ratio, indépendant de la vitesse et de la charge de la machine). 32 × 10 000 :
        # sous 16 boucles CPU, l'ancien code (0d975e01^) donnait 19,1 ; il ne donnait que 4,9 à
        # 32 × 5 000, 7,7 à 32 × 8 000 et ~5 à 9 × 22 000, trop près du seuil. Code actuel 0,5
        # à 1,1.
        ratio = growth_ratio(supervisor.code_depths,
                             lambda size: ("r" * size + "{" + "R" * size,), 10_000, 320_000)
        self.assertLess(ratio, 4, "code_depths n'est plus linéaire (rapport %.1f)" % ratio)
        depths = supervisor.code_depths("r" * 50_000 + "{" + "R" * 50_000)
        self.assertEqual((depths[49_999], depths[50_000], depths[-1]), (0, 0, 1))
        # L'accolade DANS la chaîne brute ne compte pas ; celle d'après, si.
        self.assertEqual(supervisor.code_depths('r#"{"# {x}'), [0] * 8 + [1, 0])
        self.assertEqual(supervisor.code_depths('R"({)" {x}'), [0] * 8 + [1, 0])

    def test_student_uid_range_keeps_both_uids_under_2_31(self):
        low, high = supervisor.STUDENT_UID_RANGE
        self.assertGreaterEqual(low, 1 << 24)          # au-dessus des sous-UID usuels
        self.assertLess(high - 1 + 1, 1 << 31)          # dernier UID étudiant + 1 (noteur)
        self.assertGreater(high - low, 10 ** 9)         # collision entre conteneurs ~ 10⁻⁸



class StudentBuildMemoTest(unittest.TestCase):
    """La compilation du code soumis n'est faite qu'UNE fois par job (capacité)."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.saved_state = supervisor.EXIT_STATE
        supervisor.STUDENT_BUILDS.clear()
        supervisor.EVENTS.clear()
        # Artefacts gardés sous le dossier du test ; chown remplacé (non-root, ou Windows).
        self.owners = []
        record = lambda target, uid, gid: self.owners.append((uid, gid))
        self.patches = [
            unittest.mock.patch.object(supervisor, "STUDENT_BUILD_CACHE",
                                       os.path.join(self.root, "etu_compilations")),
            unittest.mock.patch.object(supervisor.os, "fchown", record, create=True),
            unittest.mock.patch.object(supervisor.os, "chown", record, create=True),
            unittest.mock.patch.object(supervisor.os, "fchmod", lambda fd, mode: None,
                                       create=True)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        supervisor.EXIT_STATE = self.saved_state
        supervisor.STUDENT_BUILDS.clear()
        supervisor.EVENTS.clear()
        shutil.rmtree(self.root, ignore_errors=True)

    def reset(self):
        supervisor.STUDENT_BUILDS.clear()
        supervisor.EVENTS.clear()
        shutil.rmtree(os.path.join(self.root, "cases"), ignore_errors=True)
        shutil.rmtree(supervisor.STUDENT_BUILD_CACHE, ignore_errors=True)

    def case(self, index, source="fn doubler() {}"):
        """Dossier d'un cas avec sa source étudiante ; rend (dossier, source, sorties)."""
        case_dir = os.path.join(self.root, "cases", str(index))
        os.makedirs(os.path.join(case_dir, "etu_build", "classes"), exist_ok=True)
        path = os.path.join(case_dir, "etu_build", "etu.rs")
        with open(path, "w", encoding="utf-8") as f:
            f.write(source)
        supervisor.EXIT_STATE = supervisor.ExitState(index)
        return case_dir, path, (os.path.join(case_dir, "cc.out"), os.path.join(case_dir, "cc.err"))

    @staticmethod
    def artifact(case_dir, as_dir=False):
        return os.path.join(case_dir, "etu_build", "classes" if as_dir else "etu_bin")

    def compile(self, case_dir, path, outputs, as_dir=False):
        cmd = ["rustc", path, "-o", self.artifact(case_dir, as_dir)]
        env = {"HOME": os.path.join(case_dir, "etu_build", "home"), "LANG": "C.UTF-8"}
        return supervisor.compile_student(cmd, os.path.join(case_dir, "etu_build"), env,
                                          case_dir, [path], *outputs,
                                          self.artifact(case_dir, as_dir))

    def fake_run(self, result, err_text="erreur: inconnue", lost=False, products=None):
        """run_proc simulé. `products` : {chemin relatif à l'artefact: octets} écrits si réussite
        (clé "" = l'artefact est un fichier)."""
        calls = []

        def run(cmd, cwd, env, timeout_s, out_path, err_path, preexec, stdin_path=None):
            calls.append(cmd)
            with open(err_path, "w", encoding="utf-8") as f:
                f.write(err_text)
            with open(out_path, "w", encoding="utf-8") as f:
                f.write("sortie standard")
            for rel, data in (products or {}).items():
                target = os.path.join(cmd[-1], rel) if rel else cmd[-1]
                with open(target, "wb") as f:
                    f.write(data)
            if lost:
                supervisor.EXIT_STATE.lost = True
            return result
        return calls, run

    def test_key_ignores_the_case_directory_only(self):
        first, path_1, _ = self.case(1)
        second, path_2, _ = self.case(10)
        third, path_3, _ = self.case(2, "fn doubler() { autre }")

        def key(case_dir, path, cmd_extra=(), cwd=None):
            return supervisor.student_build_key(
                ["rustc", path] + list(cmd_extra), cwd or os.path.join(case_dir, "etu_build"),
                {"HOME": os.path.join(case_dir, "home")}, [path], case_dir)
        self.assertEqual(key(first, path_1), key(second, path_2))     # /cases/1 vs /cases/10
        # Dossier de travail = le dossier du cas lui-même (javac) : neutralisé aussi.
        self.assertEqual(key(first, path_1, cwd=first), key(second, path_2, cwd=second))
        self.assertNotEqual(key(first, path_1), key(third, path_3))   # autres octets
        self.assertNotEqual(key(first, path_1), key(first, path_1, ["-O"]))

    def test_compiler_failure_is_replayed_from_the_second_case(self):
        calls, run = self.fake_run((1, False))
        with unittest.mock.patch.object(supervisor, "run_proc", run):
            self.assertEqual(self.compile(*self.case(1)), (1, False))
            second = self.case(2)
            self.assertEqual(self.compile(*second), (1, False))
        self.assertEqual(len(calls), 1)                               # une seule compilation
        self.assertEqual(supervisor.read_capped(second[2][1]), "erreur: inconnue")
        self.assertEqual(supervisor.read_capped(second[2][0]), "sortie standard")
        self.assertFalse(supervisor.EXIT_STATE.expired or supervisor.EXIT_STATE.killed_by_signal)
        self.assertEqual([e["type"] for e in supervisor.EVENTS], ["echec_compilation_rejoue"])

    def test_inconclusive_failure_is_replayed_once_seen_twice(self):
        # Délai dépassé ou compilateur tué : peut venir de l'hôte (machine chargée, cache Go
        # froid). Le 2e cas recompile ; le 3e rejoue, avec la même cause non concluante.
        for result, killed in (((None, True), False), ((-9, False), True)):
            with self.subTest(result=result):
                self.reset()
                calls, run = self.fake_run(result)
                with unittest.mock.patch.object(supervisor, "run_proc", run):
                    for index in (1, 2, 3):
                        self.assertEqual(self.compile(*self.case(index)), result)
                self.assertEqual(len(calls), 2)
                state = supervisor.EXIT_STATE                          # celle du 3e cas
                self.assertEqual(state.expired, result[1])
                self.assertEqual(state.killed_by_signal, killed)
                self.assertEqual([e["type"] for e in supervisor.EVENTS],
                                 ["echec_compilation_rejoue"])

    def test_worker_killed_under_a_surviving_driver_is_inconclusive(self):
        # gcc → cc1 et go build → compile : l'OOM tue le TRAVAILLEUR, le pilote survit et sort
        # en 1, comme pour un vrai diagnostic. Seul le compteur d'OOM du cgroup le dit (le stderr
        # est celui du code soumis, qui peut en imprimer la signature) : la compilation devient
        # non concluante — rejouée une fois constatée deux fois, cause marquée « tuée ».
        killed_stderr = "gcc: fatal error: Killed signal terminated program cc1\ncompilation terminated.\n"
        counter = iter(range(100))
        calls, run = self.fake_run((1, False), err_text=killed_stderr)
        with unittest.mock.patch.object(supervisor, "run_proc", run), \
                unittest.mock.patch.object(supervisor, "oom_kills", lambda: next(counter)):
            for index in (1, 2, 3):
                self.assertEqual(self.compile(*self.case(index)), (1, False))
                self.assertTrue(supervisor.EXIT_STATE.killed_by_signal)
        self.assertEqual(len(calls), 2)
        # La MÊME signature sans OOM du conteneur (forgée par le code soumis, cf. tool_killed) :
        # un échec ordinaire, concluant, rejoué dès le 2e cas.
        self.reset()
        calls, run = self.fake_run((1, False), err_text=killed_stderr)
        with unittest.mock.patch.object(supervisor, "run_proc", run), \
                unittest.mock.patch.object(supervisor, "oom_kills", lambda: 4):
            for index in (1, 2, 3):
                self.assertEqual(self.compile(*self.case(index)), (1, False))
                self.assertFalse(supervisor.EXIT_STATE.killed_by_signal)
        self.assertEqual(len(calls), 1)
        self.assertNotIn("tool_killed(", inspect.getsource(supervisor.compile_student))

    def test_success_is_replayed_by_copying_the_artifact(self):
        for as_dir, products in ((False, {"": b"\x7fELF binaire"}),
                                 (True, {"Solution.class": b"\xca\xfe1",
                                         "Solution$Rect.class": b"\xca\xfe2"})):
            with self.subTest(as_dir=as_dir):
                self.reset()
                self.owners.clear()
                calls, run = self.fake_run((0, False), err_text="avertissement", products=products)
                with unittest.mock.patch.object(supervisor, "run_proc", run):
                    self.assertEqual(self.compile(*self.case(1), as_dir=as_dir), (0, False))
                    second = self.case(2)
                    self.assertEqual(self.compile(*second, as_dir=as_dir), (0, False))
                self.assertEqual(len(calls), 1)
                for rel, data in products.items():
                    target = self.artifact(second[0], as_dir)
                    with open(os.path.join(target, rel) if rel else target, "rb") as f:
                        self.assertEqual(f.read(), data)
                # Rendu à l'étudiant, comme s'il venait de compiler.
                self.assertEqual(set(self.owners),
                                 {(supervisor.STUDENT_UID, supervisor.STUDENT_GID)})
                self.assertEqual(len(self.owners), len(products))
                self.assertEqual(supervisor.read_capped(second[2][1]), "avertissement")
                self.assertEqual([e["type"] for e in supervisor.EVENTS], ["compilation_rejouee"])

    def test_oversized_artifact_lost_output_and_new_source_compile_again(self):
        big = {"": b"x" * 64}
        for label, kwargs, source_2 in (
                ("trop gros", {"result": (0, False), "products": big}, None),
                ("sortie perdue", {"result": (1, False), "lost": True}, None),
                ("autre source", {"result": (1, False)}, "fn doubler() { 2 }")):
            with self.subTest(label), unittest.mock.patch.object(
                    supervisor, "STUDENT_ARTIFACT_CAP", 32):
                self.reset()
                calls, run = self.fake_run(**kwargs)
                with unittest.mock.patch.object(supervisor, "run_proc", run):
                    self.compile(*self.case(1))
                    self.compile(*(self.case(2, source_2) if source_2 else self.case(2)))
                self.assertEqual(len(calls), 2)
                self.assertEqual(supervisor.EVENTS, [])

    def test_artifact_with_too_many_files_is_not_kept(self):
        target = os.path.join(self.root, "classes")
        os.makedirs(target)
        for index in range(3):
            with open(os.path.join(target, "C%d.class" % index), "wb") as f:
                f.write(b"c")
        with unittest.mock.patch.object(supervisor, "STUDENT_ARTIFACT_MAX_FILES", 3):
            self.assertEqual(len(supervisor.artifact_files(target)), 3)
        with unittest.mock.patch.object(supervisor, "STUDENT_ARTIFACT_MAX_FILES", 2):
            self.assertIsNone(supervisor.artifact_files(target))

    def test_failure_after_a_known_success_keeps_the_success(self):
        # La restauration échoue (tmpfs plein), la recompilation aussi : pour des entrées
        # identiques, c'est l'environnement — les cas suivants rejouent toujours la réussite.
        outcomes = [(0, False), (1, False)]
        calls = []

        def run(cmd, cwd, env, timeout_s, out_path, err_path, preexec, stdin_path=None):
            calls.append(cmd)
            for path in (out_path, err_path):
                open(path, "w").close()
            result = outcomes[min(len(calls), len(outcomes)) - 1]
            if result == (0, False):
                with open(cmd[-1], "wb") as f:
                    f.write(b"binaire")
            return result
        restores = iter([False, True])
        with unittest.mock.patch.object(supervisor, "run_proc", run):
            self.compile(*self.case(1))
            with unittest.mock.patch.object(supervisor, "restore_artifact",
                                            lambda artifact, path: next(restores)):
                self.assertEqual(self.compile(*self.case(2)), (1, False))   # restauration ratée
                self.assertEqual(self.compile(*self.case(3)), (0, False))   # réussite rejouée
        self.assertEqual(len(calls), 2)

    @unittest.skipUnless(os.name == "posix", "liens symboliques : POSIX")
    def test_artifact_with_a_link_is_not_kept(self):
        target = os.path.join(self.root, "classes")
        os.makedirs(target)
        with open(os.path.join(target, "A.class"), "wb") as f:
            f.write(b"a")
        self.assertEqual(supervisor.artifact_files(target), ["A.class"])
        os.symlink("/etc/passwd", os.path.join(target, "B.class"))
        self.assertIsNone(supervisor.artifact_files(target))
        os.symlink("/etc/passwd", os.path.join(self.root, "lien"))
        self.assertIsNone(supervisor.artifact_files(os.path.join(self.root, "lien")))

    def test_every_compiled_runner_builds_student_code_through_the_memo(self):
        # Garde de structure (le cas d'intégration le prouve langage par langage) : un runner
        # qui lancerait la compilation étudiante directement par run_proc échapperait au rejeu.
        # En C/C++, preexec_student_compile ne sert plus qu'à nm, sur le binaire déjà compilé.
        import inspect
        for runner in (supervisor.run_java_rpc, supervisor.run_csharp_rpc, supervisor.run_rust_rpc,
                       supervisor.run_c_rpc, supervisor.run_go_rpc):
            with self.subTest(runner=runner.__name__):
                source = inspect.getsource(runner)
                self.assertIn("compile_student(", source)
                if runner is not supervisor.run_c_rpc:
                    self.assertNotIn("preexec_student_compile", source)


class SubmittedCodeStageTest(unittest.TestCase):
    """La ligne témoin sépare, pour execution-service, une mort du superviseur pendant sa propre
    mise en place (panne de plateforme, non comptée) d'une mort une fois le code soumis pris en
    charge (comptée « sans verdict »). Elle doit donc partir AVANT tout traitement du code soumis,
    et APRÈS les seules sorties d'erreur de plateforme."""

    def test_the_stage_line_goes_to_stderr_flushed(self):
        err = io.StringIO()
        with unittest.mock.patch.object(supervisor.sys, "stderr", err):
            supervisor.announce_submitted_code_stage()
        self.assertEqual(err.getvalue(), supervisor.SUBMITTED_CODE_STAGE + "\n")

    def assert_announced_between(self, function, platform_error, first_submitted_code_step):
        source = inspect.getsource(function)
        announce = source.index("announce_submitted_code_stage()")
        self.assertEqual(source.count("announce_submitted_code_stage()"), 1)
        self.assertLess(source.index(platform_error), announce)
        self.assertLess(announce, source.index(first_submitted_code_step))
        # Le filtre étudiant est sondé AVANT la ligne témoin : absent, c'est une panne de
        # plateforme (erreur JSON, « indisponible »), pas un code soumis noté 0.
        probe = source.index("student_filter_available()")
        self.assertLess(probe, announce)
        self.assertLess(probe, source.index("STUDENT_FILTER_UNAVAILABLE"))
        self.assertLess(source.index("STUDENT_FILTER_UNAVAILABLE"), announce)

    def test_filter_probe_fails_without_a_prepared_filter(self):
        with unittest.mock.patch.object(supervisor, "_STUDENT_FILTER", None):
            self.assertFalse(supervisor.student_filter_available())

    @unittest.skipUnless(hasattr(os, "fork") and sys.platform.startswith("linux"),
                         "fork + seccomp : Linux seulement")
    def test_filter_probe_reports_what_the_child_saw(self):
        # Filtre réel : il se pose (le fils sort en 0). prctl qui échoue : le fils sort en 1. Le
        # processus de test lui-même n'est jamais filtré, tout se passe dans le fils.
        self.assertTrue(supervisor.student_filter_available())
        failing = (lambda *a: -1, 0, None)
        with unittest.mock.patch.object(supervisor, "_STUDENT_FILTER", failing):
            self.assertFalse(supervisor.student_filter_available())
        raising = (unittest.mock.Mock(side_effect=OSError("refusé")), 0, None)
        with unittest.mock.patch.object(supervisor, "_STUDENT_FILTER", raising):
            self.assertFalse(supervisor.student_filter_available())

    def test_grading_mode_announces_after_setup_and_before_the_cases(self):
        self.assert_announced_between(supervisor.main, "langage non pris en charge",
                                      "substitute_placeholders(")
        source = inspect.getsource(supervisor.main)
        self.assertLess(source.index("announce_submitted_code_stage()"),
                        source.index("reset_go_student_dirs("))

    def test_exec_mode_announces_after_setup_and_before_running_anything(self):
        self.assert_announced_between(supervisor.exec_main, "runtime non pris en charge",
                                      "exec_env(")


def growth_ratio(function, prepare, small, large, rounds=3):
    """Coût de `function` sur une entrée de taille `large`, rapporté à celui de `large // small`
    appels sur des entrées de taille `small` (entrées préparées hors chronomètre). Les deux
    mesures durent à peu près autant et alternent : la charge de la machine les gonfle pareil
    (revue #246 — comparer 2 ms à 60 ms faisait monter le rapport sous charge, seul le grand
    échantillon étant préempté). Environ 1 en linéaire, `large // small` en quadratique."""
    repeats = large // small
    best_small = best_large = float("inf")
    for _ in range(rounds):
        inputs = [prepare(small) for _ in range(repeats)]
        started = time.perf_counter()
        for args in inputs:
            function(*args)
        best_small = min(best_small, time.perf_counter() - started)
        args = prepare(large)
        started = time.perf_counter()
        function(*args)
        best_large = min(best_large, time.perf_counter() - started)
    return best_large / best_small


class ExtractionBoundsTest(unittest.TestCase):
    """Revue #246 : l'extraction et la génération tournent dans le superviseur, à chaque cas,
    avant toute compilation et hors de tout délai — conteneur à 1 Go, superviseur à
    oom_score_adj -1000. Une forme du code soumis (≤ 100 000 caractères) qui y explose en temps
    ou en mémoire donnait un 502 « sans verdict » provoqué par l'étudiant. Les coûts sont mesurés
    par RAPPORT (growth_ratio : une entrée k fois plus grande contre k petites, k = 9 à 32 ;
    environ 1 en linéaire, jusqu'à k en quadratique), indépendamment de la vitesse et de la
    charge de la machine : seuil 4, et des tailles choisies pour que, sous 16 boucles CPU,
    l'ancien code quadratique le dépasse d'au moins deux fois (8,5 à 16,3 mesurés) quand le code
    actuel reste entre 0,6 et 2,4 (mesures en commentaire des tests concernés). Les
    expansions sont bornées et refusées avec un message (SubmissionRefused), jamais un faux
    verdict."""

    def test_cpp_declared_name_search_is_linear(self):
        # Non ancrée, la recherche du nom déclaré repartait de chaque caractère d'un long mot
        # sans `(` : 115 s par cas pour 99 000 caractères.
        def prepare(size):
            src = "struct S {\n int " + "a" * size + ";\n int m() { return 0; } };\n"
            return (supervisor.blank_code(src),)
        ratio = growth_ratio(supervisor.cpp_object_api, prepare, 5_000, 45_000)
        self.assertLess(ratio, 4, "recherche du nom déclaré quadratique (rapport %.1f)" % ratio)
        # Même résultat que la recherche non ancrée : le mot de tête, `~` compris.
        found = supervisor.CPP_DECLARED_NAME.search
        self.assertEqual("aire", found("int aire(int a)").group(1))
        self.assertEqual("~Forme", found("virtual ~Forme()").group(1))
        self.assertEqual("~Foo", found("a~Foo(").group(1))
        self.assertEqual("g", found("int ab cd g (").group(1))
        self.assertIsNone(found("int " + "a" * 1000))
        api = supervisor.cpp_object_api(supervisor.blank_code(
            "struct S {\n int " + "a" * 5_000 + ";\n int m() { return 0; } };\n"))
        self.assertEqual([("S", [[]], [("int", "m", [])])], api)

    def test_member_pieces_is_linear(self):
        # Une ligne qui n'est qu'une tête de déclaration ne coupe pas : le morceau en cours était
        # relu à chaque fin de ligne (une seconde par cas pour 49 000 lignes `a`).
        def prepare(lines):
            body = "a\n" * lines
            return body, 0, supervisor.code_depths(body), 0
        # 16 × 20 000 lignes. Sous 16 boucles CPU (conteneur runner, 8 cœurs) : ancien code 16,3
        # (il ne donnait que 3,9 à 9 × 10 000 lignes, sous le seuil) ; code actuel 0,95 à 2,35.
        ratio = growth_ratio(supervisor._member_pieces, prepare, 20_000, 320_000)
        self.assertLess(ratio, 4, "_member_pieces quadratique (rapport %.1f)" % ratio)
        body = "a\n" * 1_000
        self.assertEqual([body], supervisor._member_pieces(body, 0, supervisor.code_depths(body), 0))
        body = "int\n aire() { return 1; }\n#define X\nint b;\n"
        self.assertEqual(["int\n aire() { return 1; }", "\n", "#define X\n", "int b;", "\n"],
                         supervisor._member_pieces(body, 0, supervisor.code_depths(body), 0))

    def test_cs_strip_comments_is_linear(self):
        # Chaque `#` relisait sa ligne depuis le début pour savoir s'il ouvre une directive :
        # 3 s par cas pour `a` suivi de 99 999 `#`.
        # 32 × 20 000 : la part quadratique de l'ancien code (des copies en C) est petite devant
        # le parcours en Python. Sous 16 boucles CPU : ancien code 12,2 (4,7 à 9 × 11 000 et 5,1 à
        # 16 × 20 000, trop près du seuil) ; code actuel 0,74 à 0,90.
        ratio = growth_ratio(supervisor.cs_strip_comments, lambda n: ("a" + "#" * n,),
                             20_000, 640_000)
        self.assertLess(ratio, 4, "cs_strip_comments quadratique (rapport %.1f)" % ratio)
        # Directive seulement en tête de ligne (blancs admis), lue dans le texte ORIGINAL : un
        # `#` après du code, ou après un commentaire sur la même ligne, n'en ouvre pas.
        self.assertEqual("a #b\n" + " " * 16 + "\nint x;",
                         supervisor.cs_strip_comments("a #b\n  #region l'aide\nint x;"))
        self.assertEqual("        #x; \nint y;",
                         supervisor.cs_strip_comments("/* c */ #x; \nint y;"))
        self.assertEqual("  \n   #x\n" + " " * 7 + "\nint w;",
                         supervisor.cs_strip_comments("/*\n*/ #x\n  #if A\nint w;"))

    def test_default_parameters_are_bounded(self):
        bound = supervisor.MAX_DEFAULT_PARAMS
        entry = ("int", "f", ["int"] * (bound + 2), bound)
        self.assertEqual(bound + 1, len(supervisor.with_default_arities([entry])))
        refused = ("int", "f", ["int"] * (bound + 2), bound + 1)
        with self.assertRaises(supervisor.SubmissionRefused) as raised:
            supervisor.with_default_arities([refused])
        self.assertIn("« f »", str(raised.exception))
        self.assertIn(str(bound), str(raised.exception))
        defaults = ", ".join("int a%d = 0" % i for i in range(bound + 1))
        cpp = "int f(int x, %s) { return x; }\n" % defaults
        with self.assertRaises(supervisor.SubmissionRefused):
            supervisor.c_signatures(supervisor.blank_code(cpp), cpp=True)
        with self.assertRaises(supervisor.SubmissionRefused):
            supervisor.cpp_object_api(supervisor.blank_code(
                "struct R { R(%s) {} int m() { return 0; } };\n" % defaults))
        cs = "class Solution { static int F(int x, %s) { return x; } }" % defaults
        with self.assertRaises(supervisor.SubmissionRefused):
            supervisor.cs_signatures(supervisor.cs_strip_comments(cs))
        # Constructeur d'une AUTRE classe que celle que vise le harnais : refusé quand même,
        # pour que canaris (harnais muet) et cas réels soient refusés ensemble.
        cs = ("class Solution { static int F(int x) { return x; } }\n"
              "class Rect { public Rect(%s) {} public int Aire() { return 1; } }" % defaults)
        with self.assertRaises(supervisor.SubmissionRefused):
            supervisor.cs_object_api(supervisor.cs_strip_comments(cs), "Solution")
        # 4 000 paramètres par défaut : refusés d'emblée, sans construire les arités réduites.
        many = ", ".join("int a%d=0" % i for i in range(4_000))
        started = time.perf_counter()
        with self.assertRaises(supervisor.SubmissionRefused):
            supervisor.c_signatures(supervisor.blank_code("int f(%s) { return 0; }" % many), cpp=True)
        self.assertLess(time.perf_counter() - started, 5.0)

    def test_inheritance_is_bounded(self):
        depth = supervisor.MAX_ANCESTORS
        def chain(length):
            apis = {"A%d" % k: ([[]], [("int", "m%d" % k, [])]) for k in range(length)}
            parents = {"A%d" % k: "A%d" % (k - 1) for k in range(1, length)}
            return apis, parents
        merged = supervisor.inherit_instance_methods(*chain(depth + 1))
        self.assertEqual(depth + 1, len(merged["A%d" % depth]))
        with self.assertRaises(supervisor.SubmissionRefused) as raised:
            supervisor.inherit_instance_methods(*chain(depth + 2))
        self.assertIn("« A%d »" % (depth + 1), str(raised.exception))
        # Large plutôt que profond : une base et beaucoup de dérivées.
        width = supervisor.MAX_INHERITED_METHODS // 100 + 1
        apis = {"B": ([[]], [("int", "m%d" % k, []) for k in range(100)])}
        apis.update({"D%d" % k: ([[]], []) for k in range(width)})
        with self.assertRaises(supervisor.SubmissionRefused):
            supervisor.inherit_instance_methods(apis, {"D%d" % k: "B" for k in range(width)})
        # Par langage, sur une chaîne de 2 000 classes (près de 100 Ko) : refus rapide.
        cpp = "struct A0 { int m0() { return 0; } };\n" + "".join(
            "struct A%d : A%d { int m%d() { return 0; } };\n" % (k, k - 1, k) for k in range(1, 2_000))
        go = "package main\ntype A0 struct{}\nfunc (a A0) M0() int { return 0 }\n" + "".join(
            "type A%d struct{ A%d }\nfunc (a A%d) M%d() int { return 0 }\n" % (k, k - 1, k, k)
            for k in range(1, 2_000))
        cs = "class A0 { public int M0() { return 0; } }\n" + "".join(
            "class A%d : A%d { public int M%d() { return 0; } }\n" % (k, k - 1, k) for k in range(1, 2_000))
        rust = "trait T {\n" + "".join("fn d%d(&self) -> i32 { 0 }\n" % k for k in range(2_000)) + "}\n" + "".join(
            "struct U%d;\nimpl T for U%d {}\n" % (k, k) for k in range(2_000))
        for extract in (lambda: supervisor.cpp_object_api(supervisor.blank_code(cpp)),
                        lambda: supervisor.go_object_api(supervisor.blank_code(go, backticks=True)),
                        lambda: supervisor.cs_object_api(supervisor.cs_strip_comments(cs), "A5"),
                        lambda: supervisor.rust_object_api(supervisor.blank_code(rust, rust=True))):
            started = time.perf_counter()
            with self.assertRaises(supervisor.SubmissionRefused):
                extract()
            self.assertLess(time.perf_counter() - started, 5.0)

    def test_cpp_inherited_constructors_linear_and_bounded(self):
        # Dérivées AVANT leur base dans le texte : la boucle « jusqu'à stabilité » faisait un
        # tour de toutes les classes par niveau (quadratique).
        def chain(length):
            apis = {"A%d" % k: ([], []) for k in range(length - 1, 0, -1)}
            apis["A0"] = ([["int"]], [])
            bases = {"A%d" % k: "A%d" % (k - 1) for k in range(1, length)}
            return apis, bases, set(bases)
        ratio = growth_ratio(supervisor.cpp_inherit_constructors, chain, 1_000, 9_000)
        self.assertLess(ratio, 4, "constructeurs repris quadratiques (rapport %.1f)" % ratio)
        apis, bases, inheriting = chain(50)
        supervisor.cpp_inherit_constructors(apis, bases, inheriting)
        self.assertEqual([["int"]], apis["A49"][0])
        # Ordre : la liste propre de la classe, puis celles de sa base.
        apis = {"C": ([["long"]], []), "B": ([["double"], []], []), "A": ([["int"]], [])}
        supervisor.cpp_inherit_constructors(apis, {"C": "B", "B": "A"}, {"C", "B"})
        self.assertEqual([["long"], ["double"], ["int"]], apis["C"][0])
        self.assertEqual([["double"], [], ["int"]], apis["B"][0])
        api = supervisor.cpp_object_api(supervisor.blank_code(
            "struct C : B { using B::B; int m() { return 0; } };\n"
            "struct B : A { using A::A; };\n"
            "struct A { A(int a) {} };\n"))
        # (Sans constructeur déclaré, C garde aussi son constructeur par défaut implicite.)
        self.assertEqual([("C", [[], ["int"]], [("int", "m", [])])], api)
        # Une base à 200 constructeurs reprise par 60 dérivées : 12 000 > la borne.
        base = "struct B {\n%s int m() { return 0; } };\n" % "".join(
            "B(%s) {}\n" % ", ".join(["int"] * k) for k in range(1, 201))
        derived = "".join("struct D%d : B { using B::B; };\n" % k for k in range(60))
        with self.assertRaises(supervisor.SubmissionRefused):
            supervisor.cpp_object_api(supervisor.blank_code(base + derived))

    def test_cpp_object_api_compiles_no_pattern_per_class(self):
        # Une expression construite sur le nom de CHAQUE classe était recompilée à chaque
        # classe (le cache de `re` en garde 512) : une seconde par cas pour 3 300 classes.
        patterns = []
        real_match = re.match
        def spy(pattern, *args, **kwargs):
            patterns.append(getattr(pattern, "pattern", pattern))
            return real_match(pattern, *args, **kwargs)
        src = "".join("struct Classe%d { Classe%d(int a) {} int m() { return a; } };\n" % (k, k)
                      for k in range(20))
        with unittest.mock.patch.object(supervisor.re, "match", spy):
            api = supervisor.cpp_object_api(supervisor.blank_code(src))
        self.assertEqual(20, len(api))
        self.assertEqual([["int"]], api[0][1])
        self.assertEqual([], [p for p in patterns if "Classe" in p])

    def test_field_copies_are_bounded(self):
        # Chaque méthode et chaque constructeur relayés recopient tous les champs : 7 000 champs
        # et 1 200 méthodes dépassaient 1,7 Go en Go, 3,7 Go en Rust.
        def go(fields, methods):
            return ("package main\ntype S struct {\n%s}\n%s" % (
                "".join("\tf%d int\n" % k for k in range(fields)),
                "".join("func (o S) M%d() int { return 0 }\n" % k for k in range(methods))))
        def rust(fields, methods):
            return "struct S { %s }\nimpl S {\n%s}\n" % (
                " ".join("f%d: i32," % k for k in range(fields)),
                "".join("fn m%d(&self) -> i32 { 0 }\n" % k for k in range(methods)))
        bound = supervisor.MAX_FIELD_COPIES
        fields = 100
        fits = bound // fields - 1           # méthodes + 1 (le littéral) : juste sous la borne
        self.assertEqual(1, len(supervisor.go_object_api(supervisor.blank_code(go(fields, fits - 1)))))
        self.assertEqual(1, len(supervisor.rust_object_api(supervisor.blank_code(rust(fields, fits - 1), rust=True))))
        with self.assertRaises(supervisor.SubmissionRefused) as raised:
            supervisor.go_object_api(supervisor.blank_code(go(fields, fits + 1)))
        self.assertIn("« S »", str(raised.exception))
        with self.assertRaises(supervisor.SubmissionRefused):
            supervisor.rust_object_api(supervisor.blank_code(rust(fields, fits + 1), rust=True))
        # Un type à poignée (sans capture de champs) ne recopie rien.
        supervisor.check_field_copies([("S", [], [("int", "m", [])] * 1_000)], {})

    def test_c_segment_bounded_in_characters(self):
        # Le budget en octets laissait un segment ASCII jusqu'à quatre fois plus long que le
        # code soumis s'il était rempli de caractères de quatre octets.
        pre = '# 1 "pp.c"\n' + "int a;\n" * 100
        self.assertIsNotNone(supervisor.c_student_segment(pre, "pp.c", budget=10_000))
        self.assertIsNone(supervisor.c_student_segment(pre, "pp.c", budget=10_000, char_budget=100))
        self.assertEqual(("int a;\n" * 100).rstrip("\n"), supervisor.c_student_segment(
            pre, "pp.c", budget=10_000, char_budget=700))

    # --- Paramètres RELAYÉS : les bornes d'héritage comptent des méthodes, pas leurs paramètres.
    # Une méthode de 4 000 paramètres héritée par 2 500 classes faisait un serveur C++ de 768 M
    # caractères (3,6 Go). La borne porte sur l'API FINALE de chaque runner, avant génération.

    def assert_runner_checks_before(self, runner, *generators):
        source = inspect.getsource(runner)
        self.assertIn("check_relayed_params(", source)
        for generator in generators:
            self.assertLess(source.index("check_relayed_params("), source.index(generator),
                            "%s : borne après %s" % (runner.__name__, generator))

    def test_relayed_params_counts_every_shape(self):
        self.assertEqual(0, supervisor.relayed_params())
        self.assertEqual(9, supervisor.relayed_params(
            [("int", "f", ["int", "int"])],
            [("R", [["int"], []], [("int", "m", ["int", "int"])]),          # C++, Java
             ("G", [("NewG", ["int"], False)], [("int", "m", ["int"])]),     # Go
             ("U", [("new", ["i32", "i32"])], [])]))                        # Rust
        # 20 000 au plus : le noteur Rust (toute l'API) de 99 000 paramètres était tué par l'OOM
        # à 1,09 Go (1 CPU, 1 Go) — une compilation du noteur tuée est « interrompue », sans note,
        # et ne doit pas être provocable ; à 20 000, 2,5 s et 392 Mo.
        self.assertLessEqual(supervisor.MAX_RELAYED_PARAMS, 20_000)
        supervisor.check_relayed_params([("int", "f", ["int"] * supervisor.MAX_RELAYED_PARAMS)])
        with self.assertRaises(supervisor.SubmissionRefused) as raised:
            supervisor.check_relayed_params([("int", "f", ["int"])] * 2,
                                            extra=supervisor.MAX_RELAYED_PARAMS - 1)
        self.assertIn(str(supervisor.MAX_RELAYED_PARAMS), str(raised.exception))

    def test_relayed_params_bounded_cpp_inherited_method(self):
        params = ", ".join("int a%d" % i for i in range(4_000))
        src = "struct B { int f(%s) { return 0; } };\n" % params + "".join(
            "struct D%d : B {};\n" % k for k in range(30))
        ex = supervisor.blank_code(src)
        with self.assertRaises(supervisor.SubmissionRefused):
            supervisor.check_relayed_params(supervisor.c_signatures(ex, cpp=True),
                                            supervisor.cpp_object_api(ex))
        self.assert_runner_checks_before(supervisor.run_c_rpc, "c_server_source(", "c_grader_source(")

    def test_relayed_params_bounded_cpp_inherited_constructors(self):
        params = ", ".join("int a%d" % i for i in range(4_000))
        src = "struct B { B(%s) {} int m() { return 0; } };\n" % params + "".join(
            "struct D%d : B { using B::B; };\n" % k for k in range(30))
        ex = supervisor.blank_code(src)
        api = supervisor.cpp_object_api(ex)
        self.assertGreater(supervisor.relayed_params((), api), supervisor.MAX_RELAYED_PARAMS)
        with self.assertRaises(supervisor.SubmissionRefused):
            supervisor.check_relayed_params(supervisor.c_signatures(ex, cpp=True), api)

    def test_relayed_params_bounded_rust_trait_default(self):
        params = ", ".join("a%d: i32" % i for i in range(4_000))
        def source(impls):
            return ("trait T {\n fn d(&self, %s) -> i32 { 0 }\n}\n" % params + "".join(
                "struct U%d;\nimpl T for U%d {}\n" % (k, k) for k in range(impls)))
        ex = supervisor.blank_code(source(600), rust=True)
        api = supervisor.rust_object_api(ex)
        self.assertEqual(600, len(api))
        with self.assertRaises(supervisor.SubmissionRefused):
            supervisor.check_relayed_params(supervisor.rust_signatures(ex), api)
        self.assert_runner_checks_before(supervisor.run_rust_rpc, "rust_server_source(",
                                         "rust_grader_source(")
        # La liste de paramètres d'une méthode par défaut est lue UNE fois, pas à chaque `impl`
        # qui la reçoit (n paramètres reportés sur m types coûtaient n × m découpages).
        with unittest.mock.patch.object(supervisor, "_rust_param_types",
                                        wraps=supervisor._rust_param_types) as parse:
            self.assertEqual(600, len(supervisor.rust_object_api(ex)))
        self.assertEqual(1, parse.call_count)

    def test_relayed_params_bounded_go_promoted_method(self):
        params = ", ".join("a%d" % i for i in range(7_000)) + " int"
        src = ("package main\ntype B struct{}\nfunc (b B) M(%s) int { return 0 }\n" % params
               + "".join("type D%d struct{ B }\nfunc NewD%d() D%d { return D%d{} }\n" % (k, k, k, k)
                         for k in range(20)))
        ex = supervisor.blank_code(src, backticks=True)
        with self.assertRaises(supervisor.SubmissionRefused):
            supervisor.check_relayed_params(supervisor.go_signatures(ex),
                                            supervisor.go_object_api(ex))
        self.assert_runner_checks_before(supervisor.run_go_rpc, "go_server_source(",
                                         "go_grader_source(")

    def test_relayed_params_bounded_csharp_and_java(self):
        params = ", ".join("int a%d" % i for i in range(4_000))
        src = ("class B { public int M(%s) { return 0; } }\n" % params
               + "".join("class D%d : B {}\n" % k for k in range(30)))
        ex = supervisor.cs_canonical_types(supervisor.cs_strip_comments(src))
        self.assertGreater(supervisor.cs_relayed_params(ex)[0], supervisor.MAX_RELAYED_PARAMS)
        # Constructeurs de TOUTES les classes, arités réduites comprises : 3 + 2 + 1 paramètres,
        # trois entrées.
        self.assertEqual((6, 3), supervisor.cs_relayed_params(
            "class R { public R(int a, int b = 1, int c = 2) {} }"))
        # Avant le choix de la classe que vise le harnais : canaris et cas réels ensemble.
        self.assert_runner_checks_before(supervisor.run_csharp_rpc, "cs_student_class(",
                                         "cs_grader_source(")
        self.assert_runner_checks_before(supervisor.run_java_rpc, "java_stub_source(",
                                         "java_grader_objects(")

    def test_relayed_entries_bounded(self):
        # La compilation du NOTEUR expirée ou tuée est « interrompue », sans note : elle ne doit
        # pas être provocable. Or le noteur grossit avec le NOMBRE d'entrées, pas seulement avec
        # les paramètres : 2 731 méthodes Go sans paramètre (5 champs) faisaient un noteur de
        # 495 Mo à la compilation (1 CPU, 1 Go). Borne : MAX_RELAYED_ENTRIES.
        bound = supervisor.MAX_RELAYED_ENTRIES
        self.assertLessEqual(bound, 1_000)
        self.assertEqual(5, supervisor.relayed_entries(
            [("int", "f", [])], [("R", [[], ["int"]], [("int", "m", [])]),
                                 ("G", [("NewG", [], False)], [])]))
        supervisor.check_relayed_params([("int", "f%d" % k, []) for k in range(bound)])
        with self.assertRaises(supervisor.SubmissionRefused) as raised:
            supervisor.check_relayed_params([("int", "f", [])], extra_entries=bound)
        self.assertIn(str(bound), str(raised.exception))
        # Par langage, sans paramètre : seul le nombre d'entrées dépasse.
        cpp = "struct R {\n" + "".join("int m%d(){return 0;}\n" % k for k in range(bound + 1)) + "};\n"
        ex = supervisor.blank_code(cpp)
        with self.assertRaises(supervisor.SubmissionRefused):
            supervisor.check_relayed_params(supervisor.c_signatures(ex, cpp=True),
                                            supervisor.cpp_object_api(ex))
        cs = "class R {\n" + "".join("public int M%d() => 0;\n" % k for k in range(bound + 1)) + "}\n"
        relayed, entries = supervisor.cs_relayed_params(cs)
        self.assertEqual((0, bound + 1), (relayed, entries))
        self.assertIn("extra_entries=entries", inspect.getsource(supervisor.run_csharp_rpc))
        self.assertIn("extra_entries=", inspect.getsource(supervisor.run_java_rpc))

    def test_field_copies_bound_keeps_go_grader_small(self):
        # 13 600 copies de champs (2 731 méthodes à récepteur pointeur, 5 champs) : noteur Go de
        # 495 Mo à la compilation. 20 000 copies admises rendaient l'OOM du conteneur possible.
        self.assertLessEqual(supervisor.MAX_FIELD_COPIES, 5_000)

    def test_go_embedded_types_are_deduplicated(self):
        # 19 000 lignes `B` dans une structure embarquée par 3 000 types : 57 millions de
        # parents parcourus, 3,5 s par cas.
        self.assertEqual({"H": ["B", "C"]}, supervisor.go_embedded_types(
            "type H struct {\n\tB\n\t*C\n\tB\n}\n"))
        merged = supervisor.inherit_instance_methods(
            {"B": ((), [("int", "m", [])]), "H": ((), [])}, {"H": ["B", "B", "B"]})
        self.assertEqual([("int", "m", [])], merged["H"])
        def prepare(lines):
            src = ("package main\ntype B struct{}\nfunc (b B) M() int { return 0 }\n"
                   "type H struct {\n" + "\tB\n" * lines + "}\n"
                   + "".join("type T%d struct{ H }\n" % k for k in range(lines // 6)))
            return (supervisor.blank_code(src, backticks=True),)
        # 16 × 2 000 lignes. Sous 16 boucles CPU : ancien code 11,1 ; code actuel 0,58 à 2,10.
        ratio = growth_ratio(supervisor.go_object_api, prepare, 2_000, 32_000)
        self.assertLess(ratio, 4, "types embarqués en double reparcourus (rapport %.1f)" % ratio)
        # Et inherit_instance_methods ne relit plus des parents répétés à chaque visite, quel
        # que soit le langage qui les lui donne.
        def repeated(count):
            apis = {"B": ((), [("int", "m", [])]), "H": ((), [])}
            apis.update({"T%d" % k: ((), []) for k in range(count // 6)})
            parents = {"H": ["B"] * count}
            parents.update({"T%d" % k: "H" for k in range(count // 6)})
            return apis, parents
        # Sous 16 boucles CPU : ancien code 9,9 ; code actuel 0,73 à 1,56.
        ratio = growth_ratio(supervisor.inherit_instance_methods, repeated, 5_000, 45_000)
        self.assertLess(ratio, 4, "parents répétés reparcourus (rapport %.1f)" % ratio)


class PlatformInterruptionTest(unittest.TestCase):
    """Revue #246 : une compilation du NOTEUR expirée ou tuée, un inventaire javap ou une sonde
    des noms réservés expirés arrivaient à execution-service comme des verdicts ordinaires
    (passed=false) : un 0 définitif que personne ne pouvait rejouer. Ces cas sont désormais
    INTERROMPUS (cause « interrompu ») : le job est « incomplet », execution-service en fait un
    « sans verdict » sur le chemin interne, et le « Tester » garde le message."""

    def setUp(self):
        self.directory = tempfile.mkdtemp()
        self.box, self.base_env = supervisor.BOX, supervisor.base_env
        self.runners = dict(supervisor.RUNNERS)
        supervisor.BOX = self.directory
        supervisor.base_env = lambda case_dir: {"HOME": self.directory, "TMPDIR": self.directory}

    def tearDown(self):
        supervisor.BOX, supervisor.base_env = self.box, self.base_env
        supervisor.RUNNERS.clear()
        supervisor.RUNNERS.update(self.runners)
        shutil.rmtree(self.directory, ignore_errors=True)

    def run_case(self, runner):
        supervisor.RUNNERS["Java"] = runner
        return supervisor.execute_case("Java", {"index": 0}, 10)[0]

    def test_platform_aborted_recognises_our_prefixes_only(self):
        aborted = supervisor.harness_build_failure(True, None, "contre le code soumis", "")
        self.assertTrue(supervisor.platform_aborted(aborted))
        self.assertTrue(supervisor.platform_aborted(supervisor.TOOL_ABORTED + " : javap"))
        self.assertFalse(supervisor.platform_aborted(
            supervisor.harness_build_failure(False, 1, "contre le code soumis", "CS0117")))
        self.assertFalse(supervisor.platform_aborted(
            "Échec de compilation :\n" + supervisor.HARNESS_BUILD_ABORTED))
        self.assertFalse(supervisor.platform_aborted(None))

    def test_aborted_harness_build_makes_the_job_incomplete(self):
        issue = self.run_case(lambda *a: (None, supervisor.harness_build_failure(
            False, -9, "contre le code soumis", "")))
        self.assertEqual("interrompu", issue.cause)
        self.assertTrue(supervisor.inconclusive(issue))
        self.assertTrue(supervisor.grading_incomplete([issue]))
        self.assertTrue(supervisor.job_incomplete("ok", [issue]))
        # Une falsification l'emporte toujours.
        self.assertFalse(supervisor.job_incomplete("incoherents", [issue]))
        # Un vrai diagnostic du compilateur du noteur reste une note (message au prof).
        issue = self.run_case(lambda *a: (None, supervisor.harness_build_failure(
            False, 1, "contre le code soumis", "CS0117")))
        self.assertIsNone(issue.cause)
        self.assertFalse(supervisor.grading_incomplete([issue]))

    def test_tool_aborted_exception_interrupts_the_case(self):
        def runner(*a):
            raise supervisor.ToolAborted(supervisor.TOOL_ABORTED + " : sonde")
        issue = self.run_case(runner)
        self.assertFalse(issue.passed)
        self.assertEqual("interrompu", issue.cause)
        self.assertTrue(supervisor.grading_incomplete([issue]))
        # L'inventaire javap expiré ou tué : son message (javap_aborted_message) commence par le
        # préfixe TOOL_ABORTED, donc le cas est interrompu et non noté 0.
        javap = supervisor.javap_aborted_message("Solution")
        self.assertTrue(supervisor.platform_aborted(javap))
        self.assertIn("javap", javap)
        self.assertIn("Solution", javap)

    def test_expired_reserved_name_probe_interrupts_instead_of_refusing(self):
        # Une sonde EXPIRÉE ne dit rien du nom : elle était comptée comme un refus (« nom
        # réservé » sur un nom innocent), et chacune avait le délai d'une compilation (90 s).
        timeouts = []
        def expired(cmd, cwd, env, timeout_s, *rest, **kwargs):
            timeouts.append(timeout_s)
            return None, True
        with unittest.mock.patch.object(supervisor, "run_proc", expired):
            with self.assertRaises(supervisor.ToolAborted) as raised:
                supervisor.c_reserved_names(["valeur"], "gcc", "-std=c17", self.directory, {})
        self.assertTrue(raised.exception.args[0].startswith(supervisor.TOOL_ABORTED))
        self.assertLessEqual(max(timeouts), supervisor.C_PROBE_BUDGET_S)
        # Une sonde TUÉE par un signal (OOM : code < 0) ne dit rien du nom non plus : lue comme
        # « ne compile pas », elle refusait un nom innocent.
        with unittest.mock.patch.object(supervisor, "run_proc", lambda *a, **k: (-9, False)):
            with self.assertRaises(supervisor.ToolAborted):
                supervisor.c_reserved_names(["valeur"], "gcc", "-std=c17", self.directory, {})
        # Une sonde terminée garde son sens : compile → pas réservé ; échoue → réservé.
        with unittest.mock.patch.object(supervisor, "run_proc", lambda *a, **k: (0, False)):
            self.assertEqual([], supervisor.c_reserved_names(["valeur"], "gcc", "-std=c17",
                                                             self.directory, {}))
        with unittest.mock.patch.object(supervisor, "run_proc", lambda *a, **k: (1, False)):
            self.assertEqual(["valeur"], supervisor.c_reserved_names(["valeur"], "gcc", "-std=c17",
                                                                     self.directory, {}))

    def test_java_class_count_is_bounded_before_javap(self):
        # 7 611 `class qXXX{}` (99 Ko) : javap expirait à chaque cas, canaris compris, et
        # l'expiration d'un outil est « interrompue » — tentative rejouée à volonté.
        bound = supervisor.JAVA_MAX_CLASSES
        self.assertLessEqual(bound, 256)
        self.assertIsNone(supervisor.java_class_count_refusal(bound))
        refusal = supervisor.java_class_count_refusal(bound + 1)
        self.assertIn(str(bound + 1), refusal)
        self.assertFalse(supervisor.platform_aborted(refusal))
        source = inspect.getsource(supervisor.run_java_rpc)
        self.assertLess(source.index("java_class_count_refusal("), source.index('["javap"'))

    def test_killed_javap_is_interrupted_not_graded(self):
        # javap TUÉ par un signal (code < 0) : seul `expired` était testé, et le cas tombait sur
        # « Aucune méthode statique ni objet exploitable » — un 0 qui accuse la réponse.
        # Le message rendu est javap_aborted_message (préfixe TOOL_ABORTED, vérifié par
        # test_tool_aborted_exception_interrupts_the_case), juste après la condition.
        source = inspect.getsource(supervisor.run_java_rpc)
        inventory = source[source.index('["javap"'):]
        condition = inventory.index("expired or (code is not None and code < 0)")
        message = inventory.index("return None, javap_aborted_message(klass)")
        self.assertLess(condition, message)
        self.assertEqual("", inventory[condition:message].split(":", 1)[1].strip())
        self.assertLess(message, inventory.index("Aucune méthode statique ni objet exploitable"))

    def test_java_rpc_server_compile_abort_is_interrupted(self):
        # javac du SERVEUR RPC expiré ou tué : « Erreur interne du noteur » sans cause, donc un 0
        # définitif. Avec la borne de classes, le code soumis ne peut pas le pousser au délai.
        source = inspect.getsource(supervisor.run_java_rpc)
        server = source[source.index('"MooditServer.java")],'):]
        abort = server.index("TOOL_ABORTED")
        self.assertLess(server.index("expired or (code is not None and code < 0)"), abort)
        self.assertLess(abort, server.index('"Erreur interne du noteur (serveur RPC)"'))

    # Stderr RÉELS, relevés dans les images (travailleur tué par SIGKILL, puis par l'OOM d'un
    # conteneur à 150 Mo) : le pilote survit et sort en 1.
    GCC_KILLED = "gcc: fatal error: Killed signal terminated program cc1\ncompilation terminated.\n"
    GXX_KILLED = "g++: fatal error: Killed signal terminated program cc1plus\ncompilation terminated.\n"
    AS_KILLED = "gcc: fatal error: Killed signal terminated program as\ncompilation terminated.\n"
    GO_KILLED = "runtime: /usr/local/go/pkg/tool/linux_amd64/compile: signal: killed\n"

    def test_tool_killed_reads_the_driver_signature(self):
        for stderr in (self.GCC_KILLED, self.GXX_KILLED, self.AS_KILLED, self.GO_KILLED,
                       "# moodit_noteur\nmoodit_noteur: /usr/local/go/pkg/tool/linux_amd64/compile: signal: killed\n",
                       "collect2: fatal error: ld terminated with signal 9 [Killed]\ncompilation terminated.\n"):
            with self.subTest(stderr=stderr):
                self.assertTrue(supervisor.tool_killed(1, stderr))
        self.assertTrue(supervisor.tool_killed(-9, ""))
        for stderr in ("noteur.c:3:1: error: expected ';' before '}' token\n",
                       "./noteur.go:4:2: undefined: Aire\n",
                       # La signature au milieu d'une ligne n'est pas celle du pilote.
                       "x.c:1:2: error: #error gcc: fatal error: Killed signal terminated program cc1\n",
                       "Killed signal terminated program cc1\n", ""):
            with self.subTest(stderr=stderr):
                self.assertFalse(supervisor.tool_killed(1, stderr))

    def test_killed_worker_aborts_the_grader_build(self):
        # Noteur C/C++/Go : sortie 1 et stderr du pilote — c'était « Le harnais ne compile pas »,
        # un 0 définitif, et le script de rejeu en faisait un BLOQUANT (--unpublish).
        for stderr in (self.GCC_KILLED, self.GXX_KILLED, self.GO_KILLED):
            with self.subTest(stderr=stderr):
                detail = supervisor.harness_build_failure(False, 1, "contre le code soumis", stderr)
                self.assertTrue(detail.startswith(supervisor.HARNESS_BUILD_ABORTED))
                self.assertTrue(supervisor.platform_aborted(detail))
        # Le stderr ENTIER est lu : la signature vient en dernier, après d'éventuels
        # avertissements ; le message, lui, reste tronqué.
        long_stderr = "noteur.c:1:1: warning: x\n" * 200 + self.GCC_KILLED
        self.assertTrue(supervisor.harness_build_failure(
            False, 1, "contre le code soumis", long_stderr).startswith(supervisor.HARNESS_BUILD_ABORTED))
        error = supervisor.harness_build_failure(False, 1, "contre le code soumis",
                                                 "noteur.c:3:1: error: y\n" * 200)
        self.assertTrue(error.startswith(supervisor.HARNESS_BUILD_ERROR))
        self.assertLessEqual(len(error), 1_600)

    def test_killed_probe_worker_interrupts_instead_of_refusing(self):
        # cc1 tué sous la sonde : g++ sort en 1, que la sonde lisait « le nom ne compile pas ».
        def run(stderr):
            def fake(cmd, cwd, env, timeout_s, out_path, err_path, *rest, **kwargs):
                with open(err_path, "w", encoding="utf-8", newline="") as f:
                    f.write(stderr)
                return 1, False
            return fake
        with unittest.mock.patch.object(supervisor, "run_proc", run(self.GXX_KILLED)):
            with self.assertRaises(supervisor.ToolAborted):
                supervisor.c_reserved_names(["valeur"], "g++", "-std=c++20", self.directory, {})
        with unittest.mock.patch.object(supervisor, "run_proc",
                                        run("sonde.cpp:5:5: error: 'int valeur' redeclared\n")):
            self.assertEqual(["valeur"], supervisor.c_reserved_names(
                ["valeur"], "g++", "-std=c++20", self.directory, {}))

    def test_oom_kill_counter(self):
        path = os.path.join(self.directory, "memory.events")
        with open(path, "w", encoding="utf-8") as f:
            f.write("low 0\nhigh 0\nmax 28\noom 1\noom_kill 3\noom_group_kill 0\n")
        self.assertEqual(3, supervisor.oom_kills(path))
        self.assertIsNone(supervisor.oom_kills(os.path.join(self.directory, "absent")))
        self.assertTrue(supervisor.oom_killed_during(0, 1))
        self.assertFalse(supervisor.oom_killed_during(1, 1))
        self.assertFalse(supervisor.oom_killed_during(None, 1))
        self.assertFalse(supervisor.oom_killed_during(1, None))

    def test_c_tools_have_short_dedicated_timeouts(self):
        # Mirroir de DockerEvaluator.toolsPerCaseMs/toolsPerJobMs (et de core) : 20 s de sondes
        # et 10 s de `nm` par cas, 10 s de préprocesseur par job — et non 90 s chacun.
        self.assertEqual((20, 10, 10), (supervisor.C_PROBE_BUDGET_S, supervisor.NM_TIMEOUT_S,
                                        supervisor.C_PREPROCESS_TIMEOUT_S))
        source = inspect.getsource(supervisor.run_c_rpc)
        nm_call = source[source.index('["nm", "--defined-only"'):]
        self.assertIn("NM_TIMEOUT_S", nm_call[:200])
        self.assertNotIn("COMPILE_TIMEOUT_S", nm_call[:200])


if __name__ == "__main__":
    unittest.main(verbosity=1)

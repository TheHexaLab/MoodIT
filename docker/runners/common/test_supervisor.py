# -*- coding: utf-8 -*-
"""Tests unitaires des FONCTIONS PURES de supervisor.py (verdict des canaris, jeton de fin,
relecture tête+queue, substitution des gabarits, scan de trace) : la logique de verdict ne doit
pas n'être couverte que par les tests d'intégration Docker. Lancés par le job CI `integration`
(`python3 docker/runners/common/test_supervisor.py`) AVANT la construction des images, et
exécutables localement dans n'importe quelle image runner (le module importe `resource`,
indisponible sous Windows).
"""

import json
import os
import subprocess
import time
import re
import shutil
import sys
import tempfile
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
            False, "Échec du harnais JUnit", ran=True), lost=True)
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
        # conflit ; sous pytest (ordre du fichier), test_cas_saute_pour_saturation rougissait
        # — et un simple renommage de classe aurait inverse la CI. On ne fait pas confiance a
        # un etat global qu'on n'a pas pose.
        supervisor.EVENTS.clear()

    def test_signal_death_at_load_does_not_accuse(self):
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
        # conflit ; sous pytest (ordre du fichier), test_cas_saute_pour_saturation rougissait
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
            self.assertIn("tronquée au milieu", text)
        finally:
            os.unlink(f.name)


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
        self.assertIn("let mut moodit_rectangle: Vec<Rectangle>", stacks)
        self.assertIn('"new|Rectangle" =>', branches)
        self.assertIn('"new|new" =>', branches)
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
        self.assertIn("static std::vector<Rectangle> moodit_objets_Rectangle;", stacks)
        self.assertIn('strcmp(nom, "Rectangle.aire()")', branches)

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
        self.assertEqual(branches.count('"new|new" =>'), 1)
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
        # Un récepteur pointeur écarte la capture de champs : l'objet reconstruit à chaque appel
        # perdrait la modification EN SILENCE.
        self.assertEqual(supervisor.go_capture_fields(source), {})
        self.assertEqual(supervisor.go_pointer_receivers(source), {"Compteur"})
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
        self.assertEqual(supervisor.go_pointer_receivers(source), set())
        self.assertIn("Rectangle", supervisor.go_capture_fields(source))

    def test_double_keeps_its_precision(self):
        # `%g` s'arrête à 6 chiffres significatifs, pour les arguments COMME pour les retours :
        # 3.14159265 arrivait tronqué et une réponse juste était notée fausse.
        self.assertEqual(supervisor.C_TYPES["double"], "%.17g")
        stub_src = supervisor.c_grader_source([("double", "moyenne", ["double", "double"])],
                                             "return 1;", "N")
        self.assertIn("%.17g", stub_src)
        self.assertNotIn('"%s|call|moyenne|%g', stub_src)

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
        self.assertIn("moodit_hexe(&copie(a0))", server)

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
            self.assertIn("dec.UseNumber()", source)
            self.assertIn("func mooditEntier(", source)
            # Une seule table de conversion : l'aiguillage du serveur avait la sienne, restée sur
            # la lecture en flottant. Aucun chemin ne doit lire un entier autrement.
            self.assertNotIn("int64(mooditNombre(", source)
            self.assertNotIn("int(mooditNombre(", source)
        self.assertIn("valeur = somme(mooditEntier(req.Args[0]))",
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
        server = supervisor.cs_server_source("Solution")
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
        server = supervisor.java_server_source("Solution")
        self.assertIn('"{\\"ok\\":false,\\"id\\":\\""', server)
        self.assertIn('entre(ligne, "\\"id\\":\\"", "\\"")', server)

    def test_single_conversion_table_per_language(self):
        # Cause racine de trois tours de correctifs : une table dupliquée reste en arrière au
        # changement d'invariant suivant. Le garde-fou utile n'est pas « ce générateur-là utilise
        # la table » mais « il n'existe AUCUNE table littérale hors des constantes ».
        for t in supervisor.GO_CONV:
            self.assertIn(supervisor.GO_CONV[t] % "v",
                          supervisor.go_grader_source([(t, "f", [])], "true", "N"))
            self.assertIn(supervisor.GO_CONV[t] % "req.Args[0]",
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
        ("java", lambda: supervisor.java_server_source("Solution")),
        ("go", lambda: supervisor.go_server_source([("int", "f", [])])),
        ("go objets", lambda: supervisor.go_server_source(
            [], [("R", [], [("int", "m", [])])], {"R": [("c", "int")]})),
        ("rust", lambda: supervisor.rust_server_source([("i32", "f", [])], "fn f() {}")),
        ("rust objets", lambda: supervisor.rust_server_source(
            [], "struct R { c: i32 }", [("R", [], [("i32", "m", [])])], {"R": [("c", "i32")]})),
        ("csharp", lambda: supervisor.cs_server_source("Solution")),
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
        # Les écritures sur l'ERREUR standard ne sont pas des réponses : ce sont des diagnostics,
        # et le noteur ne les lit pas comme telles.
        emitted = _re.compile(
            r"(?:System[.]out[.]print|fmt[.]Print|\bprint!|Console[.]Out[.]Write|\bprintf)[(]")
        for ident, factory in self.DISPATCHERS:
            source = factory()
            sites = [l.strip() for l in source.splitlines()
                     if emitted.search(l) and "stderr" not in l]
            self.assertTrue(sites, "aucun site de réponse trouvé en " + ident)
            for site in sites:
                self.assertIn(chr(92) + "n", site.split("(", 1)[1][:24],
                              "réponse non cadrée en %s : %s" % (ident, site))

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
        server = supervisor.cs_server_source("Solution")
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
        self.assertIn('new String[] {"Solution", "Outils", "Solution$Interne"}', server)
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
        # rust_champ_commente_note_juste dans RpcGradingIntegrationTest.
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
        # go_champ_etiquete_note_juste dans RpcGradingIntegrationTest.
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
        self.assertEqual(ctors, [["int", "int"]])

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
            supervisor.chown_tree(link, os.getuid(), os.getgid())
            self.assertEqual(os.stat(file_path).st_mode & 0o777, 0o644)


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
                   "\nint a(" * (n // 7), "\nfn a(" * (n // 6), "\nstruct a {" * (n // 11)]
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
            self.assertIn('strcmp(nom, "%s")' % dedup_key, branches)
        server = supervisor.c_server_source([("int", "f", ["int"]), ("int", "f", ["double"])],
                                             "", cpp=True)
        self.assertIn('strcmp(nom, "f(int)")', server)
        self.assertIn('strcmp(nom, "f(double)")', server)

    def test_c_stub_not_static(self):
        grader_dir = supervisor.c_grader_source([("int", "abs", ["int"])], "return abs(-1) == 1;", "1")
        self.assertIn("int moodit_f_abs(int a0) {", grader_dir)
        self.assertIn("#define abs moodit_f_abs", grader_dir)
        self.assertNotIn("static int moodit_f_abs", grader_dir)

    def test_cpp_explicit_et_virtual(self):
        src = self.NL.join(["class Rect {", "public:", "    explicit Rect(int c) { }",
                            "    virtual int aire() { return 0; }", "};", ""])
        self.assertEqual(supervisor.cpp_object_api(src), [("Rect", [["int"]], [("int", "aire", [])])])

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
        # Les trois resolutions (statique, constructeur, instance) passent par `signe`, plus
        # aucune par la seule arite.
        self.assertEqual(server.count("signe(m.getParameterTypes(), appel, args.length)"), 2)
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


if __name__ == "__main__":
    unittest.main(verbosity=1)

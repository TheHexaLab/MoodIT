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

    # Liste UNIQUE des répartiteurs. Ajouter un langage sans tenir l'invariant fait échouer la
    # CI : c'est le seul garde-fou qui ferme vraiment le motif « invariant tenu presque partout »,
    # celui qui a produit quatre des cinq tours de correctifs de cette série.
    REPARTITEURS = (
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
            objets=[("R", [["int"]], [("int", "m", [])])])),
    )

    def test_toute_reponse_est_auto_cadree(self):
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
        emission = _re.compile(
            r"(?:System[.]out[.]print|fmt[.]Print|\bprint!|Console[.]Out[.]Write|\bprintf)[(]")
        for nom, fabrique in self.REPARTITEURS:
            source = fabrique()
            sites = [l.strip() for l in source.splitlines()
                     if emission.search(l) and "stderr" not in l]
            self.assertTrue(sites, "aucun site de réponse trouvé en " + nom)
            for site in sites:
                self.assertIn(chr(92) + "n", site.split("(", 1)[1][:24],
                              "réponse non cadrée en %s : %s" % (nom, site))

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

    def test_separateur_de_chiffres_cpp(self):
        # `1'000` : l'apostrophe n'ouvre pas de littéral. Elle faisait avaler la fin du
        # fichier par la plage de classe, et la fonction libre suivante disparaissait.
        source = ("class Grand {\npublic:\n    Grand() {}\n"
                  "    int mille() { return 1'000; }\n};\n\n"
                  "int doubler(int n) { return n * 2; }\n")
        self.assertEqual(supervisor.c_signatures(source, cpp=True),
                         [("int", "doubler", ["int"])])

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

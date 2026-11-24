package com.moodit.execution_service.service;

import org.junit.jupiter.api.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Bornes de charge du sandbox (#24) : limite globale avec file d'attente bornée, et limite par
 * utilisateur à refus immédiat. Les exécutions « en cours » sont simulées par des verrous.
 */
class ExecutionLimiterTest {

    /** Lance {@code action} dans un autre fil et attend qu'elle ait démarré (place occupée). */
    private static Future<String> occupy(ExecutorService pool, CountDownLatch release,
            java.util.function.Function<java.util.function.Supplier<String>, String> slot) throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        Future<String> f = pool.submit(() -> slot.apply(() -> {
            started.countDown();
            try {
                release.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return "fini";
        }));
        assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
        return f;
    }

    @Test
    void place_libre_execute_et_rend_la_place() {
        ExecutionLimiter limiter = new ExecutionLimiter(2, 0, 1);

        assertThat(limiter.withSandboxSlot(() -> "ok")).isEqualTo("ok");
        assertThat(limiter.availableSlots()).isEqualTo(2);
    }

    @Test
    void la_place_est_rendue_meme_si_l_execution_echoue() {
        ExecutionLimiter limiter = new ExecutionLimiter(1, 0, 1);

        assertThatThrownBy(() -> limiter.withSandboxSlot(() -> {
            throw new IllegalStateException("boom");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(limiter.availableSlots()).isEqualTo(1);
        assertThat(limiter.withSandboxSlot(() -> "encore")).isEqualTo("encore");
    }

    @Test
    void sandbox_sature_refuse_apres_l_attente_configuree() throws Exception {
        ExecutionLimiter limiter = new ExecutionLimiter(1, 200, 5);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        CountDownLatch release = new CountDownLatch(1);
        try {
            Future<String> running = occupy(pool, release, limiter::withSandboxSlot);
            long start = System.nanoTime();

            assertThatThrownBy(() -> limiter.withSandboxSlot(() -> "trop"))
                    .isInstanceOf(ExecutionBusyException.class)
                    .hasMessage(ExecutionBusyException.SANDBOX_BUSY);
            // On a bien attendu une place (file d'attente) avant de refuser.
            assertThat((System.nanoTime() - start) / 1_000_000).isGreaterThanOrEqualTo(150);

            release.countDown();
            assertThat(running.get(5, TimeUnit.SECONDS)).isEqualTo("fini");
            assertThat(limiter.availableSlots()).isEqualTo(1);
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void execution_en_attente_passe_des_qu_une_place_se_libere() throws Exception {
        ExecutionLimiter limiter = new ExecutionLimiter(1, 5000, 5);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch release = new CountDownLatch(1);
        try {
            Future<String> running = occupy(pool, release, limiter::withSandboxSlot);
            Future<String> waiting = pool.submit(() -> limiter.withSandboxSlot(() -> "en attente"));
            Thread.sleep(100);
            assertThat(waiting.isDone()).isFalse();

            release.countDown();
            assertThat(running.get(5, TimeUnit.SECONDS)).isEqualTo("fini");
            assertThat(waiting.get(5, TimeUnit.SECONDS)).isEqualTo("en attente");
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void attente_interrompue_refuse_et_garde_l_interruption() throws Exception {
        ExecutionLimiter limiter = new ExecutionLimiter(1, 5000, 5);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        CountDownLatch release = new CountDownLatch(1);
        try {
            occupy(pool, release, limiter::withSandboxSlot);
            Thread.currentThread().interrupt();

            assertThatThrownBy(() -> limiter.withSandboxSlot(() -> "jamais"))
                    .isInstanceOf(ExecutionBusyException.class)
                    .hasMessage(ExecutionBusyException.SANDBOX_BUSY);
            assertThat(Thread.interrupted()).isTrue();
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void utilisateur_a_sa_limite_est_refuse_immediatement_les_autres_passent() throws Exception {
        ExecutionLimiter limiter = new ExecutionLimiter(10, 0, 2);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch release = new CountDownLatch(1);
        try {
            Future<String> a1 = occupy(pool, release, s -> limiter.forUser("alice", s));
            Future<String> a2 = occupy(pool, release, s -> limiter.forUser("alice", s));
            assertThat(limiter.inFlight("alice")).isEqualTo(2);

            assertThatThrownBy(() -> limiter.forUser("alice", () -> "trop"))
                    .isInstanceOf(ExecutionBusyException.class)
                    .hasMessage(ExecutionBusyException.USER_BUSY);
            // Le refus ne consomme pas de place.
            assertThat(limiter.inFlight("alice")).isEqualTo(2);
            assertThat(limiter.forUser("bob", () -> "ok")).isEqualTo("ok");

            release.countDown();
            assertThat(a1.get(5, TimeUnit.SECONDS)).isEqualTo("fini");
            assertThat(a2.get(5, TimeUnit.SECONDS)).isEqualTo("fini");
            assertThat(limiter.inFlight("alice")).isZero();
            assertThat(limiter.forUser("alice", () -> "de nouveau")).isEqualTo("de nouveau");
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void place_utilisateur_rendue_meme_si_l_execution_echoue() {
        ExecutionLimiter limiter = new ExecutionLimiter(10, 0, 1);

        assertThatThrownBy(() -> limiter.forUser("alice", () -> {
            throw new IllegalStateException("boom");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(limiter.inFlight("alice")).isZero();
        assertThat(limiter.forUser("alice", () -> "ok")).isEqualTo("ok");
    }

    @Test
    void sans_utilisateur_pas_de_limite_par_utilisateur() {
        ExecutionLimiter limiter = new ExecutionLimiter(10, 0, 1);

        // Appels imbriqués : avec un utilisateur, le 2e serait refusé (limite 1).
        assertThat(limiter.forUser(null, () -> limiter.forUser(null, () -> "interne"))).isEqualTo("interne");
        assertThat(limiter.forUser("  ", () -> limiter.forUser("", () -> "vide"))).isEqualTo("vide");
        assertThatThrownBy(() -> limiter.forUser("alice", () -> limiter.forUser("alice", () -> "x")))
                .isInstanceOf(ExecutionBusyException.class);
    }

    @Test
    void place_de_son_cote_obtenue_mais_aucune_place_globale_refuse_et_rend_la_premiere() throws Exception {
        // Une seule place : la correction interne la tient. L'appel public obtient la place de
        // SON côté, pas la place globale → refus, et sa place de côté est rendue.
        ExecutionLimiter limiter = new ExecutionLimiter(1, 0, 5000, 5);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        CountDownLatch release = new CountDownLatch(1);
        try {
            Future<String> internal = occupy(pool, release,
                    s -> limiter.asInternal(() -> limiter.withSandboxSlot(s)));

            assertThatThrownBy(() -> limiter.withSandboxSlot(() -> "public"))
                    .isInstanceOf(ExecutionBusyException.class)
                    .hasMessage(ExecutionBusyException.SANDBOX_BUSY);

            release.countDown();
            assertThat(internal.get(5, TimeUnit.SECONDS)).isEqualTo("fini");
            // Place publique rendue au refus : l'appel suivant passe.
            assertThat(limiter.withSandboxSlot(() -> "ensuite")).isEqualTo("ensuite");
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void appel_interne_attend_plus_longtemps_qu_un_appel_public() throws Exception {
        // Attente publique nulle, attente interne longue : seule la correction interne patiente.
        ExecutionLimiter limiter = new ExecutionLimiter(1, 0, 5000, 5);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch release = new CountDownLatch(1);
        try {
            Future<String> running = occupy(pool, release, limiter::withSandboxSlot);

            assertThatThrownBy(() -> limiter.withSandboxSlot(() -> "public"))
                    .isInstanceOf(ExecutionBusyException.class);
            Future<String> internal = pool.submit(
                    () -> limiter.asInternal(() -> limiter.withSandboxSlot(() -> "interne")));
            Thread.sleep(100);
            assertThat(internal.isDone()).isFalse();

            release.countDown();
            assertThat(running.get(5, TimeUnit.SECONDS)).isEqualTo("fini");
            assertThat(internal.get(5, TimeUnit.SECONDS)).isEqualTo("interne");
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void le_mode_interne_ne_deborde_pas_de_son_appel() throws Exception {
        ExecutionLimiter limiter = new ExecutionLimiter(1, 0, 5000, 5);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        CountDownLatch release = new CountDownLatch(1);
        try {
            occupy(pool, release, limiter::withSandboxSlot);
            // Après un appel interne (même en échec), le même fil reprend l'attente publique (nulle).
            assertThatThrownBy(() -> limiter.asInternal(() -> {
                throw new IllegalStateException("boom");
            })).isInstanceOf(IllegalStateException.class);
            assertThat(limiter.asInternal(() -> limiter.asInternal(() -> "imbrique"))).isEqualTo("imbrique");
            long start = System.nanoTime();
            assertThatThrownBy(() -> limiter.withSandboxSlot(() -> "public"))
                    .isInstanceOf(ExecutionBusyException.class);
            assertThat((System.nanoTime() - start) / 1_000_000).isLessThan(1000);
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void configuration_invalide_refusee_au_demarrage() {
        assertThatThrownBy(() -> new ExecutionLimiter(0, 0, 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ExecutionLimiter(1, 0, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ExecutionLimiter(1, -1, 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ExecutionLimiter(1, 0, -1, 1)).isInstanceOf(IllegalArgumentException.class);
        // Bornes minimales acceptées.
        assertThat(new ExecutionLimiter(1, 0, 1).availableSlots()).isEqualTo(1);
    }

    @Test
    void a_slot_stays_reserved_for_internal_grading() throws Exception {
        // max = 2 : le PUBLIC ne peut occuper qu'UNE place — un conteneur de notation public
        // (qui peut vivre des minutes) ne doit jamais affamer la correction interne.
        ExecutionLimiter limiter = new ExecutionLimiter(2, 0, 5);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch release = new CountDownLatch(1);
        try {
            Future<String> holder = occupy(pool, release, limiter::withSandboxSlot);
            // Deuxième appel PUBLIC : refusé — la place restante est réservée à l'interne.
            assertThatThrownBy(() -> limiter.withSandboxSlot(() -> "non"))
                    .isInstanceOf(ExecutionBusyException.class);
            // Un appel INTERNE, lui, obtient la place réservée.
            assertThat(limiter.asInternal(() -> limiter.withSandboxSlot(() -> "interne")))
                    .isEqualTo("interne");
            release.countDown();
            assertThat(holder.get(5, TimeUnit.SECONDS)).isEqualTo("fini");
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void a_slot_stays_reserved_for_public_calls() throws Exception {
        // max = 3 (prod) : les corrections internes n'occupent que DEUX places — une file de
        // soumissions (fin d'examen) ne doit jamais refuser tous les « Exécuter ».
        ExecutionLimiter limiter = new ExecutionLimiter(3, 0, 200, 5);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch release = new CountDownLatch(1);
        try {
            Future<String> g1 = occupy(pool, release, s -> limiter.asInternal(() -> limiter.withSandboxSlot(s)));
            Future<String> g2 = occupy(pool, release, s -> limiter.asInternal(() -> limiter.withSandboxSlot(s)));
            // Troisième correction : refusée après son attente — la place restante est publique.
            assertThatThrownBy(() -> limiter.asInternal(() -> limiter.withSandboxSlot(() -> "non")))
                    .isInstanceOf(ExecutionBusyException.class)
                    .hasMessage(ExecutionBusyException.SANDBOX_BUSY);
            assertThat(limiter.availableSlots()).isEqualTo(1);
            // Un appel PUBLIC, lui, obtient la place réservée, sans attendre.
            assertThat(limiter.withSandboxSlot(() -> "public")).isEqualTo("public");
            release.countDown();
            assertThat(g1.get(5, TimeUnit.SECONDS)).isEqualTo("fini");
            assertThat(g2.get(5, TimeUnit.SECONDS)).isEqualTo("fini");
            // Places rendues des deux côtés : une correction repasse.
            assertThat(limiter.availableSlots()).isEqualTo(3);
            assertThat(limiter.asInternal(() -> limiter.withSandboxSlot(() -> "interne"))).isEqualTo("interne");
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void internal_context_is_visible_and_restored() {
        // Le mur du conteneur dépend de ce drapeau (public : plafond court).
        ExecutionLimiter limiter = new ExecutionLimiter(2, 0, 2);
        assertThat(limiter.isInternal()).isFalse();
        assertThat(limiter.asInternal(limiter::isInternal)).isTrue();
        assertThat(limiter.isInternal()).isFalse();
    }

    @Test
    void public_wait_does_not_exceed_configured_delay() throws Exception {
        // Les deux acquisitions (place publique puis place globale) partagent UNE échéance :
        // sinon l'appelant patientait jusqu'à 2 × queue-wait-ms avant son 429. Scénario qui les
        // exerce TOUTES LES DEUX : la place publique se libère à mi-délai, mais la place globale
        // qu'elle rend est aussitôt prise par une correction interne en attente — l'appel public
        // attend alors la globale, sur le RESTE du délai seulement.
        ExecutionLimiter limiter = new ExecutionLimiter(3, 600, 600, 5);   // 3 globales, 2 publiques
        ExecutorService pool = Executors.newFixedThreadPool(5);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        CountDownLatch releaseAll = new CountDownLatch(1);
        CountDownLatch internalStarted = new CountDownLatch(1);
        try {
            occupy(pool, releaseFirst, limiter::withSandboxSlot);          // publique 1, globale 1
            occupy(pool, releaseAll, limiter::withSandboxSlot);            // publique 2, globale 2
            occupy(pool, releaseAll, s -> limiter.asInternal(() -> limiter.withSandboxSlot(s)));  // globale 3
            pool.submit(() -> limiter.asInternal(() -> limiter.withSandboxSlot(() -> {   // attend une globale
                internalStarted.countDown();
                try {
                    releaseAll.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return "interne";
            })));
            pool.submit(() -> {
                Thread.sleep(300);
                releaseFirst.countDown();                                  // publique libérée à 300 ms
                return null;
            });
            long start = System.nanoTime();
            assertThatThrownBy(() -> limiter.withSandboxSlot(() -> "non"))
                    .isInstanceOf(ExecutionBusyException.class);
            long elapsedMs = (System.nanoTime() - start) / 1_000_000;
            // La place globale rendue est bien allée à la correction interne (scénario atteint).
            assertThat(internalStarted.await(1, TimeUnit.SECONDS)).isTrue();
            // Une échéance : ~600 ms. Deux attentes complètes : ~300 + 600 = 900 ms.
            assertThat(elapsedMs).isBetween(500L, 800L);
        } finally {
            releaseFirst.countDown();
            releaseAll.countDown();
            pool.shutdownNow();
        }
    }
}

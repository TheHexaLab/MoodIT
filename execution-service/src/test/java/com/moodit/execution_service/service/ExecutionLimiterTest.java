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
}

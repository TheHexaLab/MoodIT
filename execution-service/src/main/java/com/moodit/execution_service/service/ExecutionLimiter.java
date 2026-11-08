package com.moodit.execution_service.service;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * Bornes de charge du sandbox (#24), à deux niveaux :
 * <ul>
 *   <li><b>Globale</b> : au plus {@code maxConcurrent} conteneurs runner simultanés, tous appelants
 *       confondus (« Tester », « play », correction interne). Une exécution en trop attend une place
 *       au plus {@code queueWaitMs} (file d'attente courte), puis est refusée. La correction
 *       interne des soumissions ({@link #asInternal}) attend plus longtemps
 *       ({@code internalQueueWaitMs}) : un refus y fait échouer la tentative de l'étudiant.</li>
 *   <li><b>Par utilisateur</b> : au plus {@code maxPerUser} requêtes en cours par utilisateur. Une
 *       requête en trop est refusée tout de suite, sans attendre : un seul utilisateur ne peut pas
 *       occuper toutes les places globales en parallèle.</li>
 * </ul>
 * Un refus lève {@link ExecutionBusyException} (→ 429). Les compteurs sont en mémoire : ils
 * valent pour UNE instance d'execution-service.
 */
@Component
public class ExecutionLimiter {

    private final Semaphore global;
    /**
     * Places accessibles aux appels PUBLICS (« Tester », « play ») : {@code maxConcurrent - 1}
     * dès que possible — une place reste RÉSERVÉE aux corrections internes. Depuis le runner
     * (#116), une évaluation compilée tient sa place pendant toute la vie de son conteneur
     * (minutes) : sans réserve, deux « Tester » publics suffisaient à affamer les corrections
     * (tentatives d'étudiants supprimées en rafale). À {@code maxConcurrent = 1}, pas de
     * réserve possible : tout le monde partage l'unique place.
     */
    private final Semaphore publicCap;
    private final long queueWaitMs;
    private final long internalQueueWaitMs;
    private final int maxPerUser;
    /** Vrai pendant un appel interne (fil de la requête) : choisit l'attente longue. */
    private final ThreadLocal<Boolean> internalCall = ThreadLocal.withInitial(() -> false);
    private final Map<String, Integer> inFlightByUser = new ConcurrentHashMap<>();

    /** Attente interne identique à l'attente publique (tests). */
    public ExecutionLimiter(int maxConcurrent, long queueWaitMs, int maxPerUser) {
        this(maxConcurrent, queueWaitMs, queueWaitMs, maxPerUser);
    }

    @Autowired
    public ExecutionLimiter(
            @Value("${app.exec.max-concurrent:4}") int maxConcurrent,
            @Value("${app.exec.queue-wait-ms:5000}") long queueWaitMs,
            @Value("${app.exec.internal-queue-wait-ms:15000}") long internalQueueWaitMs,
            @Value("${app.exec.max-per-user:2}") int maxPerUser) {
        if (maxConcurrent < 1 || maxPerUser < 1 || queueWaitMs < 0 || internalQueueWaitMs < 0) {
            throw new IllegalArgumentException("Limites d'exécution invalides : max-concurrent et "
                    + "max-per-user ≥ 1, queue-wait-ms et internal-queue-wait-ms ≥ 0");
        }
        // Équitable : les exécutions en attente passent dans leur ordre d'arrivée.
        this.global = new Semaphore(maxConcurrent, true);
        this.publicCap = new Semaphore(Math.max(1, maxConcurrent - 1), true);
        this.queueWaitMs = queueWaitMs;
        this.internalQueueWaitMs = internalQueueWaitMs;
        this.maxPerUser = maxPerUser;
    }

    /**
     * Sommes-nous dans un appel INTERNE (correction d'une soumission par core-service) ?
     * Les appels publics (« Tester », « play ») sont plus sévèrement bornés : la route
     * {@code /exec/evaluate} est ouverte à tout authentifié.
     */
    public boolean isInternal() {
        return internalCall.get();
    }

    /**
     * Exécute {@code action} en occupant une place du sandbox (attente bornée, sinon refus).
     * Les appels publics passent d'abord par {@link #publicCap} : une place reste réservée
     * aux corrections internes.
     */
    public <T> T withSandboxSlot(Supplier<T> action) {
        boolean internal = internalCall.get();
        long waitMs = internal ? internalQueueWaitMs : queueWaitMs;
        boolean publicAcquired = false;
        try {
            if (!internal) {
                publicAcquired = publicCap.tryAcquire(waitMs, TimeUnit.MILLISECONDS);
                if (!publicAcquired) {
                    throw new ExecutionBusyException(ExecutionBusyException.SANDBOX_BUSY);
                }
            }
            if (!global.tryAcquire(waitMs, TimeUnit.MILLISECONDS)) {
                throw new ExecutionBusyException(ExecutionBusyException.SANDBOX_BUSY);
            }
            try {
                return action.get();
            } finally {
                global.release();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ExecutionBusyException(ExecutionBusyException.SANDBOX_BUSY);
        } finally {
            if (publicAcquired) {
                publicCap.release();
            }
        }
    }

    /**
     * Exécute {@code action} au compte de {@code user} : refus immédiat s'il a déjà
     * {@code maxPerUser} requêtes en cours. {@code user} vide ou nul (appel interne, déjà
     * authentifié par jeton) : pas de limite par utilisateur, seule la limite globale s'applique.
     */
    public <T> T forUser(String user, Supplier<T> action) {
        if (user == null || user.isBlank()) {
            return action.get();
        }
        boolean[] admitted = {false};
        inFlightByUser.compute(user, (u, n) -> {
            int current = n == null ? 0 : n;
            if (current >= maxPerUser) {
                return n;
            }
            admitted[0] = true;
            return current + 1;
        });
        if (!admitted[0]) {
            throw new ExecutionBusyException(ExecutionBusyException.USER_BUSY);
        }
        try {
            return action.get();
        } finally {
            // Retire l'entrée à zéro : la table ne grossit pas avec le nombre d'utilisateurs vus.
            inFlightByUser.computeIfPresent(user, (u, n) -> n <= 1 ? null : n - 1);
        }
    }

    /**
     * Exécute {@code action} comme appel INTERNE (correction des soumissions par core-service) :
     * pas de limite par utilisateur, et les places du sandbox sont attendues
     * {@code internalQueueWaitMs} au lieu de {@code queueWaitMs}.
     */
    public <T> T asInternal(Supplier<T> action) {
        boolean previous = internalCall.get();
        internalCall.set(true);
        try {
            return action.get();
        } finally {
            internalCall.set(previous);
        }
    }

    /** Requêtes en cours pour {@code user} (0 si aucune). Sert aux tests et au diagnostic. */
    int inFlight(String user) {
        return inFlightByUser.getOrDefault(user, 0);
    }

    /** Places libres du sandbox à cet instant. Sert aux tests et au diagnostic. */
    int availableSlots() {
        return global.availablePermits();
    }
}

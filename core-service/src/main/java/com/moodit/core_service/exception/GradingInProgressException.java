package com.moodit.core_service.exception;

/**
 * Soumission refusée parce qu'une correction d'une soumission de l'étudiant sur ce quiz est en
 * cours. Levée dans deux cas : une tentative {@code "pending"} ordinaire (pas une relance de
 * l'enseignant) existe déjà ; ou l'insert de la tentative a heurté une écriture CONCURRENTE du
 * même étudiant ({@code UNIQUE(quiz,user,attempt_no)} ou index partiel {@code uq_attempt_pending}),
 * même si le pending concurrent est déjà corrigé ou supprimé quand on relit. Mappée en 409 avec
 * un corps JSON {@code {"cause":"en_cours","message":…,"attemptId":…}} (cf.
 * GlobalExceptionHandler), distinct du 409 « tentative unique déjà consommée »
 * ({@link AlreadySubmittedException}, corps texte) : le frontend rejoint alors l'attente de la
 * correction en cours au lieu d'afficher « déjà soumis ».
 *
 * <p>{@link #getAttemptId()} : la tentative à attendre — le pending existant, ou après un conflit
 * d'insertion celle de l'écriture concurrente, relue (peut-être déjà corrigée) : la dernière de
 * l'étudiant, si son numéro atteint celui que la soumission refusée a tenté d'insérer.
 * {@code null} sinon — la concurrente a disparu entre-temps (correction abandonnée), ou c'était
 * une relance d'une ancienne tentative, finie avant la relecture : renvoyer l'id d'une ANCIENNE
 * tentative ferait ouvrir au client son résultat comme celui de l'envoi. Le champ est alors omis,
 * et le client retombe sur son repli (relecture de l'historique). Deviner la tentative par cette
 * relecture seule l'écartait quand la correction concurrente finissait avant elle.
 */
public class GradingInProgressException extends RuntimeException {

    /** Valeur du champ {@code cause} du corps de la réponse 409, lue par le frontend. */
    public static final String CAUSE = "en_cours";

    private final Integer attemptId;

    /** Tentative en conflit inconnue. */
    public GradingInProgressException() {
        this(null);
    }

    /** {@code attemptId} : la tentative que le client doit attendre ({@code null} si inconnue). */
    public GradingInProgressException(Integer attemptId) {
        super("Une correction de ce quiz est déjà en cours.");
        this.attemptId = attemptId;
    }

    /** Id de la tentative en conflit, {@code null} si inconnu. */
    public Integer getAttemptId() {
        return attemptId;
    }
}

package com.moodit.core_service.repository;

import com.moodit.core_service.model.AuditLog;
import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;
import jakarta.persistence.criteria.CriteriaBuilder;
import jakarta.persistence.criteria.CriteriaQuery;
import jakarta.persistence.criteria.Predicate;
import jakarta.persistence.criteria.Root;
import java.util.ArrayList;
import java.util.List;

/** Implémentation de {@link AuditLogRepositoryCustom} (nommage {@code …Impl} exigé par Spring Data). */
public class AuditLogRepositoryCustomImpl implements AuditLogRepositoryCustom {

    private final EntityManager em;

    public AuditLogRepositoryCustomImpl(EntityManager em) {
        this.em = em;
    }

    @Override
    public List<AuditLog> search(Integer beforeId, String type, String like, int limit) {
        return like == null
                ? cursorPage(beforeId, type, limit)
                : trigramSearch(beforeId, type, like, limit);
    }

    /**
     * Sans recherche : Criteria pur. {@code ORDER BY id DESC} + curseur {@code id < beforeId}
     * exploitent directement l'index de clé primaire (rapide, aucune matérialisation).
     */
    private List<AuditLog> cursorPage(Integer beforeId, String type, int limit) {
        CriteriaBuilder cb = em.getCriteriaBuilder();
        CriteriaQuery<AuditLog> cq = cb.createQuery(AuditLog.class);
        Root<AuditLog> a = cq.from(AuditLog.class);

        List<Predicate> preds = new ArrayList<>();
        if (beforeId != null) {
            preds.add(cb.lessThan(a.<Integer>get("id"), beforeId));
        }
        if (type != null) {
            preds.add(cb.equal(a.get("entityType"), type));
        }
        cq.where(preds.toArray(new Predicate[0]));
        cq.orderBy(cb.desc(a.get("id")));
        return em.createQuery(cq).setMaxResults(limit).getResultList();
    }

    /**
     * Avec recherche : une SOUS-REQUÊTE avec {@code OFFSET 0} matérialise D'ABORD les ids via le
     * bitmap OR des index GIN trigram (lower(summary|actor_email|details)), AVANT le tri/limite du
     * niveau supérieur. Sans ce « fence », le {@code ORDER BY id DESC LIMIT n} pousse le planificateur
     * Postgres à parcourir l'index PK en filtrant ligne à ligne (O(n), index trgm ignorés).
     * {@code OFFSET 0} est le fence portable historique (empêche l'aplatissement de la sous-requête) —
     * contrairement à un {@code CTE MATERIALIZED} non supporté par H2 (tests). Vérifié par EXPLAIN
     * ANALYZE (50k lignes) : bitmap trgm ~0,2 ms contre seq scan ~72 ms. {@code limit} est un int borné
     * (concaténation injection-safe).
     */
    @SuppressWarnings("unchecked")
    private List<AuditLog> trigramSearch(Integer beforeId, String type, String like, int limit) {
        Query q = em.createNativeQuery(buildSearchSql(beforeId, type, limit), AuditLog.class);
        q.setParameter("like", like);
        if (beforeId != null) {
            q.setParameter("beforeId", beforeId);
        }
        if (type != null) {
            q.setParameter("type", type);
        }
        return q.getResultList();
    }

    /**
     * Construit le SQL de recherche (paramètre {@code :like}, et {@code :beforeId}/{@code :type} si
     * fournis). Package-private : la garde de non-régression du plan ({@code AuditLogSearchPlanIT})
     * l'EXPLAIN telle quelle sur un vrai Postgres — si le fence {@code OFFSET 0} disparaît, l'IT casse.
     */
    static String buildSearchSql(Integer beforeId, String type, int limit) {
        StringBuilder sql =
                new StringBuilder(
                        "SELECT a.* FROM audit_log a"
                                + " JOIN (SELECT id FROM audit_log"
                                + " WHERE lower(summary) LIKE :like"
                                + " OR lower(actor_email) LIKE :like"
                                + " OR lower(details) LIKE :like"
                                + " OFFSET 0) m ON m.id = a.id");
        List<String> conds = new ArrayList<>();
        if (beforeId != null) {
            conds.add("a.id < :beforeId");
        }
        if (type != null) {
            conds.add("a.entity_type = :type");
        }
        if (!conds.isEmpty()) {
            sql.append(" WHERE ").append(String.join(" AND ", conds));
        }
        sql.append(" ORDER BY a.id DESC LIMIT ").append(limit);
        return sql.toString();
    }
}

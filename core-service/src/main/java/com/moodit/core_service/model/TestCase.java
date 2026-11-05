package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.Data;

/**
 * Harnais de test d'une question Code (table test_case). Deux formes selon la question (#116) :
 * <ul>
 *   <li><b>Harnais-code</b> ({@code harnessCode}) : code exécuté contre la soumission (interprétés,
 *       HTML/JSX/SQL). Écrit dans le langage {@code Language.harness_language_id} ou celui de la
 *       question.</li>
 *   <li><b>Cas structuré</b> ({@code expr} + {@code expectedJson} + {@code compareMode}) : évaluer
 *       l'EXPRESSION {@code expr} (qui renvoie la valeur testée) et comparer la sortie à l'attendu,
 *       HORS sandbox — les attendus ne sont jamais exposés au code étudiant (requis pour les compilés).</li>
 * </ul>
 * {@code weight} = crédit partiel. DONNÉES CACHÉES : jamais exposées au répondant.
 */
@Entity
@Data
@Table(name = "test_case")
public class TestCase {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @Column(nullable = false, length = 128)
    private String name;

    /** Harnais-code (forme classique) — {@code null} pour une question à cas structurés. */
    @Column(name = "harness_code", columnDefinition = "TEXT")
    private String harnessCode;

    /**
     * CAS STRUCTURÉ (#116) : EXPRESSION (dans le langage de la question) qui RENVOIE la valeur testée
     * — appel de fonction, construction d'objet + méthode, séquence. {@code expr} renseigné ⇒ cas
     * structuré : évalué dans un serveur, sa sortie est comparée à {@code expectedJson} HORS sandbox.
     */
    @Column(columnDefinition = "TEXT")
    private String expr;

    /** Valeur attendue du cas structuré, en JSON. */
    @Column(name = "expected_json", columnDefinition = "TEXT")
    private String expectedJson;

    /** Mode de comparaison d'un cas structuré : {@code exact} (défaut), relationnels
     *  {@code gt}/{@code ge}/{@code lt}/{@code le}, {@code ne}, {@code contains}/{@code regex},
     *  {@code unordered}, {@code compound} (combinaison ET/OU). Interprété par execution-service. */
    @Column(name = "compare_mode", length = 20)
    private String compareMode;

    @Column(nullable = false)
    private Integer weight;

    @ManyToOne
    @JoinColumn(name = "question_id", nullable = false)
    private Question question;
}

package com.moodit.core_service.model;
import jakarta.persistence.*;
import lombok.Data;
import org.hibernate.annotations.BatchSize;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.SourceType;

import java.time.LocalDateTime;
import java.util.List;

// @BatchSize (niveau classe) : quand des Post sont chargés comme association (ex. le `parent`
// self-ref d'une page de messages), Hibernate les initialise PAR LOTS (IN (...)) au lieu d'un
// SELECT par élément → atténue le N+1 de toPostVoteUserDTO. Additif, ne change aucun comportement.
@Entity
@Data
@Table(name = "post")
@BatchSize(size = 50)
public class Post {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    /**
     * Horodatage généré par la BASE DE DONNÉES (même horloge que les posts seedés via
     * DEFAULT NOW()) : garantit un ordre chronologique cohérent, indépendamment du fuseau
     * de la JVM.
     */
    @CreationTimestamp(source = SourceType.DB)
    @Column(name = "created_at", updatable = false)
    private LocalDateTime createdAt;

    @Column(nullable = false, columnDefinition = "TEXT")
    private String content;

    /** Titre d'un sujet RACINE de forum 'Thread' ; null pour une réponse / un message de canal. */
    @Column(length = 256)
    private String title;

    @Column(name = "is_pinned")
    private Boolean isPinned = false;

    @ManyToOne
    @JoinColumn(name = "forum_id", nullable = false)
    private Forum forum;

    @ManyToOne
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    @ManyToOne
    @JoinColumn(name = "post_parent_id")
    private Post parent;

    // Ordre EXPLICITE des réponses : ancien → récent. Garantit un placement cohérent (les
    // nouvelles réponses, optimistes ou reçues en WebSocket, sont ajoutées en fin côté front).
    // @BatchSize : childrenCount d'une page de posts chargé par lots au lieu d'1 requête/post.
    @OneToMany(mappedBy = "parent", cascade = CascadeType.REMOVE, orphanRemoval = true)
    @OrderBy("createdAt ASC, id ASC")
    @BatchSize(size = 50)
    private List<Post> children;

    // @BatchSize : votes d'une page de posts chargés par lots (sum + vote propre) au lieu d'1/post.
    @OneToMany(mappedBy = "post", cascade = CascadeType.REMOVE, orphanRemoval = true)
    @BatchSize(size = 50)
    private List<Vote> votes;
}
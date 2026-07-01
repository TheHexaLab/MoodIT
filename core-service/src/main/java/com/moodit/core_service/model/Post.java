package com.moodit.core_service.model;
import jakarta.persistence.*;
import lombok.Data;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.SourceType;

import java.time.LocalDateTime;
import java.util.List;

@Entity
@Data
@Table(name = "post")
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

    @OneToMany(mappedBy = "parent", cascade = CascadeType.REMOVE, orphanRemoval = true)
    private List<Post> children;

    @OneToMany(mappedBy = "post", cascade = CascadeType.REMOVE, orphanRemoval = true)
    private List<Vote> votes;
}
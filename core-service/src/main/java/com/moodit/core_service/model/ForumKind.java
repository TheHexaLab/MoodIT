package com.moodit.core_service.model;

import java.util.Arrays;

/**
 * Types de forum (F_Type.name), en un seul endroit. Le type du FORUM décide des règles d'un post
 * (validation, temps réel, sections) : ajouter un type = une constante ici, puis le compilateur
 * signale chaque `switch` qui ne le traite pas encore.
 */
public enum ForumKind {
    /** Canal de discussion (chat) : section 'text' du cours. */
    DISCUSSION("Discussion"),
    /** Forum de sujets + réponses : section 'forum' du cours. */
    THREAD("Thread"),
    /** Canal d'annonces : un par cours, créé avec lui, hors sections. */
    ANNOUNCEMENT("Announcement");

    private final String typeName;

    ForumKind(String typeName) {
        this.typeName = typeName;
    }

    public String typeName() {
        return typeName;
    }

    /** Type d'un forum ; un type inconnu ou absent est traité comme un forum 'Thread'. */
    public static ForumKind of(Forum forum) {
        String name = forum.getFType() == null ? null : forum.getFType().getName();
        return Arrays.stream(values()).filter(k -> k.typeName.equals(name)).findFirst().orElse(THREAD);
    }
}

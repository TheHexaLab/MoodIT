package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.Data;

/**
 * Élément déplaçable (table Drag_Item), partagé par deux types :
 * ordering → `correctOrder` = position attendue ; matching → `groupName` = catégorie.
 */
@Entity
@Data
@Table(name = "drag_item")
public class DragItem {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Integer id;

    @Column(nullable = false, length = 256)
    private String content;

    @Column(name = "correct_order", nullable = false)
    private Integer correctOrder;

    @Column(name = "group_name", length = 128)
    private String groupName;

    @ManyToOne
    @JoinColumn(name = "question_id", nullable = false)
    private Question question;
}

package com.moodit.core_service.dto;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

// Corps de POST /forums/posts/votes, validé par @Valid (400 si invalide).
@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class VoteCreateInPostDTO {
    /** 1 (pour) ou -1 (contre) ; revoter la même valeur retire le vote. */
    @NotNull @Min(-1) @Max(1)
    private Integer voteValue;
    @NotNull @Positive
    private Integer postId;
    /** Lu par le permission-service ; le post doit appartenir à ce forum (sinon 404). */
    @NotNull @Positive
    private Integer forumId;

    /** 0 n'est pas un vote : seules les valeurs 1 et -1 sont acceptées. */
    @AssertTrue(message = "La valeur du vote doit être 1 ou -1.")
    private boolean isVoteValueNonZero() {
        return voteValue == null || voteValue != 0;
    }
}

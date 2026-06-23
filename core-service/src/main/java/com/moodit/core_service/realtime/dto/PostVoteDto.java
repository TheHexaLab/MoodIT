// Vote sur un post (table Vote) : value ∈ {-1, 1}.

package com.moodit.core_service.realtime.dto;

public record PostVoteDto(long userId, int value) {}

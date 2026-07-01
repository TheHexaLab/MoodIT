// Quiz embarqué dans un cours poussé en temps réel (section « Quiz »).

package com.moodit.core_service.realtime.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record QuizSectionDto(long id, String title, Integer position) {}

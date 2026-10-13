package com.moodit.core_service.service;

import java.util.List;

/**
 * Des forums ont ete supprimes (seuls, via l'editeur de section, ou avec leur cours). Publie
 * DANS la transaction ; les ecouteurs agissent apres commit. Sert au vocal : les salons LiveKit
 * des canaux supprimes sont fermes (cf. voice/VoiceChannelCloser). Sans ecouteur (vocal
 * desactive), l'evenement est simplement ignore.
 */
public record ForumsDeletedEvent(List<Integer> forumIds) {}

package com.moodit.auth_service.service;

import com.moodit.auth_service.repository.PendingRegistrationRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;

@Component
@RequiredArgsConstructor
public class CleanupJob {

  private final PendingRegistrationRepository pendingRepository;

  // Supprime les inscriptions en attente dont le code a expiré, pour que la
  // table de staging ne se fasse pas flooder à son tour.
  @Scheduled(fixedRate = 3600000) // toutes les heures
  @Transactional
  public void purgeExpiredPending() {
    pendingRepository.deleteExpired(LocalDateTime.now());
  }
}

package com.moodit.auth_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.verify;

import com.moodit.auth_service.repository.PendingRegistrationRepository;
import java.time.LocalDateTime;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class CleanupJobTest {

  @Mock private PendingRegistrationRepository pendingRepository;

  @InjectMocks private CleanupJob cleanupJob;

  @Test
  void purgeExpiredPending_deletesPendingsExpiredBeforeNow() {
    // La purge doit cibler les codes expirés à l'instant de l'exécution (ni passé, ni futur).
    LocalDateTime before = LocalDateTime.now();

    cleanupJob.purgeExpiredPending();

    LocalDateTime after = LocalDateTime.now();
    ArgumentCaptor<LocalDateTime> captor = ArgumentCaptor.forClass(LocalDateTime.class);
    verify(pendingRepository).deleteExpired(captor.capture());
    assertThat(captor.getValue()).isBetween(before, after);
  }
}

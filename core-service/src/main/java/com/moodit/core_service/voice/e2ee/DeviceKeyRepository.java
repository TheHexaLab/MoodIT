package com.moodit.core_service.voice.e2ee;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface DeviceKeyRepository extends JpaRepository<DeviceKey, Integer> {

  /** Appareil + propriétaire chargés ensemble (l'appelant lit presque toujours user). */
  @Query("SELECT d FROM DeviceKey d JOIN FETCH d.user WHERE d.deviceId = :deviceId")
  Optional<DeviceKey> findByDeviceId(@Param("deviceId") UUID deviceId);

  List<DeviceKey> findByUser_EmailOrderByCreatedAtDesc(String email);

  long countByUser_IdAndRevokedAtIsNull(Integer userId);
}

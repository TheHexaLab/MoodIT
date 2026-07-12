// Acces aux users (lecture seule) pour resoudre les roles a partir de l'email.

package com.moodit.permission_service.repository;

import com.moodit.permission_service.model.User;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface UserRepository extends JpaRepository<User, Integer> {

  Optional<User> findByEmail(String email);
}

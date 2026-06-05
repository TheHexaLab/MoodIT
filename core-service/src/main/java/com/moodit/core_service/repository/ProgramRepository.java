//S'occupe de faire les requêtes - JPA s'occupe de quelques commandes de bases
/*
Lecture
    findAll()
    findById(Long id)
    findAll(Sort sort)
    findAll(Pageable pageable)
    count()

Écriture
    save(User user)
    saveAll(List<User> users)

Suppression
    deleteById(Long id)
    delete(User user)
    deleteAll()

Vérification
    existsById(Long id)
*/

package com.moodit.core_service.repository;

//Model
import com.moodit.core_service.model.Program;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface ProgramRepository extends JpaRepository<Program, Integer> {

    Optional<Program> findById(Integer id);

}

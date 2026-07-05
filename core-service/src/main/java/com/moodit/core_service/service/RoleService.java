package com.moodit.core_service.service;

import com.moodit.core_service.dto.RoleDTO;
import com.moodit.core_service.model.Role;
import com.moodit.core_service.repository.RoleRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class RoleService {

    private final RoleRepository roleRepository;

    public List<RoleDTO> findAll() {
        return roleRepository.findAll()
                .stream()
                .map(this::toDTO)
                .toList();
    }

    private RoleDTO toDTO(Role role) {
        return RoleDTO.builder()
                .id(role.getId())
                .name(role.getName())
                .build();
    }
}
package com.moodit.core_service.service;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import com.moodit.core_service.model.Program;
import com.moodit.core_service.repository.ProgramRepository;

import java.util.List;

//Le pont entre le Controller et le Repository
@Service
@RequiredArgsConstructor
public class ProgramService {

    private final ProgramRepository programRepository;

    public List<Program> getAllPrograms() {
        return programRepository.findAll();
    }
}
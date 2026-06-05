package com.moodit.core_service.service;

//Model
import com.moodit.core_service.model.Forum;

//Repository
import com.moodit.core_service.repository.ForumRepository;

import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import com.moodit.core_service.repository.ProgramRepository;
import java.util.List;

//Le pont entre le Controller et le Repository
@Service
@RequiredArgsConstructor
public class ForumService {

    private final ForumRepository programRepository;
}
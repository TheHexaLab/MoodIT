package com.moodit.core_service.service;

//Model
import com.moodit.core_service.model.User;

//Repository
import com.moodit.core_service.repository.UserRepository;

import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import java.util.List;

//Le pont entre le Controller et le Repository
@Service
@RequiredArgsConstructor
public class UserService {

    private final UserRepository userRepository;

}
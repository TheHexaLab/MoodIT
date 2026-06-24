// Points de decision (PDP) consultes par les points d'application (PEP) :
//   - POST /permissions/validate  : requetes REST  (consulte par le gateway, JwtAuthFilter)
//   - POST /permissions/can-join  : rooms WebSocket (consulte a terme par le core RoomAuthorizer)

package com.moodit.permission_service.controller;

import com.moodit.permission_service.dto.CanJoinRequest;
import com.moodit.permission_service.dto.ValidateRequest;
import com.moodit.permission_service.dto.ValidateResponse;
import com.moodit.permission_service.service.MembershipService;
import com.moodit.permission_service.service.PermissionService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/permissions")
public class PermissionController {

  private final PermissionService permissionService;
  private final MembershipService membershipService;

  public PermissionController(
      PermissionService permissionService, MembershipService membershipService) {
    this.permissionService = permissionService;
    this.membershipService = membershipService;
  }

  @PostMapping("/validate")
  public ResponseEntity<ValidateResponse> validate(@Valid @RequestBody ValidateRequest request) {
    boolean allowed =
        permissionService.isAllowed(request.getEmail(), request.getPath(), request.getMethod());
    return ResponseEntity.ok(new ValidateResponse(allowed));
  }

  @PostMapping("/can-join")
  public ResponseEntity<ValidateResponse> canJoin(@Valid @RequestBody CanJoinRequest request) {
    boolean allowed =
        membershipService.canJoin(request.getEmail(), request.getScope(), request.getId());
    return ResponseEntity.ok(new ValidateResponse(allowed));
  }
}

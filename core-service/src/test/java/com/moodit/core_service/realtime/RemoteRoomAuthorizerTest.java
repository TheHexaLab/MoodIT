// Verifie la delegation du canJoin au permission-service via /permissions/can-join :
// allowed=true -> true, allowed=false -> false, service injoignable -> false (fail-closed),
// email vide -> false sans appel.

package com.moodit.core_service.realtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.client.RestClient;

class RemoteRoomAuthorizerTest {

  private RemoteRoomAuthorizer authorizer;
  private RestClient.ResponseSpec responseSpec;

  @BeforeEach
  void setUp() {
    authorizer = new RemoteRoomAuthorizer("http://localhost:8084");

    RestClient restClient = mock(RestClient.class);
    RestClient.RequestBodyUriSpec uriSpec = mock(RestClient.RequestBodyUriSpec.class);
    RestClient.RequestBodySpec bodySpec = mock(RestClient.RequestBodySpec.class);
    responseSpec = mock(RestClient.ResponseSpec.class);
    when(restClient.post()).thenReturn(uriSpec);
    when(uriSpec.uri(anyString())).thenReturn(bodySpec);
    when(bodySpec.body(any(Object.class))).thenReturn(bodySpec);
    when(bodySpec.retrieve()).thenReturn(responseSpec);
    ReflectionTestUtils.setField(authorizer, "restClient", restClient);
  }

  @Test
  void permissionAutorise_renvoieTrue() {
    when(responseSpec.body(Map.class)).thenReturn(Map.of("allowed", true));
    assertThat(authorizer.canJoin("user@usherbrooke.ca", "channel", 42)).isTrue();
  }

  @Test
  void permissionRefuse_renvoieFalse() {
    when(responseSpec.body(Map.class)).thenReturn(Map.of("allowed", false));
    assertThat(authorizer.canJoin("user@usherbrooke.ca", "channel", 42)).isFalse();
  }

  @Test
  void permissionInjoignable_renvoieFalse() {
    when(responseSpec.body(Map.class)).thenThrow(new RuntimeException("permission down"));
    assertThat(authorizer.canJoin("user@usherbrooke.ca", "channel", 42)).isFalse();
  }

  @Test
  void emailVide_renvoieFalse() {
    assertThat(authorizer.canJoin("", "channel", 42)).isFalse();
  }
}

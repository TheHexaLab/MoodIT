// Wrapper de requête qui expose le header X-User-Email (email extrait du JWT) aux services en aval.

package com.moodit.gateway.filter;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;

public class WrappedRequest extends HttpServletRequestWrapper {

  private static final String USER_EMAIL = "X-User-Email";
  private final String userEmail;

  public WrappedRequest(HttpServletRequest request, String userEmail) {
    super(request);
    this.userEmail = userEmail;
  }

  @Override
  public String getHeader(String name) {
    if (USER_EMAIL.equalsIgnoreCase(name)) {
      return userEmail;
    }
    return super.getHeader(name);
  }

  @Override
  public Enumeration<String> getHeaders(String name) {
    if (USER_EMAIL.equalsIgnoreCase(name)) {
      return Collections.enumeration(List.of(userEmail));
    }
    return super.getHeaders(name);
  }

  @Override
  public Enumeration<String> getHeaderNames() {
    List<String> names = new ArrayList<>(Collections.list(super.getHeaderNames()));
    names.removeIf(USER_EMAIL::equalsIgnoreCase);
    names.add(USER_EMAIL);
    return Collections.enumeration(names);
  }
}

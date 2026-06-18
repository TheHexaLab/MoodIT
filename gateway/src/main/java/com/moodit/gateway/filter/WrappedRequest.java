// Wrapper de requête qui expose le header X-User-Email (email extrait du JWT) aux services en aval.

package com.moodit.gateway.filter;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;

public class WrappedRequest extends HttpServletRequestWrapper {

  private final String userEmail;

  public WrappedRequest(HttpServletRequest request, String userEmail) {
    super(request);
    this.userEmail = userEmail;
  }

  @Override
  public String getHeader(String name) {
    if ("X-User-Email".equalsIgnoreCase(name)) {
      return userEmail;
    }
    return super.getHeader(name);
  }
}

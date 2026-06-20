// Wrapper de requête qui masque complètement un header entrant (singulier + pluriel + liste des noms).
// Sert à neutraliser un X-User-Email forgé par le client avant qu'il n'atteigne un service en aval.

package com.moodit.gateway.filter;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;

public class StrippedHeaderRequest extends HttpServletRequestWrapper {

  private final String strippedHeader;

  public StrippedHeaderRequest(HttpServletRequest request, String strippedHeader) {
    super(request);
    this.strippedHeader = strippedHeader;
  }

  @Override
  public String getHeader(String name) {
    if (strippedHeader.equalsIgnoreCase(name)) {
      return null;
    }
    return super.getHeader(name);
  }

  @Override
  public Enumeration<String> getHeaders(String name) {
    if (strippedHeader.equalsIgnoreCase(name)) {
      return Collections.emptyEnumeration();
    }
    return super.getHeaders(name);
  }

  @Override
  public Enumeration<String> getHeaderNames() {
    List<String> names = new ArrayList<>(Collections.list(super.getHeaderNames()));
    names.removeIf(strippedHeader::equalsIgnoreCase);
    return Collections.enumeration(names);
  }
}

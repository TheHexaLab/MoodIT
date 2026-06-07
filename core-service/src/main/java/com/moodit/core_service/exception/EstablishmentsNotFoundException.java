package com.moodit.core_service.exception;

public class EstablishmentsNotFoundException extends RuntimeException {
  public EstablishmentsNotFoundException() {
    super("Establishments not found");
  }
}

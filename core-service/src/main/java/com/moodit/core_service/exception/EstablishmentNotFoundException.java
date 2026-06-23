package com.moodit.core_service.exception;

public class EstablishmentNotFoundException extends RuntimeException {
  public EstablishmentNotFoundException() {
    super("Establishments not found");
  }
}

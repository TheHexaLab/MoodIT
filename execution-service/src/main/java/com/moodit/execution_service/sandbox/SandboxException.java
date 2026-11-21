package com.moodit.execution_service.sandbox;

/** Sandbox Docker de notation injoignable ou en erreur (image absente, démon arrêté, timeout). */
public class SandboxException extends RuntimeException {
    public SandboxException(String message) {
        super(message);
    }

    public SandboxException(String message, Throwable cause) {
        super(message, cause);
    }
}

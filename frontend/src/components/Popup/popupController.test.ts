import { describe, expect, it, vi } from 'vitest';
import { PopupController } from './popupController';

describe('PopupController', () => {
  it('sans popup liée : exécute immédiatement l’action fournie', () => {
    const controller = new PopupController();
    const action = vi.fn();
    controller.requestClose(action);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('sans popup liée et sans action : ne fait rien (pas d’erreur)', () => {
    const controller = new PopupController();
    expect(() => controller.requestClose()).not.toThrow();
  });

  it('liée : délègue à la popup (avec ou sans action) sans exécuter l’action elle-même', () => {
    const controller = new PopupController();
    const impl = vi.fn();
    const action = vi.fn();
    controller.bind(impl);
    controller.requestClose(action);
    expect(impl).toHaveBeenCalledWith(action);
    expect(action).not.toHaveBeenCalled();
    controller.requestClose();
    expect(impl).toHaveBeenLastCalledWith(undefined);
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('déliée (bind(null)) : revient à l’exécution immédiate', () => {
    const controller = new PopupController();
    const impl = vi.fn();
    controller.bind(impl);
    controller.bind(null);
    const action = vi.fn();
    controller.requestClose(action);
    expect(action).toHaveBeenCalledTimes(1);
    expect(impl).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import NoProgramState from './NoProgramState';
import { defaultLabels } from './labels';

afterEach(cleanup);

describe('NoProgramState', () => {
  it('utilisateur : titre, sous-titre utilisateur et seul le bouton « rejoindre »', () => {
    render(<NoProgramState />);
    expect(screen.getByRole('heading', { name: defaultLabels.title })).toBeTruthy();
    expect(screen.getByText(defaultLabels.userSubtitle)).toBeTruthy();
    expect(screen.queryByText(defaultLabels.adminSubtitle)).toBeNull();
    expect(screen.getByRole('button', { name: `+${defaultLabels.joinProgram}` })).toBeTruthy();
    expect(screen.queryByRole('button', { name: `+${defaultLabels.addProgram}` })).toBeNull();
  });

  it('admin : sous-titre admin et bouton « ajouter un programme » en plus', () => {
    render(<NoProgramState isAdmin />);
    expect(screen.getByText(defaultLabels.adminSubtitle)).toBeTruthy();
    expect(screen.queryByText(defaultLabels.userSubtitle)).toBeNull();
    expect(screen.getAllByRole('button').length).toBe(2);
  });

  it('chaque bouton appelle son propre callback', () => {
    const onJoinProgram = vi.fn();
    const onAddProgram = vi.fn();
    render(<NoProgramState isAdmin onJoinProgram={onJoinProgram} onAddProgram={onAddProgram} />);
    fireEvent.click(screen.getByRole('button', { name: `+${defaultLabels.joinProgram}` }));
    expect(onJoinProgram).toHaveBeenCalledTimes(1);
    expect(onAddProgram).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: `+${defaultLabels.addProgram}` }));
    expect(onAddProgram).toHaveBeenCalledTimes(1);
  });

  it('les libellés fournis remplacent les défauts, les autres restent', () => {
    render(<NoProgramState labels={{ title: 'Salut' }} />);
    expect(screen.getByRole('heading', { name: 'Salut' })).toBeTruthy();
    expect(screen.getByText(defaultLabels.userSubtitle)).toBeTruthy();
  });
});

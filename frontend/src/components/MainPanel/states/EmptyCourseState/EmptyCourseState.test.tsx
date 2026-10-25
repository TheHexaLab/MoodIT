import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import EmptyCourseState from './EmptyCourseState';
import { defaultLabels } from './labels';

afterEach(cleanup);

describe('EmptyCourseState', () => {
  it('utilisateur : sous-titre utilisateur et aucun bouton de création', () => {
    render(<EmptyCourseState />);
    expect(screen.getByRole('heading', { name: defaultLabels.title })).toBeTruthy();
    expect(screen.getByText(defaultLabels.userSubtitle)).toBeTruthy();
    expect(screen.queryAllByRole('button').length).toBe(0);
  });

  it('admin : trois boutons de création reliés chacun à son callback', () => {
    const onCreateChannel = vi.fn();
    const onCreateQuiz = vi.fn();
    const onCreateForum = vi.fn();
    render(
      <EmptyCourseState
        isAdmin
        onCreateChannel={onCreateChannel}
        onCreateQuiz={onCreateQuiz}
        onCreateForum={onCreateForum}
      />
    );
    expect(screen.getByText(defaultLabels.adminSubtitle)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `+${defaultLabels.createQuiz}` }));
    expect(onCreateQuiz).toHaveBeenCalledTimes(1);
    expect(onCreateChannel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: `+${defaultLabels.createChannel}` }));
    expect(onCreateChannel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: `+${defaultLabels.createForum}` }));
    expect(onCreateForum).toHaveBeenCalledTimes(1);
  });

  it('surcharge partielle des libellés', () => {
    render(<EmptyCourseState labels={{ title: 'Rien ici' }} />);
    expect(screen.getByRole('heading', { name: 'Rien ici' })).toBeTruthy();
    expect(screen.getByText(defaultLabels.userSubtitle)).toBeTruthy();
  });
});

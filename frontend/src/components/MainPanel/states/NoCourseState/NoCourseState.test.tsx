import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import NoCourseState from './NoCourseState';
import { defaultLabels } from './labels';

afterEach(cleanup);

describe('NoCourseState', () => {
  it('utilisateur : sous-titre utilisateur et seul le bouton « rejoindre un cours »', () => {
    render(<NoCourseState />);
    expect(screen.getByRole('heading', { name: defaultLabels.title })).toBeTruthy();
    expect(screen.getByText(defaultLabels.userSubtitle)).toBeTruthy();
    expect(screen.getByRole('button', { name: `+${defaultLabels.joinCourse}` })).toBeTruthy();
    expect(screen.queryByRole('button', { name: `+${defaultLabels.addCourse}` })).toBeNull();
  });

  it('admin : sous-titre admin et les deux boutons appellent leur callback', () => {
    const onJoinCourse = vi.fn();
    const onAddCourse = vi.fn();
    render(<NoCourseState isAdmin onJoinCourse={onJoinCourse} onAddCourse={onAddCourse} />);
    expect(screen.getByText(defaultLabels.adminSubtitle)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `+${defaultLabels.addCourse}` }));
    expect(onAddCourse).toHaveBeenCalledTimes(1);
    expect(onJoinCourse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: `+${defaultLabels.joinCourse}` }));
    expect(onJoinCourse).toHaveBeenCalledTimes(1);
  });

  it('surcharge partielle des libellés', () => {
    render(<NoCourseState labels={{ joinCourse: 'Entrer' }} />);
    expect(screen.getByRole('button', { name: '+Entrer' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: defaultLabels.title })).toBeTruthy();
  });
});

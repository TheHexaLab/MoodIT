import { describe, it, expect } from 'vitest';
import { getMockForumThreads, getMockForumReplies } from './forumThreads.ts';

describe('getMockForumThreads', () => {
  it('retourne les sujets racines du forum 3', () => {
    const threads = getMockForumThreads(3);
    expect(threads.map((t) => t.id)).toEqual([101, 102, 106, 120]);
  });

  it('retourne les sujets racines du forum 4', () => {
    const threads = getMockForumThreads(4);
    expect(threads.map((t) => t.id)).toEqual([201, 203]);
  });

  it('retourne un tableau vide pour un forum sans mock', () => {
    expect(getMockForumThreads(999)).toEqual([]);
  });

  it('retourne un tableau vide pour un id négatif ou nul', () => {
    expect(getMockForumThreads(0)).toEqual([]);
    expect(getMockForumThreads(-1)).toEqual([]);
  });

  it('retire replies et expose replyCount (chargement paresseux)', () => {
    const threads = getMockForumThreads(3);
    for (const t of threads) {
      expect('replies' in t).toBe(false);
      expect(typeof t.replyCount).toBe('number');
    }
  });

  it('calcule replyCount = nombre d\'enfants immédiats', () => {
    const threads = getMockForumThreads(3);
    const byId = new Map(threads.map((t) => [t.id, t]));
    expect(byId.get(101)?.replyCount).toBe(0); // pas de réponse
    expect(byId.get(102)?.replyCount).toBe(2); // 103 et 105
    expect(byId.get(106)?.replyCount).toBe(1); // 107
    expect(byId.get(120)?.replyCount).toBe(1); // 121
  });

  it('conserve les métadonnées du sujet (title, author, isPinned)', () => {
    const [pinned] = getMockForumThreads(3);
    expect(pinned.id).toBe(101);
    expect(pinned.isPinned).toBe(true);
    expect(pinned.title).toContain('À lire');
    expect(pinned.author.username).toBe('admin');
  });

  it('conserve les votes du sujet racine', () => {
    const threads = getMockForumThreads(3);
    const post102 = threads.find((t) => t.id === 102);
    expect(post102?.votes).toHaveLength(4);
  });

  it('ne partage pas de référence replies (shallow copy indépendante)', () => {
    const a = getMockForumThreads(3);
    const b = getMockForumThreads(3);
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
    expect(a).toEqual(b);
  });
});

describe('getMockForumReplies', () => {
  it('retourne les réponses directes d\'un post (enfants immédiats)', () => {
    const replies = getMockForumReplies(102);
    expect(replies.map((r) => r.id)).toEqual([103, 105]);
  });

  it('ne retourne QUE les enfants immédiats, pas les petits-enfants', () => {
    const replies = getMockForumReplies(102);
    // 103 a un enfant 104 : il ne doit pas apparaître au premier niveau
    expect(replies.map((r) => r.id)).not.toContain(104);
  });

  it('retourne replyCount des réponses sans leurs propres replies', () => {
    const replies = getMockForumReplies(102);
    const byId = new Map(replies.map((r) => [r.id, r]));
    expect(byId.get(103)?.replyCount).toBe(1); // 104
    expect(byId.get(105)?.replyCount).toBe(0);
    for (const r of replies) {
      expect('replies' in r).toBe(false);
    }
  });

  it('retrouve un post profondément imbriqué (parcours en profondeur)', () => {
    const replies = getMockForumReplies(123); // niveau 3 du fil 120
    expect(replies.map((r) => r.id)).toEqual([124]);
  });

  it('gère un post trouvé dans un autre forum (forum 4)', () => {
    const replies = getMockForumReplies(201);
    expect(replies.map((r) => r.id)).toEqual([202]);
  });

  it('retourne un tableau vide pour un post sans réponse', () => {
    expect(getMockForumReplies(101)).toEqual([]);
    expect(getMockForumReplies(104)).toEqual([]);
  });

  it('retourne un tableau vide pour un id inconnu', () => {
    expect(getMockForumReplies(999999)).toEqual([]);
    expect(getMockForumReplies(-1)).toEqual([]);
  });

  it('gère un post dont replies est vide (feuille) sans erreur', () => {
    // 130 est la feuille finale de la branche profonde du fil 120
    expect(getMockForumReplies(130)).toEqual([]);
  });

  it('conserve le contenu et l\'auteur des réponses', () => {
    const [first] = getMockForumReplies(102);
    expect(first.id).toBe(103);
    expect(first.author.username).toBe('mich1234');
    expect(first.content).toContain('Sauvegarde');
  });

  it('retourne des copies indépendantes à chaque appel', () => {
    const a = getMockForumReplies(102);
    const b = getMockForumReplies(102);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// /Friends/games-registry.js
// Единый список игр, доступных для приглашения друзей.
// Добавление новой игры = одна строка.

export const PLAYABLE_GAMES = [
  {
    id: 'war_hearts',
    title: 'Война Сердец',
    icon: '💔',
    inviteSupported: true,
    launchPath: '/Games/?gcGame=war_hearts'
  }
];

export const getPlayableGames = () => PLAYABLE_GAMES.filter(g => g.inviteSupported);

export const findGame = id => PLAYABLE_GAMES.find(g => g.id === id) || null;

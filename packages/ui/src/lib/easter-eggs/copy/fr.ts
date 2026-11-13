import type { EasterEggCopy } from './types';

export const copy: EasterEggCopy = {
  draftTitle: {
    everyday: [
      'Sur quoi travaillons-nous dans {project} ?',
      'Quelle est la suite pour {project} ?',
      "Que construisons-nous aujourd'hui dans {project} ?",
      'Un bug ou une idée ? Les deux conviennent pour {project}.',
      'Par où commence-t-on dans {project} ?',
    ],
    deepNight: [
      'Encore debout ? Sur quoi travaillons-nous dans {project} ?',
      "L'équipe de nuit est ouverte. Quoi de neuf dans {project} ?",
      'Tout le monde dort, sauf nous et {project}.',
      'Les bugs dorment aussi. On les attrape dans {project} ?',
      'Nuit tardive, esprit clair. Quelle suite pour {project} ?',
      'Heures calmes. Le bon moment pour {project}.',
    ],
    halloween: [
      "Qu'invoquons-nous aujourd'hui dans {project} ?",
      'Quels bugs hantent {project} ?',
    ],
    newYearsEve: ["Une dernière chose pour {project} avant la fin de l'année ?"],
    newYearsDay: ['Par quoi {project} commence-t-il cette année ?'],
  },
  gitClean: {
    everyday: [
      'Étrangement propre.',
      "Rien à committer. Profitons du calme tant qu'il dure.",
      'Impeccable. Il est temps de mettre un peu de désordre.',
      'Allez-y, quelques prompts et les changements viendront.',
      'Tout est commité. La pause café est officiellement autorisée.',
    ],
    halloween: ['Rien à committer. Rien à craindre.'],
    newYearsEve: ["Un arbre propre pour finir l'année."],
    newYearsDay: ['Un départ propre pour la nouvelle année.'],
  },
  push: {
    fridayEvening: [
      { title: 'Audacieux.', description: "Un push le vendredi soir. La légende dit que c'est ainsi que les week-ends s'annulent." },
      { title: 'Coup audacieux.', description: "Un push le vendredi soir. Que l'astreinte reste calme." },
      { title: 'Poussé droit dans le week-end.', description: "Espérons qu'il ne vous y suive pas." },
      { title: 'Push du vendredi accepté.', description: 'Le week-end a été prévenu.' },
      { title: 'Poussé.', description: "Le vendredi soir, tout le monde n'ose pas." },
    ],
    smallHours: [
      { title: 'Poussé à {time}.', description: 'Le repos est bien mérité.' },
      { title: 'Poussé à {time}.', description: 'Les commits de nuit ont leur charme.' },
      { title: 'Poussé à {time}.', description: 'Une belle surprise pour demain matin.' },
      { title: 'Push de nuit, {time}.', description: "L'heure la plus calme pour les changements les plus audacieux." },
      { title: '{time}, poussé.', description: 'Le code est en sécurité. On peut souffler.' },
    ],
  },
  thinking: [
    'se creuse les méninges',
    'fixe le plafond',
    'consulte le canard en plastique',
    'coupe les tokens en quatre',
    'mijote une idée',
    'tourne autour du pot',
    'se parle à voix basse',
    'cherche le déclic',
    'pèse chaque mot',
    'refait le monde',
    'démêle ses pensées',
    "cherche midi à quatorze heures",
  ],
  netDeletionCommit: [
    { title: { one: '{count} ligne à la retraite.', other: '{count} lignes à la retraite.' }, description: 'Elles ont bien servi.' },
    { title: { one: '−{count} ligne.', other: '−{count} lignes.' }, description: 'Le genre de commit le plus rare.' },
    { title: { one: '{count} ligne en moins.', other: '{count} lignes en moins.' }, description: "Personne n'aura plus jamais à les relire." },
    { title: { one: '{count} ligne disparue.', other: '{count} lignes disparues.' }, description: "Faisons comme si elles n'avaient jamais existé." },
  ],
};

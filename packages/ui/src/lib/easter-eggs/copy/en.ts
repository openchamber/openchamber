import type { EasterEggCopy } from './types';

export const copy: EasterEggCopy = {
  draftTitle: {
    everyday: [
      'What are we working on in {project}?',
      "What's next for {project}?",
      'What are we building in {project} today?',
      'Bug or idea? Either works in {project}.',
      'Where do we start in {project}?',
    ],
    deepNight: [
      'Still up? What are we working on in {project}?',
      "The night shift is open. What's in {project}?",
      "Everyone's asleep except us and {project}.",
      'Bugs sleep too. Shall we catch them in {project}?',
      "Late night, clear head. What's next in {project}?",
      'Quiet hours. A good time for {project}.',
    ],
    halloween: [
      'What are we summoning in {project}?',
      'Which bugs are haunting {project}?',
    ],
    newYearsEve: ['One more thing for {project} before the year ends?'],
    newYearsDay: ["What's first for {project} this year?"],
  },
  gitClean: {
    everyday: [
      'Suspiciously clean.',
      'Nothing to commit. Enjoy the quiet while it lasts.',
      'Spotless. Time to make a mess.',
      'Go ahead, prompt your way to some changes.',
      'All committed. A coffee break is officially allowed.',
    ],
    halloween: ['Nothing to commit. Nothing to fear.'],
    newYearsEve: ['A clean tree to end the year on.'],
    newYearsDay: ['A clean start to the year.'],
  },
  push: {
    fridayEvening: [
      { title: 'Brave.', description: 'A Friday evening push. Legend says this is how weekends get cancelled.' },
      { title: 'Bold move.', description: 'Shipping on a Friday evening. May the on-call stay quiet.' },
      { title: 'Pushed into the weekend.', description: "Hope it doesn't follow you there." },
      { title: 'Friday push accepted.', description: 'The weekend has been notified.' },
      { title: 'Pushed.', description: 'Not everyone dares on a Friday evening.' },
    ],
    smallHours: [
      { title: 'Pushed at {time}.', description: 'The rest is well deserved.' },
      { title: 'Pushed at {time}.', description: 'Night commits have a charm of their own.' },
      { title: 'Pushed at {time}.', description: 'A nice surprise for the morning.' },
      { title: 'Night push, {time}.', description: 'The quietest hour for the boldest changes.' },
      { title: '{time}, pushed.', description: 'The code is safe. Time to exhale.' },
    ],
  },
  thinking: [
    'mulling it over',
    'chewing on it',
    'staring at the ceiling',
    'scratching its head',
    'consulting the rubber duck',
    'weighing every token',
    'plotting something',
    'talking to itself',
    'brewing an idea',
    'taking a deep breath',
    'reading between the lines',
    'overthinking it, probably',
    'boiling the ocean',
  ],
  netDeletionCommit: [
    { title: { one: '{count} line retired.', other: '{count} lines retired.' }, description: 'They served well.' },
    { title: { one: '−{count} line.', other: '−{count} lines.' }, description: 'The rarest kind of commit.' },
    { title: { one: '{count} line lighter.', other: '{count} lines lighter.' }, description: 'Nobody will ever have to review those again.' },
    { title: { one: '{count} line gone.', other: '{count} lines gone.' }, description: "Let's pretend they never existed." },
  ],
};

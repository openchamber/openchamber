import type { EasterEggCopy } from './types';

export const copy: EasterEggCopy = {
  draftTitle: {
    everyday: [
      'No que vamos trabalhar em {project}?',
      'Qual o próximo passo em {project}?',
      'O que vamos construir hoje em {project}?',
      'Bug ou ideia? Em {project} vale tudo.',
      'Por onde começamos em {project}?',
    ],
    deepNight: [
      'Ainda por aqui? No que vamos trabalhar em {project}?',
      'O turno da noite começou. O que tem em {project}?',
      'Todo mundo dormindo, menos nós e {project}.',
      'Os bugs também dormem. Vamos pegá-los em {project}?',
      'Madrugada, cabeça fresca. Qual o próximo passo em {project}?',
      'Horas tranquilas. Boa hora para {project}.',
    ],
    halloween: [
      'O que vamos invocar hoje em {project}?',
      'Quais bugs andam assombrando {project}?',
    ],
    newYearsEve: ['Mais uma coisa em {project} antes de o ano acabar?'],
    newYearsDay: ['O que vem primeiro em {project} este ano?'],
  },
  gitClean: {
    everyday: [
      'Suspeitamente limpo.',
      'Nada para commitar. Aproveitemos o silêncio enquanto dura.',
      'Impecável. Hora de bagunçar um pouco.',
      'Vá em frente, alguns prompts e as mudanças aparecem.',
      'Tudo commitado. Pausa para o café oficialmente liberada.',
    ],
    halloween: ['Nada para commitar. Nada a temer.'],
    newYearsEve: ['Uma árvore limpa para fechar o ano.'],
    newYearsDay: ['Um começo limpo para o ano.'],
  },
  push: {
    fridayEvening: [
      { title: 'Que coragem.', description: 'Um push na sexta à noite. Diz a lenda que é assim que fins de semana são cancelados.' },
      { title: 'Jogada ousada.', description: 'Um push na sexta à noite. Que o plantão fique tranquilo.' },
      { title: 'Push direto para o fim de semana.', description: 'Tomara que ele não venha junto.' },
      { title: 'Push de sexta aceito.', description: 'O fim de semana já foi avisado.' },
      { title: 'Push feito.', description: 'Nem todo mundo se arrisca numa sexta à noite.' },
    ],
    smallHours: [
      { title: 'Push feito às {time}.', description: 'O descanso é mais que merecido.' },
      { title: 'Push feito às {time}.', description: 'Commits noturnos têm um charme próprio.' },
      { title: 'Push feito às {time}.', description: 'Uma boa surpresa para a manhã.' },
      { title: 'Push noturno, {time}.', description: 'A hora mais calma para as mudanças mais ousadas.' },
      { title: '{time}, push feito.', description: 'O código está seguro. Pode respirar.' },
    ],
  },
  thinking: [
    'quebra a cabeça',
    'encara o teto',
    'consulta o patinho de borracha',
    'pesa cada token',
    'conversa com os próprios botões',
    'cozinha uma ideia',
    'procura pelo em ovo',
    'matuta mais um pouco',
    'caça o fio da meada',
    'põe as ideias no lugar',
    'dá um nó nos neurônios',
    'ferve o oceano',
  ],
  netDeletionCommit: [
    { title: { one: '{count} linha aposentada.', other: '{count} linhas aposentadas.' }, description: 'Serviram bem.' },
    { title: { one: '−{count} linha.', other: '−{count} linhas.' }, description: 'O tipo mais raro de commit.' },
    { title: { one: '{count} linha a menos.', other: '{count} linhas a menos.' }, description: 'Ninguém mais vai precisar revisá-las.' },
    { title: { one: '{count} linha sumiu.', other: '{count} linhas sumiram.' }, description: 'Vamos fingir que nunca existiram.' },
  ],
};

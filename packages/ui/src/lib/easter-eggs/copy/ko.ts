import type { EasterEggCopy } from './types';

export const copy: EasterEggCopy = {
  draftTitle: {
    everyday: [
      '{project}에서 무엇을 작업할까요?',
      '{project}의 다음 단계는 무엇인가요?',
      '오늘 {project}에서 무엇을 만들까요?',
      '버그든 아이디어든, {project}에서는 다 좋습니다.',
      '{project}에서 어디부터 시작할까요?',
    ],
    deepNight: [
      '아직 안 주무세요? {project}에서 무엇을 작업할까요?',
      '야간 근무 시작입니다. {project}에서 무엇을 할까요?',
      '모두 잠들었네요. 우리와 {project}만 빼고요.',
      '버그도 잠들었어요. {project}에서 잡아 볼까요?',
      '깊은 밤, 맑은 머리. {project}의 다음 단계는?',
      '조용한 시간. {project}에 딱 좋은 때입니다.',
    ],
    halloween: [
      '오늘 {project}에서 무엇을 소환할까요?',
      '{project}에 출몰하는 버그는 무엇인가요?',
    ],
    newYearsEve: ['올해가 끝나기 전에 {project}에서 하나 더 할까요?'],
    newYearsDay: ['올해 {project}의 첫 작업은 무엇인가요?'],
  },
  gitClean: {
    everyday: [
      '수상할 만큼 깨끗합니다.',
      '커밋할 것이 없습니다. 이 고요함을 즐겨 보세요.',
      '티끌 하나 없네요. 이제 좀 어질러 볼 시간입니다.',
      '자, 프롬프트 몇 개면 변경 사항이 생깁니다.',
      '모두 커밋했습니다. 커피 타임이 공식 승인되었습니다.',
    ],
    halloween: ['커밋할 것도, 두려울 것도 없습니다.'],
    newYearsEve: ['깨끗한 트리로 한 해를 마무리합니다.'],
    newYearsDay: ['깨끗하게 시작하는 새해.'],
  },
  push: {
    fridayEvening: [
      { title: '용감하시네요.', description: '금요일 저녁 push입니다. 전설에 따르면 주말은 이렇게 사라진다고 합니다.' },
      { title: '과감하시네요.', description: '금요일 저녁 push입니다. 당직자의 밤이 평온하길.' },
      { title: '주말로 바로 push.', description: '주말까지 따라오지 않길 바랍니다.' },
      { title: '금요일 push 접수 완료.', description: '주말에게 이미 통보했습니다.' },
      { title: 'push 완료.', description: '금요일 저녁에 이런 용기를 내는 사람은 많지 않죠.' },
    ],
    smallHours: [
      { title: '{time}에 push 완료.', description: '충분히 쉴 자격이 있습니다.' },
      { title: '{time}에 push 완료.', description: '밤의 커밋에는 특별한 매력이 있죠.' },
      { title: '{time}에 push 완료.', description: '아침에 반가운 선물이 될 겁니다.' },
      { title: '야간 push, {time}.', description: '가장 조용한 시간, 가장 과감한 변경.' },
      { title: '{time}, push 완료.', description: '코드는 안전합니다. 한숨 돌려도 됩니다.' },
    ],
  },
  thinking: [
    '천장에 답이 있나 보는 중',
    '고무 오리와 상의 중',
    '머리를 싸매는 중',
    '토큰 하나하나 저울질 중',
    '혼자서 작전 회의 중',
    '아이디어를 푹 끓이는 중',
    '생각의 꼬리를 잡는 중',
    '돌다리도 두드리는 중',
    '뇌 속 서랍을 뒤지는 중',
    '혼잣말로 검산하는 중',
    '생각이 너무 많나 생각 중',
    '바닷물을 끓이는 중',
  ],
  netDeletionCommit: [
    { title: { other: '{count}줄이 은퇴했습니다.' }, description: '그동안 수고 많았습니다.' },
    { title: { other: '−{count}줄.' }, description: '가장 희귀한 종류의 커밋.' },
    { title: { other: '{count}줄 가벼워졌습니다.' }, description: '이제 아무도 이 코드를 리뷰할 필요가 없습니다.' },
    { title: { other: '{count}줄이 사라졌습니다.' }, description: '처음부터 없었던 걸로 하죠.' },
  ],
};

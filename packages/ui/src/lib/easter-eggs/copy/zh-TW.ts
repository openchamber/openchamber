import type { EasterEggCopy } from './types';

export const copy: EasterEggCopy = {
  draftTitle: {
    everyday: [
      '在 {project} 中要做什麼？',
      '{project} 接下來做什麼？',
      '今天在 {project} 裡打造什麼？',
      'Bug 還是點子？{project} 都歡迎。',
      '{project} 從哪裡開始？',
    ],
    deepNight: [
      '還沒睡？在 {project} 中要做什麼？',
      '夜班開工了。{project} 裡有什麼？',
      '大家都睡了，只剩我們和 {project}。',
      'bug 也在睡覺。去 {project} 裡抓它們？',
      '夜深頭腦清醒。{project} 下一步做什麼？',
      '安靜時刻，正適合 {project}。',
    ],
    halloween: [
      '今天在 {project} 裡召喚什麼？',
      '哪些 bug 在 {project} 裡作祟？',
    ],
    newYearsEve: ['年底前再為 {project} 做一件事？'],
    newYearsDay: ['今年 {project} 的第一件事是什麼？'],
  },
  gitClean: {
    everyday: [
      '乾淨得有點可疑。',
      '沒有可提交的內容。趁安靜享受一下。',
      '一塵不染。是時候弄亂點什麼了。',
      '來吧，寫幾個提示，改動自然就來了。',
      '全部已提交。咖啡時間正式核准。',
    ],
    halloween: ['沒有可提交的，也沒什麼好怕的。'],
    newYearsEve: ['用一棵乾淨的樹結束這一年。'],
    newYearsDay: ['新年的乾淨開局。'],
  },
  push: {
    fridayEvening: [
      { title: '真勇敢。', description: '週五晚上 push。在工程師的傳說裡，週末往往就是這樣泡湯的。' },
      { title: '大膽一試。', description: '週五晚上 push。願值班的同事今晚安穩。' },
      { title: '直接 push 進了週末。', description: '希望它別跟著過週末。' },
      { title: '週五 push 已接收。', description: '週末已收到通知。' },
      { title: '已 push。', description: '週五晚上敢這麼做的人可不多。' },
    ],
    smallHours: [
      { title: '{time} 已 push。', description: '好好休息，這是應得的。' },
      { title: '{time} 已 push。', description: '夜裡的提交自有一番魅力。' },
      { title: '{time} 已 push。', description: '明早會是個驚喜。' },
      { title: '深夜 push，{time}。', description: '最安靜的時刻，最大膽的改動。' },
      { title: '{time}，push 完成。', description: '程式碼安全了，可以鬆口氣了。' },
    ],
  },
  thinking: [
    '正在盯著天花板找靈感',
    '正在請教黃色小鴨',
    '正在秤每個字的分量',
    '正在腦內開會',
    '正在抓住靈感的尾巴',
    '正在用小火熬點子',
    '正在翻腦中的抽屜',
    '正在跟自己討價還價',
    '正在琢磨話中有話',
    '正在替打結的思緒解套',
    '正在想是不是想太多',
    '正在煮沸一整片海',
  ],
  netDeletionCommit: [
    { title: { other: '{count} 行程式碼光榮退休。' }, description: '它們站好了最後一班崗。' },
    { title: { other: '−{count} 行。' }, description: '最稀有的一種提交。' },
    { title: { other: '輕了 {count} 行。' }, description: '再也沒人需要審查它們了。' },
    { title: { other: '{count} 行消失了。' }, description: '就當它們從未存在過吧。' },
  ],
};

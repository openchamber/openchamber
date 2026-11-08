import type { EasterEggCopy } from './types';

export const copy: EasterEggCopy = {
  draftTitle: {
    everyday: [
      '在 {project} 中做些什么？',
      '{project} 接下来做什么？',
      '今天在 {project} 里构建点什么？',
      'Bug 还是想法？{project} 都欢迎。',
      '{project} 从哪里开始？',
    ],
    deepNight: [
      '还没睡？在 {project} 中做些什么？',
      '夜班开工了。{project} 里有什么？',
      '大家都睡了，只剩我们和 {project}。',
      'bug 也在睡觉。去 {project} 里抓它们？',
      '夜深头脑清醒。{project} 下一步做什么？',
      '安静时刻，正适合 {project}。',
    ],
    halloween: [
      '今天在 {project} 里召唤点什么？',
      '哪些 bug 在 {project} 里作祟？',
    ],
    newYearsEve: ['年底前再为 {project} 做一件事？'],
    newYearsDay: ['今年 {project} 的第一件事是什么？'],
  },
  gitClean: {
    everyday: [
      '干净得有点可疑。',
      '没有可提交的内容。趁安静享受一下。',
      '一尘不染。是时候弄乱点什么了。',
      '来吧，写几个提示，改动自然就来了。',
      '全部已提交。咖啡时间正式批准。',
    ],
    halloween: ['没有可提交的，也没什么可怕的。'],
    newYearsEve: ['用一棵干净的树结束这一年。'],
    newYearsDay: ['新年的干净开局。'],
  },
  push: {
    fridayEvening: [
      { title: '真勇敢。', description: '周五晚上 push。在程序员的传说里，周末往往就是这样泡汤的。' },
      { title: '大胆一试。', description: '周五晚上 push。愿值班的同事今晚安稳。' },
      { title: '直接 push 进了周末。', description: '希望它别跟着过周末。' },
      { title: '周五 push 已接收。', description: '周末已收到通知。' },
      { title: '已 push。', description: '周五晚上敢这么做的人可不多。' },
    ],
    smallHours: [
      { title: '{time} 已 push。', description: '好好休息，这是应得的。' },
      { title: '{time} 已 push。', description: '夜里的提交自有一番魅力。' },
      { title: '{time} 已 push。', description: '明早会是个惊喜。' },
      { title: '深夜 push，{time}。', description: '最安静的时刻，最大胆的改动。' },
      { title: '{time}，push 完成。', description: '代码安全了，可以松口气了。' },
    ],
  },
  thinking: [
    '正在对着天花板找灵感',
    '正在请教小黄鸭',
    '正在给每个词过秤',
    '正在脑内开小会',
    '正在抓住思路的小尾巴',
    '正在慢火炖点子',
    '正在翻箱倒柜找灵感',
    '正在跟自己打商量',
    '正在琢磨弦外之音',
    '正在给脑筋松个结',
    '正在思考是不是想太多了',
    '正在烧开一整片海',
  ],
  netDeletionCommit: [
    { title: { other: '{count} 行代码光荣退休。' }, description: '它们站好了最后一班岗。' },
    { title: { other: '−{count} 行。' }, description: '最稀有的一种提交。' },
    { title: { other: '轻了 {count} 行。' }, description: '再也没人需要审查它们了。' },
    { title: { other: '{count} 行消失了。' }, description: '就当它们从未存在过吧。' },
  ],
};

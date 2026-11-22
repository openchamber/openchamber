import type { EasterEggCopy } from './types';

export const copy: EasterEggCopy = {
  draftTitle: {
    everyday: [
      '{project}で何に取り組みますか？',
      '{project}の次の一手は？',
      '今日は{project}で何を作りますか？',
      'バグでもアイデアでも、{project}ならどちらでも。',
      '{project}はどこから始めましょう？',
    ],
    deepNight: [
      'まだ起きていますか？{project}で何に取り組みますか？',
      '夜勤スタートです。{project}では何をしますか？',
      'みんな寝ています。私たちと{project}以外は。',
      'バグも眠っています。{project}で捕まえましょうか？',
      '夜更け、頭は冴えています。{project}の次の一手は？',
      '静かな時間。{project}にはちょうどいい頃合いです。',
    ],
    halloween: [
      '今日は{project}で何を召喚しますか？',
      '{project}に取り憑いているバグは？',
    ],
    newYearsEve: ['年が明ける前に、{project}でもうひと仕事？'],
    newYearsDay: ['今年の{project}、最初は何から？'],
  },
  gitClean: {
    everyday: [
      '怪しいほどクリーンです。',
      'コミットするものはありません。この静けさを今のうちに。',
      'ピカピカです。そろそろ散らかしましょう。',
      'さあ、プロンプトをいくつか書けば変更が生まれます。',
      'すべてコミット済み。コーヒー休憩が正式に許可されました。',
    ],
    halloween: ['コミットするものも、怖いものもありません。'],
    newYearsEve: ['クリーンなツリーで一年を締めくくりましょう。'],
    newYearsDay: ['クリーンな新年のスタート。'],
  },
  push: {
    fridayEvening: [
      { title: '勇敢ですね。', description: '金曜の夜に push。週末はこうして消えていく、という言い伝えがあります。' },
      { title: '大胆ですね。', description: '金曜の夜に push。当番の人の夜が平穏でありますように。' },
      { title: 'そのまま週末へ push。', description: '週末まで追いかけてこないといいですね。' },
      { title: '金曜の push、受理しました。', description: '週末にはもう知らせてあります。' },
      { title: 'push しました。', description: '金曜の夜にこれができる人は多くありません。' },
    ],
    smallHours: [
      { title: '{time} に push しました。', description: 'お疲れさまでした。' },
      { title: '{time} に push しました。', description: '夜のコミットには独特の魅力があります。' },
      { title: '{time} に push しました。', description: '朝にはうれしいサプライズになりそうです。' },
      { title: '深夜の push、{time}。', description: 'いちばん静かな時間に、いちばん大胆な変更を。' },
      { title: '{time}、push 完了。', description: 'コードは無事です。ひと息つきましょう。' },
    ],
  },
  thinking: [
    '天井とにらめっこ中',
    'ゴムのアヒルに相談中',
    '頭をひねっているところ',
    '一人で脳内会議中',
    'トークンを一つずつ吟味中',
    'ひらめきを待っているところ',
    '考えをコトコト煮込み中',
    '石橋をたたいているところ',
    '頭の引き出しを捜索中',
    '脳内の糸をほどいているところ',
    '考えすぎかどうか検討中',
    '海を沸かしているところ',
  ],
  netDeletionCommit: [
    { title: { other: '{count} 行が引退しました。' }, description: '長い間お疲れさまでした。' },
    { title: { other: '−{count} 行。' }, description: '最も珍しい種類のコミット。' },
    { title: { other: '{count} 行軽くなりました。' }, description: 'もう誰もレビューしなくて済みます。' },
    { title: { other: '{count} 行が消えました。' }, description: '最初からなかったことにしましょう。' },
  ],
};

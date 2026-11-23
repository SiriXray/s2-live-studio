'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { applySoundTags, stripSoundTags, soundTagsToFillers, normalizeSoundTags } = require('../lib/ai');
const { naturalizeSpeech } = require('../lib/interaction');

test('normalizes full-width and uppercase sound tags', () => {
  assert.strictEqual(normalizeSoundTags('（SIGHS）'), '(sighs)');
});

test('MiniMax keeps one tag and drops duplicate punctuation', () => {
  assert.strictEqual(applySoundTags('哈哈哈，今天太开心了。', 'speech-2.8-turbo'), '(laughs)今天太开心了。');
  assert.strictEqual(applySoundTags('（SIGHS）唉，今天有点累。', 'speech-2.8-turbo'), '(sighs)今天有点累。');
});

test('S2 subtitle strips tags but keeps readable words', () => {
  assert.strictEqual(stripSoundTags('(laughs)大家好，欢迎来到直播间。'), '大家好，欢迎来到直播间。');
  assert.strictEqual(stripSoundTags('(sighs)唉，今天有点累。'), '唉，今天有点累。');
});

test('Soul converts tags to fillers without duplicating', () => {
  assert.strictEqual(soundTagsToFillers('(laughs)哈哈哈，太开心了。'), '哈哈，太开心了。');
  assert.match(soundTagsToFillers('(sighs)唉，今天有点累。'), /^唉……/);
  assert.doesNotMatch(soundTagsToFillers('(sighs)唉，今天有点累。'), /唉……唉/);
});

test('naturalizeSpeech adds one filler only when needed', () => {
  const person = { filler_rate: 1, fillers: ['嗯，'] };
  assert.match(naturalizeSpeech('今天给大家讲一个方法。', person, 'comment_question', () => 0), /^(嗯，|哈哈哈，|啊——|诶，|啊，)/);
  assert.strictEqual(naturalizeSpeech('(laughs)今天很开心。', person, 'comment_question', () => 0), '(laughs)今天很开心。');
});

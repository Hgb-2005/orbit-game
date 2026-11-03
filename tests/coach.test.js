import test from 'node:test';
import assert from 'node:assert/strict';
import {readPracticeProgress, rememberPractice, nextPractice, practiceCheckpoints, roundAdvice} from '../static/js/presentation/coach.js';

test('practice progress survives reload, keeps best time and rejects invalid saves', () => {
  let saved = '{"split":12,"feed":-1,"regroup":"bad","unknown":3}';
  const storage = {getItem: () => saved, setItem: (_, value) => {saved = value;}};
  const progress = readPracticeProgress(storage);
  assert.deepEqual(progress, {split:12});
  assert.equal(nextPractice(progress), 'feed');
  assert.equal(rememberPractice(progress, {id:'split',complete:true,completedAt:20}, storage), true);
  rememberPractice(progress, {id:'feed',complete:true,completedAt:8}, storage);
  assert.deepEqual(readPracticeProgress(storage), {split:12,feed:8});
  assert.equal(rememberPractice(progress, {id:'regroup',complete:true,completedAt:-1}, storage), false);
  assert.equal(rememberPractice(progress, {id:'unknown',complete:true,completedAt:1}, storage), false);
  assert.equal(rememberPractice(progress, {id:'regroup',complete:false,completedAt:1}, storage), false);
});

test('corrupt or blocked storage keeps practice playable', () => {
  assert.deepEqual(readPracticeProgress({getItem: () => '{bad'}), {});
  assert.deepEqual(readPracticeProgress({getItem: () => {throw Error('blocked');}}), {});
  const progress = {};
  assert.equal(rememberPractice(progress, {id:'feed',complete:true,completedAt:9}, {setItem: () => {throw Error('full');}}), false);
  assert.equal(progress.feed, 9);
});

test('coach steps advance with actual actions; recap recommends relevant drills', () => {
  const steps = practiceCheckpoints({practice:{id:'feed',complete:false},stats:{sporesEmitted:5,spikesFed:3}});
  assert.deepEqual(steps.map(s => [s.done,s.current]), [[true,false],[false,true],[false,false]]);
  assert.ok(practiceCheckpoints({practice:{id:'split',complete:true},stats:{splits:1}}).every(s => s.done));
  assert.equal(roundAdvice({stats:{spikeHits:2}}).drill, 'feed');
  assert.equal(roundAdvice({stats:{maxCells:3,cellsLost:1}}).drill, 'regroup');
  assert.equal(roundAdvice({stats:{splits:0}}).drill, 'split');
  assert.equal(roundAdvice({}), null);
});

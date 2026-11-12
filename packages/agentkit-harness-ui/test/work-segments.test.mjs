import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce } from '../src/reducer.mjs';
import { buildViewModel } from '../src/view.mjs';
import { completedWorkLabel, conversationWorkSegments } from '../src/work-segments.mjs';
import { findByTestId, findAllByTestId, textOf } from './helpers.mjs';
import { createSessionTaskProjector } from '../src/host/session-task-events.mjs';

const events=[
  {type:'task.started',taskId:'task',startedAt:1000},
  {type:'text.done',itemId:'user',role:'user',text:'Read and summarize'},
  {type:'thinking.done',itemId:'thought',text:'Actual provider reasoning'},
  {type:'text.done',itemId:'progress',text:'Checking the actual source'},
  {type:'tool.scheduled',callId:'read',name:'read_workspace_file',input:{path:'README.md'}},
  {type:'tool.result',callId:'read',result:'actual contents'},
  {type:'text.done',itemId:'answer',sourceMessageId:'final-message',text:'Final source-grounded answer'},
];
const replay=items=>items.reduce((state,event,index)=>reduce(state,{v:1,id:`event-${index}`,...event}),initialState());

test('completion collapses the process, retains the final answer, and row expansion restores all source evidence',()=>{
  const state=replay([...events,{type:'task.finished',outcome:'unverified',finalAnswerId:'answer',endedAt:134000}]);
  const before=structuredClone(state), tree=buildViewModel(state,{locale:'zh-CN'});
  assert.equal(findByTestId(tree,'work-history').props.open,false);
  assert.match(textOf(tree),/已工作 2 分 13 秒/);
  assert.match(textOf(tree),/Final source-grounded answer/);
  assert.doesNotMatch(textOf(tree),/Checking the actual source|Actual provider reasoning|README.md/);
  const id=findByTestId(tree,'work-history').props['data-item-id'];
  const open=buildViewModel(state,{locale:'zh-CN',historyOpen:new Map([[id,true]]),thoughtOpen:new Map([['thought',true]])});
  assert.match(textOf(open),/Checking the actual source/);assert.match(textOf(open),/Actual provider reasoning/);
  assert.equal(findAllByTestId(open,'tool-block').length,1);
  assert.deepEqual(state,before);
  assert.deepEqual(buildViewModel(replay([...events,{type:'task.finished',outcome:'unverified',finalAnswerId:'answer',endedAt:134000}]),{locale:'zh-CN'}),tree);
});

test('running, failure, interruption and cancellation never conceal work as a delivered answer',()=>{
  for(const ending of [null,{outcome:'failed',error:'actual failure'},{outcome:'cancelled'},
    {outcome:'blocked'},{outcome:'unverified'}, {outcome:'unverified',executionState:'interrupted'}]){
    const state=replay([...events,...ending?[{type:'task.finished',finalAnswerId:ending.outcome==='unverified'&& !ending.executionState?undefined:'answer',...ending}]:[]]);
    const tree=buildViewModel(state,{locale:'zh-CN'});
    assert.equal(findByTestId(tree,'work-history'),null);assert.match(textOf(tree),/Checking the actual source/);
  }
});

test('unknown tool outcomes stay visible even when a Host declares a finished answer',()=>{
  const state=replay([...events.filter(event=>event.type!=='tool.result'),{type:'tool.state',callId:'read',status:'uncertain'},
    {type:'task.finished',outcome:'completed',finalAnswerId:'answer'}]);
  const tree=buildViewModel(state,{locale:'zh-CN'});
  assert.equal(findByTestId(tree,'work-history'),null);
  assert.equal(findAllByTestId(tree,'tool-block').length,1);
});

test('steering inputs remain visible and every text block from the final message stays outside history',()=>{
  const state=replay([...events.slice(0,-1),{type:'text.done',itemId:'steer',role:'user',text:'Focus on persistence'},
    {type:'thinking.done',itemId:'thought-2',text:'Additional actual reasoning'},
    {type:'text.done',itemId:'answer-1',sourceMessageId:'final',text:'First part'},
    {type:'text.done',itemId:'answer-2',sourceMessageId:'final',text:'Second part'},
    {type:'task.finished',outcome:'completed',finalAnswerId:'answer-2'}]);
  const tree=buildViewModel(state,{locale:'zh-CN'}), text=textOf(tree);
  assert.match(text,/Focus on persistence/);assert.match(text,/First part/);assert.match(text,/Second part/);
  assert.doesNotMatch(text,/Additional actual reasoning/);
  assert.equal(conversationWorkSegments(state,state.items).length,2);
});

test('work duration uses committed timestamps and never invents missing or reversed timing',()=>{
  for(const state of [{},{taskStartedAt:1000},{taskStartedAt:2000,taskEndedAt:1000},{taskStartedAt:NaN,taskEndedAt:5000}])
    assert.equal(completedWorkLabel(state,'zh-CN'),'已工作');
  assert.equal(completedWorkLabel({taskStartedAt:1000,taskEndedAt:7981000},'zh-CN'),'已工作 2 时 13 分');
});

test('an independent engine turn replays one answer, with tool history and the durable action target', () => {
  const entry = (seq, type, data, time = seq * 1000) => ({ type: 'event', event: { seq, type, data, time } });
  const engine = (seq, kind, fields = {}) => {
    const row = entry(seq, 'agentkit/native-engine-event', {
      runId: 'run', event: { schema: 'agentkit.engine-event/v1', seq, kind, ...fields },
    });
    row.event.ignorable = true;
    return row;
  };
  const running = [
    entry(1, 'turn/start', { turn: 1 }),
    entry(2, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Read README.md' }] }),
    engine(3, 'run.started'),
    engine(4, 'model.completed', { calls: [{ callId: 'read', name: 'read_workspace_file', arguments: { path: 'README.md' } }] }),
    engine(5, 'tool.completed', { callId: 'read', status: 'ok', result: 'Read' }),
  ];
  const completed = [
    engine(6, 'run.terminal', { title: 'completed', status: 'verified', detail: 'Found **the file**.' }),
    entry(7, 'assistant/message', { turn: 1, step: 1, message: {
      id: 'assistant-1', content: [{ type: 'text', text: 'Found **the file**.' }],
    } }),
    entry(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  const projector = createSessionTaskProjector({ sessionId: 'test' });
  const [active] = projector.project({ revision: 1, entries: running });
  assert.equal(active.state.taskState, 'running');
  assert.equal(findByTestId(buildViewModel(active.state), 'work-history'), null);
  const snapshot = { revision: 2, entries: [...running, ...completed], change: { kind: 'append', entries: completed } };
  const [finished] = projector.project(snapshot);
  assert.deepEqual(projector.project(snapshot), createSessionTaskProjector({ sessionId: 'test' }).project(snapshot));
  assert.deepEqual(finished.reply, { messageId: 'assistant-1', time: 8000, seq: 8, branchable: true });
  assert.equal(finished.state.items.filter(item => item.text === 'Found **the file**.').length, 1);
  const tree = buildViewModel(finished.state, { locale: 'zh-CN' });
  assert.equal(findByTestId(tree, 'work-history').props.open, false);
  assert.match(textOf(tree), /已工作 5 秒/);
  assert.match(textOf(tree), /Found \*\*the file\*\*/);
});

test('the real Session projection preserves answer identity and duration across history reloads',()=>{
  const entry=(seq,type,data,time)=>({type:'event',event:{seq,type,data:{turn:1,...data},time}});
  const rows=[entry(1,'turn/start',{},1000),entry(2,'assistant/message',{step:1,message:{id:'progress',content:[{type:'text',text:'Investigating'}]}},2000),
    entry(3,'tool/call',{step:1,callId:'read',name:'read_workspace_file',arguments:'{}'},3000),
    entry(4,'tool/result',{step:1,message:{toolCallId:'read',content:[{type:'text',text:'source'}]}},4000),
    entry(5,'assistant/message',{step:2,message:{id:'final',content:[{type:'reasoning',text:'Evidence checked'},{type:'text',text:'Final answer'}]}},5000),
    entry(6,'turn/end',{reason:{kind:'completed'}},134000)];
  const window={revision:1,entries:rows};
  const state=createSessionTaskProjector({sessionId:'session'}).project(window)[0].state;
  assert.equal(state.finalAnswerId,'1:2:block:1');
  const tree=buildViewModel(state,{locale:'zh-CN'});
  assert.equal(findByTestId(tree,'work-history').props.open,false);assert.match(textOf(tree),/Final answer/);
  assert.doesNotMatch(textOf(tree),/Investigating/);assert.match(textOf(tree),/已工作 2 分 13 秒/);
  assert.deepEqual(createSessionTaskProjector({sessionId:'session'}).project(window)[0].state,state);
});

test('the independent engine shows a write draft during generation and retires it when the call arrives', () => {
  const requestId = 'a'.repeat(64), runId = 'run';
  const row = (seq, type, data) => ({ type: 'event', event: { seq, type, data: { turn: 1, ...data }, ignorable: true } });
  const engine = (seq, kind, fields) => row(seq, 'agentkit/native-engine-event',
    { runId, event: { schema: 'agentkit.engine-event/v1', seq, kind, ...fields } });
  const request = { category: 'model', title: 'request', requestId };
  const active = [
    row(1, 'turn/start', {}),
    row(2, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Write a file.' }] }),
    engine(3, 'run.started'),
    engine(4, 'effect.prepared', request),
    row(5, 'agentkit/native-engine-tool-draft', { runId, requestId, tools: [{ index: 0, name: 'write_workspace_file' }] }),
  ];
  const projector = createSessionTaskProjector();
  const [generating] = projector.project({ revision: 1, entries: active });
  const tree = buildViewModel(generating.state, { locale: 'zh-CN', labels: { writePending: '请求写入' } });
  assert.match(textOf(tree), /请求写入/);
  assert.equal(findByTestId(tree, 'model-thinking'), null);
  assert.equal(generating.state.items.filter(item => item.kind === 'tool').length, 0);

  const settled = [
    engine(6, 'effect.settled', request),
    engine(7, 'model.completed', { calls: [{ callId: 'write', name: 'write_workspace_file', arguments: { path: 'out.txt' } }] }),
  ];
  const [executing] = projector.project({ revision: 2, entries: [...active, ...settled], change: { kind: 'append', entries: settled } });
  assert.equal(executing.state.items.filter(item => item.kind === 'tool-preview').length, 0);
  assert.deepEqual(executing.state.items.filter(item => item.kind === 'tool').map(item => item.callId), ['write']);
});

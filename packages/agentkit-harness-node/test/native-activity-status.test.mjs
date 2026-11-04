import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeActivityStatus } from '@kingsoftcloud/agentkit-harness-node/native/activity-status';
const record = () => ({snapshot:{runId:'run',revision:1,todos:{items:[
  {content:'Read actual evidence',status:'completed'}, {content:'Publish findings',status:'in_progress'},
]},backgroundCommands:[{ref:{taskId:'task',operationKey:'op'}}]},intents:[{operationKey:'op',payload:{calls:[{arguments:{command:'node report.mjs'}}]}}],events:[]});
test('activity reports committed todos and keeps UI keys across status updates without implying a running driver', () => {
  const r=record(), first=nativeActivityStatus(r);
  assert.equal(first.plan.completedCount,1); assert.equal(first.plan.totalCount,2); assert.equal(first.isRunning,false);
  r.snapshot.todos.items[1].status='completed';
  const second=nativeActivityStatus(r,{driving:true});
  assert.equal(second.plan.completedCount,2); assert.equal(first.plan.items[1].id,second.plan.items[1].id);
  assert.equal(second.isRunning,true); assert.equal(first.plan.items[1].status,'in_progress');
});
test('a launched background reference does not claim process liveness or grant cancellation', () => {
  const r=record(); assert.equal(nativeActivityStatus(r).terminals[0].state,'unknown');
  r.events.push({kind:'background.commands_observed',payload:{commands:[{taskId:'task',status:'failed'}]}});
  const terminal=nativeActivityStatus(r).terminals[0];
  assert.equal(terminal.title,'node report.mjs');assert.equal(terminal.state,'failed');assert.equal(terminal.canCancel,false);
});
test('large checklists have bounded rows and truthful total counts and omission metadata', () => {
  const r=record();r.snapshot.todos.items=Array.from({length:520},()=>({content:'Repeated task',status:'completed'}));
  const {plan}=nativeActivityStatus(r);
  assert.equal(plan.totalCount,520);assert.equal(plan.completedCount,520);assert.equal(plan.items.length,512);assert.equal(plan.omittedItems,8);
  assert.equal(new Set(plan.items.map(row=>row.id)).size,512);
});

test('foreground lifecycle display requires an exact committed complete receipt, never just a notified bit', () => {
  const r = record(), ref = { taskId: 'a'.repeat(64), operationKey: 'op', sourceRunId: 'run' };
  r.snapshot.backgroundCommands = [{ ref, notified: true }];
  r.configuration = { tools: [{ name: 'run_command', backgroundCommandPolicy: 'owned-command-launch/v1' }] };
  r.intents[0] = { operationKey: 'op', kind: 'tool', payload: { calls: [{ name: 'run_command', arguments: { command: 'printf done' } }] } };
  r.receipts = [{ operationKey: 'op', status: 'committed', result: { results: [{ status: 'ok',
    backgroundCommandFinished: true, backgroundCommandRef: ref,
    content: { task_id: ref.taskId, status: 'completed', evidence_incomplete: false } }] } }];
  const before = structuredClone(r);
  assert.equal(nativeActivityStatus(r).terminals[0].state, 'completed');
  assert.equal(nativeActivityStatus(r).terminals[0].canCancel, false);
  assert.deepEqual(r, before);
  for (const change of ['receipt', 'result', 'incomplete', 'identity', 'finished', 'state', 'source']) {
    const other = structuredClone(r), result = other.receipts[0].result.results[0];
    if (change === 'receipt') other.receipts[0].status = 'uncertain';
    if (change === 'result') result.status = 'uncertain';
    if (change === 'incomplete') result.content.evidence_incomplete = true;
    if (change === 'identity') result.backgroundCommandRef = { ...ref, taskId: 'b'.repeat(64) };
    if (change === 'finished') delete result.backgroundCommandFinished;
    if (change === 'state') result.content.status = 'running';
    if (change === 'source') other.snapshot.backgroundCommands[0].ref = { ...ref, sourceRunId: 'another-run' };
    assert.equal(nativeActivityStatus(other).terminals[0].state, 'unknown', change);
  }
});

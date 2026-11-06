import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarnessComponents} from '../src/react-binding.mjs';
import {initialState,reduce} from '../src/reducer.mjs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

function state(events){return events.reduce((s,e,i)=>reduce(s,{v:1,id:String(i),...e}),initialState())}

{
  const {HarnessTimeline}=createHarnessComponents(React);

  test('real React renders nested streaming thought and terminal viewports through the injected React instance',()=>{
    const value=state([
      {type:'task.started',taskId:'real-react'},
      {type:'thinking.delta',itemId:'thought',delta:'Actual streamed reasoning'},
      {type:'tool.scheduled',callId:'shell',name:'run_command',input:{command:'node check.mjs'}},
      {type:'tool.started',callId:'shell'},
      {type:'tool.progress',callId:'shell',message:'Receiving output',display:{kind:'command_output',stdout:'actual\n',stderr:'',exit:null}},
    ]);
    const html=renderToStaticMarkup(React.createElement(HarnessTimeline,{state:value,initiallyExpandedThoughts:['thought'],initiallyExpandedTools:['shell'],styleSheet:null}));
    assert.match(html,/Actual streamed reasoning/);assert.match(html,/actual/);assert.match(html,/node check.mjs/);
    assert.doesNotMatch(html,/undefined|NaN/);
  });

  test('real React renders applied diff positions and disclosure without executing host actions',()=>{
    let opens=0;
    const value=state([
      {type:'task.started',taskId:'diff'},
      {type:'tool.scheduled',callId:'edit',name:'edit_workspace_file',input:{path:'src/a.ts'}},
      {type:'tool.result',callId:'edit',result:'saved',display:{kind:'file_edit',files:[{path:'src/a.ts',patch:'@@ -42,1 +42,1 @@\n-old\n+new\n',operationKind:'edit',changeStat:{added:1,removed:1}}]}},
    ]);
    const html=renderToStaticMarkup(React.createElement(HarnessTimeline,{state:value,initiallyExpandedTools:['edit'],styleSheet:null,onOpenFile:()=>opens++}));
    assert.match(html,/src\/a.ts/);assert.match(html,/>42</);assert.match(html,/data-testid="edit-diff"/);assert.equal(opens,0);
  });

  test('a waiting file request discloses bounded arguments without claiming applied changes or opening files',()=>{
    let opens=0;
    for(const [name,input] of [
      ['write_workspace_file',{path:'src/single.js',content:'export const single = true;'}],
      ['write_workspace_files',{files:[{path:'src/query.js',content:'export const query = true;'},
        {path:'src/io.js',content:'export const io = true;'}]}],
      ['edit_workspace_file',{path:'src/edit.js',old_text:'before',new_text:'after'}],
      ['apply_workspace_patch',{patch:'*** Begin Patch\n*** Add File: src/patch.js\n+export const patch = true;\n*** End Patch'}],
    ]){
      const value=state([{type:'task.started',taskId:'waiting-file'},
        {type:'tool.scheduled',callId:'file',name,input},
        {type:'tool.state',callId:'file',status:'waiting'}]);
      const props={state:value,locale:'zh-CN',styleSheet:null,onOpenFile:()=>opens++};
      const closed=renderToStaticMarkup(React.createElement(HarnessTimeline,props));
      assert.doesNotMatch(closed,/data-testid="edit-request-preview"/,name);
      const html=renderToStaticMarkup(React.createElement(HarnessTimeline,{...props,initiallyExpandedTools:['file']}));
      assert.match(html,/data-testid="edit-request-preview"/,name);
      assert.match(html,/not an execution result/,name);
      for(const path of ['src/single.js','src/query.js','src/io.js','src/edit.js','src/patch.js'])
        if(JSON.stringify(input).includes(path))assert.ok(html.includes(path),path);
      assert.doesNotMatch(html,/data-testid="edit-diff(?:-count)?"|data-action="open-file"/,name);
      assert.equal(opens,0);
    }
  });

  test('request inspection redacts nested credentials and becomes the actual diff once a result arrives',()=>{
    const input={path:'src/a.ts',content:'request-only-marker '+('long-line\n'.repeat(10000)),
      files:[{path:'src/b.ts',token:'PRIVATE_NESTED_TOKEN'}],authorization:'PRIVATE_AUTH',
      note:'Authorization: Bearer PRIVATE_BEARER_VALUE'};
    const events=[{type:'task.started',taskId:'private-request'},
      {type:'tool.scheduled',callId:'edit',name:'write_workspace_file',input},
      {type:'tool.state',callId:'edit',status:'waiting'}];
    const html=renderToStaticMarkup(React.createElement(HarnessTimeline,{state:state(events),initiallyExpandedTools:['edit'],styleSheet:null}));
    assert.match(html,/request-only-marker/);assert.match(html,/redacted|…/);
    assert.doesNotMatch(html,/PRIVATE_NESTED_TOKEN|PRIVATE_AUTH|PRIVATE_BEARER_VALUE/);
    assert.ok(html.length<20000,'argument preview stays bounded');
    const done=state([...events,{type:'tool.result',callId:'edit',result:'saved',
      display:{kind:'file_diff',path:'src/a.ts',patch:'@@ -1 +1 @@\n-before\n+applied-line',operationKind:'edit'}}]);
    const applied=renderToStaticMarkup(React.createElement(HarnessTimeline,{state:done,initiallyExpandedTools:['edit'],styleSheet:null}));
    assert.match(applied,/applied-line/);assert.doesNotMatch(applied,/edit-request-preview|request-only-marker|PRIVATE_/);
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPrediction, predictionMessages, createPredictionController } from '../src/prediction.js';
import { createPredictionEngine, parseModelSelection } from '../src/engine.js';
test('plain short output and two-turn context',()=>{
 assert.equal(cleanPrediction('```text\n"Next step?"\n```'),'Next step?');
 const data=predictionMessages([{prompt:'old',response:'old'},{prompt:'user',response:'reply'},{prompt:'last',response:'new'}],'zh');
 assert.equal(data.recent.length,4);assert.ok(!JSON.stringify(data.recent).includes('old'));
});
test('cancelled and superseded requests cannot publish late results',async()=>{
 const pending=[],output=[];
 const c=createPredictionController({request:(input,signal)=>new Promise(resolve=>pending.push({signal,resolve})),publish:t=>output.push(t)});
 const a=c.start({sessionId:'a'}),b=c.start({sessionId:'b'});assert.equal(pending[0].signal.aborted,true);
 pending[0].resolve('wrong');await a;pending[1].resolve('right');await b;assert.ok(!output.includes('wrong'));assert.equal(output.at(-1),'right');
 const d=c.start({});c.cancel();pending[2].resolve('late');await d;assert.equal(pending[2].signal.aborted,true);assert.equal(output.at(-1),'');
});
function fixture({model='',pending,finish={kind:'stop'},stale=false}={}){
 let count=0;const seen={};
 class BlockAssembler{constructor(){this.finish=finish;}push(){}blocks(){return[{type:'text',text:'What comes next?'}];}}
 const engine=createPredictionEngine({BlockAssembler,createUserMessage:x=>x});
 const session={id:'s',requestHeader:()=>({config:{provider:'p',model:'current',reasoningEffort:'high'},adapterDefaults:{reasoningEffort:true}})};
 const ctx={sessionController:{resolveAgent:async()=>({agent:{session,status:'idle'}})},sessionProjections:{stateOf:(_s,k)=>k==='modelSelection'?{pending}:{turns:[{turn:1,seq:2,prompt:'Hi',response:stale&&count++?'':'answer'}]}},agentDefaultModel:{currentSelection:()=>({provider:'p',model:'default'})},llm:{listProviders:()=>[{id:'p'}],prepareCall:async(config,signal)=>{seen.config=config;seen.signal=signal;return{config,stream:async function*(options){seen.options=options;yield{};}}}}};
 return{engine,ctx,seen,config:{model,timeoutMs:100},request:{sessionId:'s',turnKey:'1:2',language:'en'}};
}
test('inherits model and uses one bounded tools-free stream',async()=>{const f=fixture();assert.equal(await f.engine(f.ctx,f.config,f.request,new AbortController().signal),'What comes next?');assert.equal(f.seen.config.model,'current');assert.equal(f.seen.config.reasoningEffort,undefined);assert.equal(f.seen.config.maxTokens,96);assert.equal(f.seen.options.tools,undefined);});
test('explicit and pending models preserve nested IDs',async()=>{assert.deepEqual(parseModelSelection('p/custom/model'),{provider:'p',model:'custom/model'});for(const [options,expected]of [[{model:'p/custom/model'},'custom/model'],[{pending:{provider:'p',model:'pending'}},'pending']]){const f=fixture(options);await f.engine(f.ctx,f.config,f.request,new AbortController().signal);assert.equal(f.seen.config.model,expected);}});
test('unavailable adapters and stream failures have no regex fallback',async()=>{const f=fixture({model:'missing/model'});await assert.rejects(f.engine(f.ctx,f.config,f.request,new AbortController().signal),/no installed LLM adapter/);const g=fixture({finish:{kind:'error',failure:{code:'OFFLINE',message:'offline'}}});await assert.rejects(g.engine(g.ctx,g.config,g.request,new AbortController().signal),/offline/);});
test('stale host history and cancelled noncooperative provider are rejected',async()=>{const f=fixture({stale:true});await assert.rejects(f.engine(f.ctx,f.config,f.request,new AbortController().signal),/conversation changed/);const g=fixture();g.ctx.llm.prepareCall=()=>new Promise(()=>{});const abort=new AbortController();const task=g.engine(g.ctx,g.config,g.request,abort.signal);await new Promise(r=>setImmediate(r));abort.abort(new Error('cancelled'));await assert.rejects(task,/cancelled/);});

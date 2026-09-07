'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const card = require('../credit-rates.json');
const norm = p => { const s = path.resolve(p).replace(/\\/g, '/'); return process.platform === 'win32' ? s.toLowerCase() : s; };
function projectRoot(p) { let d = path.resolve(p); for (;;) { if (fs.existsSync(path.join(d, '.git'))) return d; const up = path.dirname(d); if (up === d) return path.resolve(p); d = up; } }
function union(xs) { const out = []; for (const [a,b] of xs.filter(x => Number.isFinite(x[0]) && x[1] >= x[0]).sort((a,b) => a[0]-b[0])) { const last=out.at(-1); if(last && a<=last[1]) last[1]=Math.max(last[1],b); else out.push([a,b]); } return out; }
const seconds = xs => union(xs).reduce((s,[a,b])=>s+(b-a)/1000,0);
function load(files) { const rows=[], seen=new Set(); let invalid=0; for(const f of files) { for(const line of fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/)) { if(!line.trim()) continue; let r; try {r=JSON.parse(line);} catch {invalid++;continue;} if(!r || typeof r!=='object' || !Number.isFinite(Date.parse(r.recorded_at))) {invalid++;continue;} const key=r.event_id||JSON.stringify(r); if(!seen.has(key)) {seen.add(key);rows.push(r);} } } return {rows:rows.sort((a,b)=>Date.parse(a.recorded_at)-Date.parse(b.recorded_at)),invalid}; }
function linked(rows,id) { const ids=new Set([id]); let changed=true; while(changed) { changed=false; for(const r of rows) { const belongs=ids.has(r.session_id)||ids.has(r.agent_id)||ids.has(r.parent_session_id)||ids.has(r.parent_agent_id)||ids.has(r.root_session_id); if(!belongs) continue; for(const x of [r.session_id,r.agent_id,r.created_agent_id]) if(x&&!ids.has(x)) {ids.add(x);changed=true;} } } return ids; }
const usageModel=r=>Object.hasOwn(r,'usage_model')?r.usage_model:r.observed_model;
function credits(r) { const model=usageModel(r),rates=card.rates[model]; const u=r.token_usage, date=r.recorded_at.slice(0,10); if(!rates||!u||date<card.verified_at||(model==='gpt-5.6-sol'&&date>'2026-11-21')) return null;
 const vals=[u.input_tokens,u.cached_input_tokens,u.output_tokens]; if(vals.some(x=>!Number.isFinite(x)||x<0)||vals[1]>vals[0]||(u.cache_write_input_tokens??0)>0) return null;
 const speed=r.service_tier||r.speed; let multiplier=1; if(speed && !['standard','default'].includes(speed)) {if(model==='gpt-6-astra'&&['fast','priority'].includes(speed)) multiplier=2.5; else return null;}
 return ((vals[0]-vals[1])*rates[0]+vals[1]*rates[1]+vals[2]*rates[2])/1e6*multiplier;
}
function boundary(value,end=false) { const n=Date.parse(value); if(!Number.isFinite(n)) throw Error('Invalid date: '+value); return n+(end&&/^\d{4}-\d{2}-\d{2}$/.test(value)?86400000:0); }
function goalSummary(rows,blocks,includeText=false,since=-Infinity) {
 const goals=new Map(),turns=new Map(),usageByGoal=new Map();
 const actor=r=>r.agent_id||r.session_id;
 const tk=r=>JSON.stringify([r.session_id,actor(r),r.turn_id]);
 for(const r of rows) {
  const id=r.goal_id||(r.event==='turn_started'&&r.turn_id?'legacy-request:'+actor(r)+':'+r.turn_id:turns.get(tk(r)));
  if(!id)continue;turns.set(tk(r),id);
  const key=JSON.stringify([r.session_id,id]);
  if(!goals.has(key))goals.set(key,{id,session_id:r.session_id,source:r.goal_source||(r.goal_id?'explicit':'legacy_request'),parent_goal_id:r.parent_goal_id||null,outcome:null,response_status:null,requests:[],results:[],block_ids:[],active_union_seconds:null,agent_compute_seconds:null});
  const g=goals.get(key);
  if(r.token_usage&&Date.parse(r.recorded_at)>=since){if(!usageByGoal.has(key))usageByGoal.set(key,new Map());usageByGoal.get(key).set(JSON.stringify([actor(r),r.turn_id,r.usage_scope,r.usage_kind]),r);}
  if(r.goal_outcome)g.outcome=r.goal_outcome;
  if(r.response_status)g.response_status=r.response_status;
  else if(['turn_completed','subagent_completed'].includes(r.event))g.response_status='completed';
  else if(r.event==='turn_interrupted')g.response_status='interrupted';
  for(const [field,textField,truncatedField]of [['requests','request_excerpt','request_truncated'],['results','result_summary','result_truncated']])if(r[textField]!=null)g[field].push({event_id:r.event_id||null,recorded_at:r.recorded_at,truncated:r[truncatedField]??null,...(includeText?{text:r[textField]}:{})});
 }
 for(const g of goals.values()) {
  const usages=[...(usageByGoal.get(JSON.stringify([g.session_id,g.id]))||new Map()).values()],totals=new Map();
  g.unallocated_usage_snapshots=usages.filter(r=>!r.usage_additive||!['turn_delta','session_delta','adapter_delta'].includes(r.usage_kind)).length;
  for(const r of usages)if(r.usage_additive&&['turn_delta','session_delta','adapter_delta'].includes(r.usage_kind)){
   const key=JSON.stringify([actor(r),usageModel(r),r.usage_scope]);if(!totals.has(key))totals.set(key,{agent_id:actor(r),model:usageModel(r)||null,scope:r.usage_scope,tokens:{input_tokens:0,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0},estimated_credits:0,unpriced_records:0});const t=totals.get(key);
   for(const k of Object.keys(t.tokens))t.tokens[k]=t.tokens[k]!==null&&Number.isFinite(r.token_usage[k])?t.tokens[k]+r.token_usage[k]:null;
   const price=credits(r);if(price===null)t.unpriced_records++;else t.estimated_credits+=price;
  }
  g.additive_usage=[...totals.values()];
  const selected=blocks.filter(b=>b.session_id===g.session_id&&(b.goal_id||turns.get(JSON.stringify([b.session_id,b.agent_id,b.turn_id])))===g.id);
  g.block_ids=selected.map(b=>b.id);const known=selected.filter(b=>b.seconds!==null),byActor=new Map();
  g.unknown_blocks=selected.length-known.length;
  for(const b of known){if(!byActor.has(b.agent_id))byActor.set(b.agent_id,[]);byActor.get(b.agent_id).push([Date.parse(b.start),Date.parse(b.end)]);}
  if(known.length){g.active_union_seconds=seconds(known.map(b=>[Date.parse(b.start),Date.parse(b.end)]));g.agent_compute_seconds=[...byActor.values()].reduce((n,x)=>n+seconds(x),0);}
 }
 return [...goals.values()];
}
function diagnostics(rows,blocks) {
 const completed=rows.filter(r=>['turn_completed','subagent_completed','turn_interrupted'].includes(r.event));
 return {completed_events:completed.length,completed_without_usage:completed.filter(r=>!r.token_usage).length,unknown_duration_blocks:blocks.filter(b=>b.seconds===null).length,explicit_goal_events:rows.filter(r=>r.goal_id&&r.goal_source!=='request').length,request_goal_events:rows.filter(r=>r.goal_source==='request').length,legacy_events_without_goal:rows.filter(r=>!r.goal_id).length,observed_effort_events:rows.filter(r=>r.observed_effort).length,truncated_requests:rows.filter(r=>r.request_truncated===true).length,truncated_results:rows.filter(r=>r.result_truncated===true).length,agent_launches:new Set(rows.filter(r=>r.created_agent_id).map(r=>r.created_agent_id)).size};
}
function transcriptFallback(rows, home, session) {
 const ids=linked(rows,session), additions=[], notes=[];
 function walk(dir) { if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})) {const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.isFile()&&e.name.endsWith('.jsonl')) {const id=[...ids].find(id=>e.name.endsWith(id+'.jsonl'));if(!id)continue;if(fs.statSync(f).size>64*1024*1024){notes.push('Transcript exceeds 64 MiB: '+id);continue;}const pending=[];const matches=x=>(x.agent_id||x.session_id)===id;const native=rows.find(x=>x.agent_id===id);const identity=native?{session_id:native.session_id,agent_id:id}:{session_id:id};let meta=null,latest=null;const models=new Set();let turn=null;const starts=new Map();
 for(const line of fs.readFileSync(f,'utf8').split(/\r?\n/)){let r;try{r=JSON.parse(line);}catch{continue;}const p=r.payload||{};if(r.type==='session_meta')meta=p;if(r.type==='turn_context'&&p.model)models.add(p.model);if(r.type!=='event_msg')continue;
 if(p.type==='task_started'){turn=p.turn_id;starts.set(turn,r.timestamp);}
 if(['task_complete','task_completed','turn_aborted'].includes(p.type)){const tid=p.turn_id||turn;if(!rows.some(x=>matches(x)&&x.turn_id===tid&&['turn_completed','turn_interrupted','subagent_completed'].includes(x.event)))pending.push({...identity,turn_id:tid,event:p.type==='turn_aborted'?'turn_interrupted':native?'subagent_completed':'turn_completed',recorded_at:r.timestamp,started_at:starts.get(tid),project_root:meta?.cwd,interaction_class:'UNKNOWN'});starts.delete(tid);}
 if(p.type==='token_count'&&p.info?.total_token_usage)latest={timestamp:r.timestamp,usage:p.info.total_token_usage};}
 if(meta?.id!==id){notes.push('Transcript identity mismatch: '+id);continue;}
 additions.push(...pending);
 if(latest&&!rows.some(x=>matches(x)&&x.token_usage&&Date.parse(x.recorded_at)>=Date.parse(latest.timestamp)))additions.push({...identity,event:'usage_snapshot',recorded_at:latest.timestamp,project_root:meta.cwd,observed_model:models.size===1?[...models][0]:null,usage_scope:'transcript_session',usage_kind:'cumulative_snapshot',usage_additive:false,token_usage:latest.usage});
 for(const [tid,at]of starts)if(!rows.some(x=>matches(x)&&x.turn_id===tid&&x.event==='turn_started'))additions.push({...identity,turn_id:tid,event:'turn_started',recorded_at:at,project_root:meta.cwd});
 notes.push('Transcript fallback inspected '+id+'; cumulative tokens may include inherited history; model attribution withheld when mixed.');
 }} }
 walk(path.join(home,'sessions'));walk(path.join(home,'archived_sessions'));return {rows:[...rows,...additions].sort((a,b)=>Date.parse(a.recorded_at)-Date.parse(b.recorded_at)),notes};
}
function build(all,opt={}) {
 const now=opt.now??Date.now(), mode=opt.mode||'report';
 if(mode==='current'&&!opt.session) throw Error('Current session ID unavailable; pass --session. No latest-task guessing.');
 const days=Number(opt.days??7); if(!Number.isFinite(days)||days<=0) throw Error('--days must be positive');
 const end=opt.to?boundary(opt.to,true):now, start=opt.from?boundary(opt.from):mode==='current'&&!opt.days?-Infinity:end-days*86400000;
 if(start>=end) throw Error('Empty or reversed period');
 const ids=opt.session?linked(all,opt.session):null;
 const rows=all.filter(r=>(ids?(ids.has(r.session_id)||ids.has(r.agent_id)):norm(r.project_root||r.cwd||'/unknown')===norm(opt.project))&&(!opt.model||r.observed_model===opt.model)&&(!opt.workflow||r.workflow===opt.workflow)&&Date.parse(r.recorded_at)<=end);
 const starts=new Map(), blocks=new Map(), usage=new Map(), agents=new Map();
 const actor=r=>r.agent_id||r.session_id||'unknown';
 const key=r=>[r.session_id,r.agent_id||'root',r.spark_call_id||r.call_id||r.turn_id||'unknown'].join('|');
 function agent(r) { const id=actor(r); if(!agents.has(id)) agents.set(id,{id,session_id:r.session_id||null,parent_id:r.parent_agent_id||r.parent_session_id||(r.agent_id?r.session_id:null)||null,models:[],profiles:[],observed_efforts:[],requested_efforts:[],configured_efforts:[],intervals:[],open_blocks:0}); const a=agents.get(id); for(const [k,v] of [['models',r.observed_model],['profiles',r.profile],['observed_efforts',r.observed_effort],['requested_efforts',r.requested_effort],['configured_efforts',r.configured_effort]]) if(v&&!a[k].includes(v)) a[k].push(v); return a; }
 for(const r of rows) {
  const k=key(r), t=Date.parse(r.recorded_at);
  if(['turn_started','subagent_started'].includes(r.event)&&(!starts.has(k)||r.event==='turn_started'&&starts.get(k).event==='subagent_started')) starts.set(k,r);
  if(['turn_completed','turn_interrupted','subagent_completed'].includes(r.event)) {
   const begun=starts.get(k), finish=Date.parse(r.ended_at||r.recorded_at), rawStart=Date.parse(begun?.started_at||begun?.recorded_at||r.started_at);
   const duration=r.turn_wall_clock??r.subagent_wall_clock??r.wall_clock_seconds;
   const begin=Number.isFinite(rawStart)?rawStart:Number.isFinite(duration)&&duration>=0?finish-duration*1000:NaN;
   starts.delete(k);
   if(r.event==='subagent_completed')for(const [sk,sr]of starts)if(sr.session_id===r.session_id&&sr.agent_id===r.agent_id&&sr.event==='subagent_started')starts.delete(sk);
   if(finish>=start&&begin<=end || !Number.isFinite(begin)&&t>=start) blocks.set(k,{id:k,session_id:r.session_id,turn_id:r.turn_id,goal_id:r.goal_id||begun?.goal_id||null,agent_id:actor(r),stage:r.stage_id||r.goal_id||r.turn_id||null,interaction:r.interaction_class||'UNKNOWN',start:Number.isFinite(begin)?new Date(Math.max(start,begin)).toISOString():null,end:new Date(Math.min(end,finish)).toISOString(),seconds:Number.isFinite(begin)&&finish>=begin?Math.max(0,(Math.min(end,finish)-Math.max(start,begin))/1000):null,status:r.event});
  }
  if(t>=start) {agent(r); if(r.token_usage) {const uk=[k,r.usage_scope||'unknown',r.usage_kind||'unknown'].join('|'); usage.set(uk,r);} }
 }
 for(const [k,r] of starts) {agent(r).open_blocks++;blocks.set(k,{id:k,session_id:r.session_id,turn_id:r.turn_id,goal_id:r.goal_id||null,agent_id:actor(r),stage:r.stage_id||r.goal_id||r.turn_id||null,interaction:r.interaction_class||'UNKNOWN',start:r.started_at||r.recorded_at,end:null,seconds:null,status:'open'});}
 const usageGroups=new Map();
 for(const r of [...usage.values()].sort((a,b)=>Date.parse(a.recorded_at)-Date.parse(b.recorded_at))) {
  const additive=r.usage_additive===true&&['turn_delta','session_delta','adapter_delta'].includes(r.usage_kind);
  const groupKey=JSON.stringify([actor(r),additive?usageModel(r)||'unknown':'snapshot',r.usage_scope||'unknown',additive?'delta':r.usage_kind||'unknown']);
  if(!usageGroups.has(groupKey)) usageGroups.set(groupKey,{agent_id:actor(r),model:usageModel(r)||'unknown',scope:r.usage_scope||'unknown',kind:additive?'additive_deltas':r.usage_kind||'unknown',records:0,tokens:{input_tokens:0,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0},estimated_credits:0,unpriced_records:0});
  const g=usageGroups.get(groupKey); g.records++;
  if(!additive)g.model=usageModel(r)||'unknown';
  for(const name of Object.keys(g.tokens)) {const v=r.token_usage[name]; g.tokens[name]=additive?(g.tokens[name]===null||!Number.isFinite(v)?null:g.tokens[name]+v):(Number.isFinite(v)?v:null);}
  const price=credits(r); if(additive) {if(price===null) g.unpriced_records++; else g.estimated_credits+=price;} else {g.estimated_credits=price;g.unpriced_records=price===null?1:0;}
 }
 const intervals=[], breakdown={};
 for(const b of blocks.values()) if(b.seconds!==null) {const pair=[Date.parse(b.start),Date.parse(b.end)];intervals.push(pair);const a=agents.get(b.agent_id);if(a)a.intervals.push(pair);breakdown[b.interaction]=(breakdown[b.interaction]||0)+b.seconds;}
 const times=rows.filter(r=>Date.parse(r.recorded_at)>=start).map(r=>Date.parse(r.recorded_at));
 const modelScopes=new Map();for(const g of usageGroups.values()) if(g.kind==='additive_deltas') {const k=g.model+'|'+g.scope; if(!modelScopes.has(k))modelScopes.set(k,{model:g.model,scope:g.scope,estimated_credits:0,unpriced_records:0});const a=modelScopes.get(k);a.estimated_credits+=g.estimated_credits;a.unpriced_records+=g.unpriced_records;}
 return {schema_version:2,goals:goalSummary(rows,[...blocks.values()],opt.includeText,start).filter(g=>g.block_ids.length||g.requests.some(r=>Date.parse(r.recorded_at)>=start)||g.results.some(r=>Date.parse(r.recorded_at)>=start)),coverage:diagnostics(rows.filter(r=>Date.parse(r.recorded_at)>=start),[...blocks.values()]),mode,project:opt.project,session_id:opt.session||null,period:{from:Number.isFinite(start)?new Date(start).toISOString():times.length?new Date(Math.min(...times)).toISOString():null,to:new Date(end).toISOString(),timezone:'UTC'},event_count:times.length,linked_ids:ids?[...ids]:[],active_union_seconds:seconds(intervals),observed_wall_span_seconds:times.length?(Math.max(...times)-Math.min(...times))/1000:null,agent_compute_seconds:[...agents.values()].reduce((s,a)=>s+seconds(a.intervals),0),breakdown_compute_seconds:breakdown,agents:[...agents.values()].map(({intervals,...a})=>({...a,active_seconds:intervals.length?seconds(intervals):null})),blocks:[...blocks.values()],usage:[...usageGroups.values()],credits_by_model_and_scope:[...modelScopes.values()],pricing:{source:card.source,verified_at:card.verified_at,assumption:'Standard speed unless observed; partial priced subtotals only; snapshots separate; no cross-scope grand total or subscription percentage'},limitations:['Only recorded events and explicit child links; missing data are not zero.','Current/open turn tokens and duration may not yet be recorded.','Snapshots are latest observed values, may include usage outside the selected period, and are NOT added to deltas.','Agent time is compute time, not human effort. Named blocks require recorded stage/goal IDs.']};
}
const esc=x=>String(x??'unknown').replace(/[|\r\n]/g,' ');
function markdown(r) {return '# Timesheet\n\n'+`Период UTC: ${r.period.from||'нет данных'} — ${r.period.to}\n\nПроект: ${esc(r.project)}; задача: ${esc(r.session_id)}. Событий: ${r.event_count}.\n\nАктивное время без пересечений: ${r.active_union_seconds} с. Наблюдаемый интервал (включая паузы): ${r.observed_wall_span_seconds??'неизвестно'} с. Вычислительное время агентов: ${r.agent_compute_seconds} с.\n\n`+'## Агенты\n\n| ID | Модели | Профили | Активно, с | Открытых блоков |\n|---|---|---|---:|---:|\n'+r.agents.map(a=>`| ${esc(a.id)} | ${esc(a.models.join(', '))} | ${esc(a.profiles.join(', '))} | ${a.active_seconds??'неизвестно'} | ${a.open_blocks} |`).join('\n')+'\n\n## Токены и оценка кредитов\n\nInput включает cached; reasoning не прибавляется повторно к output. Snapshots не суммируются с дельтами.\n\n| Агент / модель | Scope / вид | Input | Cached | Output | Reasoning | Кредиты (оценка) | Не оценено |\n|---|---|---:|---:|---:|---:|---:|---:|\n'+r.usage.map(g=>`| ${esc(g.agent_id)} / ${esc(g.model)} | ${esc(g.scope)} / ${g.kind} | ${g.tokens.input_tokens??'?'} | ${g.tokens.cached_input_tokens??'?'} | ${g.tokens.output_tokens??'?'} | ${g.tokens.reasoning_output_tokens??'?'} | ${g.estimated_credits??'?'} | ${g.unpriced_records} |`).join('\n')+'\n\n## Блоки\n\n| ID этапа/хода | Агент | Тип | Секунды | Статус |\n|---|---|---|---:|---|\n'+r.blocks.map(b=>`| ${esc(b.stage)} | ${esc(b.agent_id)} | ${esc(b.interaction)} | ${b.seconds??'?'} | ${b.status} |`).join('\n')+goalMarkdown(r)+'\n\n## Ограничения\n\n'+r.limitations.map(s=>'- '+s).join('\n')+'\n\n'+r.pricing.assumption+`\n\n[Официальные ставки](${card.source}), проверены ${card.verified_at}.\n`;}
function goalMarkdown(r) {
 return '\n\n## Полнота телеметрии\n\n'+`Завершений без токенов: ${r.coverage.completed_without_usage}/${r.coverage.completed_events}. Блоков с неизвестным временем: ${r.coverage.unknown_duration_blocks}. Запусков уникальных дочерних агентов: ${r.coverage.agent_launches}.\n\n`+
 '## Цели и запросы\n\nRequest/legacy_request — запись запроса, а не распознанная бизнес-цель. Завершение ответа не подтверждает достижение цели. Время здесь относится к собственным блокам; дочерние цели связаны parent_goal_id в JSON.\n\n| ID | Источник | Исход цели | Ответ | Время без пересечений, с |\n|---|---|---|---|---:|\n'+r.goals.map(g=>`| ${esc(g.id)} | ${esc(g.source)} | ${esc(g.outcome)} | ${esc(g.response_status)} | ${g.active_union_seconds??'?'} |`).join('\n')+
 r.goals.filter(g=>[...g.requests,...g.results].some(x=>x.text)).map(g=>'\n\n'+esc(g.id)+'\n\n'+[...g.requests.map(x=>({...x,label:'Запрос'})),...g.results.map(x=>({...x,label:'Результат'}))].filter(x=>x.text).map(x=>x.label+': '+esc(x.text)+(x.truncated?' [сокращено]':'')).join('\n\n')).join('')+
 '\n\n## Reasoning level\n\n| Агент | Наблюдаемый | Запрошенный | Профиль |\n|---|---|---|---|\n'+r.agents.map(a=>`| ${esc(a.id)} | ${a.observed_efforts.join(', ')||'?'} | ${a.requested_efforts.join(', ')||'?'} | ${a.configured_efforts.join(', ')||'?'} |`).join('\n');
}
function main(args) {
 if(args.includes('--help')) {console.log('timesheet.cjs report|save|current --project PATH [--days N | --from ISO --to ISO] [--session ID] [--model ID] [--workflow NAME] [--home PATH] [--out FILE] [--include-text]');return;}
 const mode=args.shift()||'report',opt={mode};if(!['report','save','current'].includes(mode))throw Error('Unknown mode');
 for(let i=0;i<args.length;i+=2) {if(args[i]==='--include-text'){opt.includeText=true;i--;continue;}const k=args[i].replace(/^--/,'');if(!['project','days','from','to','session','model','workflow','home','out'].includes(k)||!args[i+1]||args[i+1].startsWith('--'))throw Error('Invalid option '+args[i]);opt[k]=args[i+1];}
 opt.project=projectRoot(opt.project||process.cwd());if(mode==='current')opt.session ||= process.env.CODEX_THREAD_ID||process.env.CODEX_SESSION_ID;
 const dir=path.join(opt.home||process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'timesheets');
 const files=process.env.CODEX_TIMESHEET_PATH?[path.resolve(process.env.CODEX_TIMESHEET_PATH)]:fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>/^events-\d{4}-\d{2}\.jsonl$/.test(n)).sort().map(n=>path.join(dir,n)):[];
 const data=load(files);const fallback=mode==='current'&&opt.session?transcriptFallback(data.rows,opt.home||process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),opt.session):{rows:data.rows,notes:[]};
 const r=build(fallback.rows,opt);r.limitations.push(...fallback.notes);r.invalid_records=data.invalid;r.source_files=files;
 if(!files.length)r.limitations.push('No telemetry journals found.');if(data.invalid)r.limitations.push(data.invalid+' malformed records skipped.');
 const totals='\n## Итоги по моделям и scope (только аддитивные дельты)\n\n| Модель | Scope | Оценённая часть, кредиты | Записей без оценки |\n|---|---|---:|---:|\n'+r.credits_by_model_and_scope.map(g=>`| ${esc(g.model)} | ${esc(g.scope)} | ${g.estimated_credits} | ${g.unpriced_records} |`).join('\n')+'\n';
 const content=mode==='save'?JSON.stringify(r,null,2)+'\n':markdown(r)+totals;
 if(mode==='current'&&!opt.out)console.log(content);else {const file=path.resolve(opt.out||path.join(opt.project,'.scratch','timesheets',mode+'-'+new Date().toISOString().replace(/[:.]/g,'-')+(mode==='save'?'.json':'.md')));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content,{flag:'wx'});console.log(file);}
}
if(require.main===module)try{main(process.argv.slice(2));}catch(e){console.error(e.message);process.exitCode=1;}
module.exports={build,credits,linked,load,markdown,main,transcriptFallback};

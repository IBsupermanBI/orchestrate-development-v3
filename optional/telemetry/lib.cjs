'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const hash = x => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const read = (p, fallback = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch(e) { if(e.code === 'ENOENT') return fallback; throw e; } };
function lock(file, action) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const name = file + '.lock', until = Date.now()+700; let fd;
  while(fd === undefined) {
    try { fd = fs.openSync(name,'wx'); }
    catch(e) {
      if(e.code !== 'EEXIST' || Date.now()>until) throw e;
      try { if(Date.now()-fs.statSync(name).mtimeMs>30000) fs.unlinkSync(name); } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15);
    }
  }
  try { return action(); } finally { fs.closeSync(fd); fs.unlinkSync(name); }
}
function write(file, value) { fs.mkdirSync(path.dirname(file),{recursive:true}); const tmp=file+'.'+crypto.randomUUID()+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n'); fs.renameSync(tmp,file); }
function root(cwd) { let p=path.resolve(cwd); for(;;) { if(fs.existsSync(path.join(p,'.git'))) return p; const up=path.dirname(p); if(up===p) return null; p=up; } }
function ledgerPath(cwd, session) { return path.join(root(cwd)||path.resolve(cwd),'.scratch','orchestration-hooks','state-orchestrate-development-v3-'+String(session).replace(/[^A-Za-z0-9_.-]/g,'_')+'.json'); }
const profiles = {
 'astra-low-worker':['gpt-6-astra','low','IMPLEMENTATION'],
 'luna-xhigh-worker':['gpt-5.6-luna','xhigh','REPAIR'],
 'luna-xhigh-fixer':['gpt-5.6-luna','xhigh','REPAIR'],
 'loop-terra-high-gate':['gpt-5.6-terra','high','VALIDATION'],
 'terra-high-gate':['gpt-5.6-terra','high','VALIDATION'],
 'sol-medium-plan-reviewer':['gpt-5.6-sol','medium','PLAN_REVIEW'],
 'sol-medium-code-reviewer':['gpt-5.6-sol','medium','REVIEW'],
 'v3-sol-medium-reviewer':['gpt-5.6-sol','medium','REVIEW'],
 'v3-luna-xhigh-validator':['gpt-5.6-luna','xhigh','VALIDATION'],
 'sol-medium-decision-reviewer':['gpt-5.6-sol','medium','REVIEW']
};
const classes = ['DIRECT','ORCHESTRATION','IMPLEMENTATION','INVESTIGATION','REPAIR','REVIEW','PLAN_REVIEW','VALIDATION','COORDINATION','SPARK','OTHER'];
function redact(value, limit=600) {
 if(process.env.CODEX_TIMESHEET_CAPTURE_TEXT==='0'||value==null) return null;
 return String(value).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[REDACTED]')
 .replace(/\b(?:Authorization\s*[:=]\s*|Bearer\s+)[^\r\n,;]+/gi,'[REDACTED]')
 .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)["']?\s*[:=]\s*)["']?[^\s,"';}]+["']?/gi,'$1[REDACTED]')
 .replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,'[REDACTED]')
 .replace(/\s+/g,' ').trim().slice(0,limit);
}
const keys=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
function usage(v) { if(!v||typeof v!=='object') return null; return Object.fromEntries(keys.map(k=>[k,Number.isFinite(v[k])&&v[k]>=0?v[k]:null])); }
module.exports={fs,path,hash,read,lock,write,root,ledgerPath,profiles,classes,redact,keys,usage};

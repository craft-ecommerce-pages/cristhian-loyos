const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const src=fs.readFileSync(require.resolve('./catalog.js'),'utf8');
// Ejecuta las funciones reales del motor sin DOM ni red.
const code=src.slice(src.indexOf('    function storeHoursState('),src.indexOf('    /* ── CATEGORY STRIP'));
const context=vm.createContext({config:{},isEN:()=>false});
vm.runInContext(code,context);
const hours={tz:'America/Guayaquil',allow_preorders:true,weekly:{0:[['12:30','20:30']],1:[['15:00','22:00']],2:[['15:00','22:00']],3:[['15:00','22:00']],4:[['15:00','22:00']],5:[['15:00','23:00']],6:[['12:30','22:00']]}};
test('horario definitivo, límites y próxima apertura',()=>{
  for(const [at,open,next] of [
    ['2026-09-14T14:59:00-05:00',false,'15:00'],
    ['2026-09-14T15:00:00-05:00',true,'15:00'],
    ['2026-09-14T22:00:00-05:00',false,'15:00'],
    ['2026-09-18T22:59:00-05:00',true,'12:30'],
    ['2026-09-18T23:00:00-05:00',false,'12:30'],
    ['2026-09-19T12:30:00-05:00',true,'12:30'],
    ['2026-09-19T22:00:00-05:00',false,'12:30'],
    ['2026-09-20T20:30:00-05:00',false,'15:00'],
  ]){const s=context.storeHoursState(hours,new Date(at));assert.equal(s.open,open,at);assert.equal(s.preorder,!open,at);assert.ok(s.next.includes(next),s.next);}
});
test('anticipos solo opt-in y madrugada del día anterior',()=>{
  assert.equal(context.storeHoursState({...hours,allow_preorders:false},new Date('2026-09-14T10:00:00-05:00')).preorder,false);
  const h={tz:'UTC',allow_preorders:true,weekly:{5:[['20:00','02:00']]}};
  assert.equal(context.storeHoursState(h,new Date('2026-09-18T01:00:00Z')).open,false);
  assert.equal(context.storeHoursState(h,new Date('2026-09-19T01:59:00Z')).open,true);
  assert.equal(context.storeHoursState(h,new Date('2026-09-19T02:00:00Z')).preorder,true);
  assert.equal(context.storeHoursState(h,new Date('2026-09-21T12:00:00Z')).preorder,true);
  assert.equal(context.storeHoursState(undefined).open,true);
});

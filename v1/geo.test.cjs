const {test}=require('node:test');
const assert=require('node:assert/strict');
const {nearest,hasCoverage,create}=require('./geo.js');

test('gana la más cercana dentro de su propio radio; cero es válido',()=>{
  const sedes=[{id:'cerca',lat:0,lng:0.01,radio_km:0.1},{id:'cubre',lat:0,lng:0.02,radio_km:3},{id:'lejos',lat:0,lng:0.03,radio_km:10}];
  assert.equal(nearest(0,0,sedes).id,'cubre');assert.equal(nearest(20,20,sedes),null);
  assert.equal(nearest(0,0,[{id:'cero',lat:0,lng:0,radio_km:1}]).id,'cero');
  const boundary={id:'borde',lat:0,lng:1,radio_km:6371*Math.PI/180};
  assert.equal(nearest(0,0,[boundary]),boundary);boundary.radio_km-=0.001;assert.equal(nearest(0,0,[boundary]),null);
});
test('rechaza coordenadas ausentes, inválidas y radios inválidos',()=>{
  for(const s of [{id:'a',radio_km:1},{id:'a',lat:null,lng:null,radio_km:1},{id:'a',lat:91,lng:0,radio_km:1},{id:'a',lat:0,lng:0,radio_km:Infinity},{id:'a',lat:0,lng:0,radio_km:0}])assert.equal(hasCoverage(s),false);
  assert.equal(nearest(NaN,0,[]),null);assert.equal(nearest(0,181,[]),null);
});
test('legacy sin sedes no solicita ubicación ni requiere DOM',()=>{
  const geo=create({whatsapp_number:'+593 99 123'});assert.equal(geo.enabled,false);assert.equal(geo.require(),true);assert.equal(geo.phone(),'59399123');assert.equal(geo.note(),'');
});

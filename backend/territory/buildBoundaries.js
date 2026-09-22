// Build-time only: US Atlas 3.0.1, Census 2017 1:10m boundaries (see README).
const fs=require('fs');
const {feature,merge}=require('topojson-client');
const counties=require('us-atlas/counties-10m.json');
const states=require('us-atlas/states-10m.json');
const codes='01 AL,02 AK,04 AZ,05 AR,06 CA,08 CO,09 CT,10 DE,11 DC,12 FL,13 GA,15 HI,16 ID,17 IL,18 IN,19 IA,20 KS,21 KY,22 LA,23 ME,24 MD,25 MA,26 MI,27 MN,28 MS,29 MO,30 MT,31 NE,32 NV,33 NH,34 NJ,35 NM,36 NY,37 NC,38 ND,39 OH,40 OK,41 OR,42 PA,44 RI,45 SC,46 SD,47 TN,48 TX,49 UT,50 VT,51 VA,53 WA,54 WV,55 WI,56 WY'.split(',').map(s=>s.split(' '));
const output={};
for(const [id,code] of codes)output[code]=feature(states,states.objects.states.geometries.find(g=>g.id===id)).geometry;
const defs={
 'South Texas':['48','Aransas,Atascosa,Bandera,Bee,Bexar,Brooks,Calhoun,Cameron,Comal,DeWitt,Dimmit,Duval,Edwards,Frio,Goliad,Gonzales,Guadalupe,Hidalgo,Jackson,Jim Hogg,Jim Wells,Karnes,Kendall,Kenedy,Kerr,Kinney,Kleberg,La Salle,Lavaca,Live Oak,Maverick,McMullen,Medina,Nueces,Real,Refugio,San Patricio,Starr,Uvalde,Val Verde,Victoria,Webb,Willacy,Wilson,Zapata,Zavala'],
 'Central Valley CA':['06','Butte,Colusa,Glenn,Fresno,Kern,Kings,Madera,Merced,Placer,San Joaquin,Sacramento,Shasta,Stanislaus,Sutter,Tehama,Tulare,Yolo,Yuba'],
 'Southern California':['06','Imperial,Kern,Los Angeles,Orange,Riverside,San Bernardino,San Diego,San Luis Obispo,Santa Barbara,Ventura'],
 'Central Florida':['12','Brevard,Citrus,Flagler,Hernando,Hillsborough,Lake,Marion,Orange,Osceola,Pasco,Pinellas,Polk,Seminole,Sumter,Volusia'],
 'South Florida':['12','Broward,Charlotte,Collier,DeSoto,Glades,Hardee,Hendry,Highlands,Indian River,Lee,Manatee,Martin,Miami-Dade,Monroe,Okeechobee,Palm Beach,Sarasota,St. Lucie'],
 'Southern Nevada':['32','Clark,Esmeralda,Lincoln,Nye']
};
for(const [name,[state,list]] of Object.entries(defs)) {
 const names=list.split(',');const gs=counties.objects.counties.geometries.filter(g=>g.id.startsWith(state)&&names.includes(g.properties.name));
 if(gs.length!==names.length)throw Error(name+': missing '+names.filter(n=>!gs.some(g=>g.properties.name===n)));
 output[name]=merge(counties,gs);
}
for(const [name,state,except] of [['Northern California','06',['Southern California']],['North Florida','12',['Central Florida','South Florida']],['Northern Nevada','32',['Southern Nevada']]]) {
 const omitted=except.flatMap(n=>defs[n][1].split(','));
 output[name]=merge(counties,counties.objects.counties.geometries.filter(g=>g.id.startsWith(state)&&!omitted.includes(g.properties.name)));
}
// 4 decimal degrees retains approximately 11m resolution of this general-purpose atlas.
fs.writeFileSync(__dirname+'/boundaries.json',JSON.stringify(output,(k,v)=>typeof v==='number'?Math.round(v*10000)/10000:v)+'\n');

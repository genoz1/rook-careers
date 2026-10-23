'use strict';
const sharp=require('sharp'),path=require('node:path');
const {catalog}=require('./marketing');
const {escape}=require('./security');
const esc=s=>escape(String(s)).replace(/&#39;/g,'&apos;');
function lines(text,max){const out=[];let row='';for(const word of text.split(/\s+/)){if(row.length+word.length+1>max){out.push(row);row='';}row+=(row?' ':'')+word;}if(row)out.push(row);return out;}
const cache=new Map();
async function render(id){
 if(cache.has(id))return cache.get(id);const t=catalog.find(t=>t.id===id);if(!t)throw Error('Unknown ROOK creative');
 const light=t.design===1,bg=light?'#f4f8f8':'#071e41',ink=light?'#071e41':'#ffffff',muted=light?'#45616c':'#b5d5e3',accent='#31d8cc';
 const title=lines(t.headline,26),eyebrow={opportunities:'FIND YOUR NEXT OPPORTUNITY',advice:'MAKE YOUR NEXT MOVE COUNT',benefits:'BUILT FOR YOUR CAREER',preparation:'WALK IN PREPARED',insights:'KNOW YOUR MARKET'}[t.category];
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="${bg}"/>
 <circle cx="1110" cy="130" r="280" fill="${light?'#dceeed':'#12394e'}"/><circle cx="1140" cy="560" r="185" fill="${light?'#c7e4df':'#16475a'}"/>
 ${t.design===2?`<rect x="884" y="218" width="226" height="220" rx="28" fill="${accent}"/><path d="M930 328h130m-45-45 45 45-45 45" fill="none" stroke="#071e41" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>`:`<path d="M900 380h190m-55-55 55 55-55 55" fill="none" stroke="${accent}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>`}
 <rect x="62" y="42" width="250" height="82" rx="10" fill="white"/>
 <text x="64" y="178" font-family="sans-serif" font-size="18" letter-spacing="2.1" font-weight="700" fill="${light?'#146171':accent}">${eyebrow}</text>
 <g font-family="sans-serif" font-size="58" font-weight="700" fill="${ink}">${title.map((line,i)=>`<text x="60" y="${263+i*70}">${esc(line)}</text>`).join('')}</g>
 <text x="64" y="480" font-family="sans-serif" font-size="24" fill="${muted}">Medical &amp; veterinary sales careers</text>
 <path d="M64 525h1070" stroke="${light?'#c9dadd':'#31516f'}"/>
 <text x="64" y="582" font-family="sans-serif" font-size="24" font-weight="700" fill="${ink}">rookcareers.com</text>
 <text x="1115" y="582" text-anchor="end" font-family="sans-serif" font-size="22" fill="${light?'#146171':accent}">Your next move starts here →</text></svg>`;
 const logo=await sharp(path.join(__dirname,'../../public/assets/rook-full-logo-900.png')).resize({width:220,height:66,fit:'inside'}).png().toBuffer();
 const image=await sharp(Buffer.from(svg)).composite([{input:logo,left:77,top:50}]).jpeg({quality:90}).toBuffer();cache.set(id,image);return image;
}
module.exports={render};

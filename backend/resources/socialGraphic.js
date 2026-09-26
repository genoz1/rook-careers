// Resources variant of ROOK's existing deterministic Sharp social graphics.
// Native-resolution typography avoids enlarging the small website thumbnails.
const sharp=require('sharp');
const path=require('path');
const {category}=require('./catalog');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function lines(text,max){
 const rows=[];let row='';
 for(const word of text.split(/\s+/)){if(row&&row.length+word.length+1>max){rows.push(row);row='';}row+=(row?' ':'')+word;}
 if(row)rows.push(row);return rows;
}
async function renderResourceGraphic(article){
 const title=String(article.title).trim();
 if(!title||title.length>240)throw Error('Invalid resource graphic title');
 const rows=lines(title,29),font=rows.length>5?46:58,lineHeight=font*1.25;
 const label=category(article.category)?.label||'Career Advice';
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
 <rect width="1080" height="1080" fill="#071e41"/><rect x="64" y="48" width="370" height="125" rx="8" fill="white"/><rect x="64" y="242" width="92" height="6" rx="3" fill="#43e7e9"/>
 <text x="64" y="210" fill="#43e7e9" font-family="sans-serif" font-size="25" font-weight="700" letter-spacing="3">CAREER RESOURCES</text>
 <text x="64" y="307" fill="#9dc9f1" font-family="sans-serif" font-size="25">${esc(label)}</text>
 <g fill="white" font-family="sans-serif" font-size="${font}" font-weight="700">${rows.map((r,i)=>`<text x="64" y="${408+i*lineHeight}">${esc(r)}</text>`).join('')}</g>
 <rect x="64" y="854" width="952" height="2" fill="#31516f"/>
 <text x="64" y="919" fill="white" font-family="sans-serif" font-size="27" font-weight="700">MEDICAL &amp; VETERINARY SALES CAREERS</text>
 <text x="64" y="973" fill="#9dc9f1" font-family="sans-serif" font-size="25">Practical guides. Your next career move.</text>
 <path d="M946 964h52m-17-17 17 17-17 17" fill="none" stroke="#43e7e9" stroke-width="5"/>
 </svg>`;
 const logo=await sharp(path.join(__dirname,'../../public/assets/rook-full-logo-900.png')).resize({width:340,height:110,fit:'inside',withoutEnlargement:true}).png().toBuffer();
 return sharp(Buffer.from(svg)).composite([{input:logo,left:79,top:56}]).jpeg({quality:92}).toBuffer();
}
module.exports={renderResourceGraphic};

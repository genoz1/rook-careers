const text = `Jordan Test — synthetic acceptance résumé
Account Executive — Example Diagnostics
January 2020 – December 2025
6 years of diagnostics sales experience.
Sold Diagnostics products to Physicians.
Hunter and Account Management responsibilities in Florida.
Exceeded quota by 20% in 2024.
Sales Associate — Example Supply
No dates or accomplishments provided for this role.`;
const structured = {
 industries_experience:[{industry:'Diagnostics',years_estimate:6}],product_categories:['Diagnostics'],customer_types:['Physicians'],sales_motion:['Hunter','Account Management'],seniority_level:'Account Executive',total_sales_years:6,management_experience:false,clinical_technical_experience:[],specialties:[],certifications:[],performance_highlights:['Exceeded quota by 20% in 2024.'],
 employers:[{company:'Example Diagnostics',title:'Account Executive',start:'January 2020',end:'December 2025',achievements:'Sold Diagnostics products to Physicians.\nHunter and Account Management responsibilities in Florida.\nExceeded quota by 20% in 2024.'},{company:'Example Supply',title:'Sales Associate',start:null,end:null,achievements:null}]
};
async function docx(input=text) {
 const zip=new (require('jszip'))();
 zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+input.split('\n').map(line=>'<w:p><w:r><w:t>'+line.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</w:t></w:r></w:p>').join('')+'</w:body></w:document>');
 return zip.generateAsync({type:'nodebuffer'});
}
module.exports={text,structured,docx};

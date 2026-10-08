const IMGS=__IMGS__;
document.querySelectorAll('img[data-k]').forEach(i=>{i.src=IMGS[i.dataset.k]});
const lb=document.getElementById('lb'),lbi=document.getElementById('lbi');
document.querySelectorAll('.zoom').forEach(b=>b.addEventListener('click',()=>{lbi.src=IMGS[b.dataset.src];lbi.alt=b.getAttribute('aria-label');try{lb.showModal()}catch(e){lb.setAttribute('open','')}}));
document.getElementById('lbx').addEventListener('click',()=>lb.close());
lb.addEventListener('click',e=>{if(e.target===lb)lb.close()});
const chips=[...document.querySelectorAll('.chip')];
function apply(f){chips.forEach(c=>{const on=c.dataset.f===f;c.classList.toggle('on',on);c.setAttribute('aria-pressed',on)});
 document.querySelectorAll('.issue').forEach(i=>{i.hidden=!(f==='all'||i.dataset.sev===f)});
 document.querySelectorAll('section.page[id^="p-"]').forEach(s=>{s.hidden=!s.querySelector('.issue:not([hidden])')});
 try{localStorage.setItem('qa-f-{{site-slug}}',f)}catch(e){}}
chips.forEach(c=>c.addEventListener('click',()=>apply(c.dataset.f)));
try{const f=localStorage.getItem('qa-f-{{site-slug}}');if(f&&chips.some(c=>c.dataset.f===f))apply(f)}catch(e){}

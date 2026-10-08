// Screenshot sliders (one slide per affected element/page) and lightbox paging.
document.querySelectorAll('.slider').forEach(function(s){
  var slides=[].slice.call(s.querySelectorAll('.slide')),cnt=s.querySelector('.sl-count');
  function go(i){i=(i+slides.length)%slides.length;slides.forEach(function(f,n){f.classList.toggle('on',n===i)});s.dataset.cur=i;if(cnt)cnt.textContent=(i+1)+' / '+slides.length}
  s.dataset.cur=0;
  var p=s.querySelector('.sl-prev'),n=s.querySelector('.sl-next');
  if(p)p.addEventListener('click',function(){go(+s.dataset.cur-1)});
  if(n)n.addEventListener('click',function(){go(+s.dataset.cur+1)});
  s.addEventListener('keydown',function(e){if(e.key==='ArrowLeft'){go(+s.dataset.cur-1)}if(e.key==='ArrowRight'){go(+s.dataset.cur+1)}});
  s._go=go;
});
(function(){
  var lb=document.getElementById('lb'),img=document.getElementById('lbi'),cap=document.getElementById('lbc'),pv=document.getElementById('lbp'),nx=document.getElementById('lbn'),cur=null,idx=0;
  function show(){var b=cur[idx].querySelector('.zoom');img.src=IMGS[b.dataset.src];img.alt=b.getAttribute('aria-label');cap.textContent=cur[idx].querySelector('figcaption').textContent+(cur.length>1?'  ('+(idx+1)+' / '+cur.length+')':'');pv.hidden=nx.hidden=cur.length<2}
  document.querySelectorAll('.slider .zoom').forEach(function(b){b.addEventListener('click',function(){var s=b.closest('.slider');cur=[].slice.call(s.querySelectorAll('.slide'));idx=cur.indexOf(b.closest('.slide'));show()})});
  function step(d){if(!cur)return;idx=(idx+d+cur.length)%cur.length;show();var s=cur[0].closest('.slider');if(s._go)s._go(idx)}
  pv.addEventListener('click',function(e){e.stopPropagation();step(-1)});nx.addEventListener('click',function(e){e.stopPropagation();step(1)});
  lb.addEventListener('keydown',function(e){if(e.key==='ArrowLeft')step(-1);if(e.key==='ArrowRight')step(1)});
  lb.addEventListener('close',function(){cur=null;cap.textContent=''});
})();

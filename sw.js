const C='yommy-v4',F=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(F)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('fetch',e=>{const q=e.request;if(q.method!=='GET'||new URL(q.url).origin!==self.location.origin)return; /* only our own files; Firebase/Google requests go straight to the network */
 e.respondWith(fetch(q).then(r=>{if(r.ok){const c=r.clone();caches.open(C).then(x=>x.put(q,c))}return r}).catch(()=>caches.match(q).then(m=>m||(q.mode==='navigate'?caches.match('index.html'):Response.error()))))});
/* FCM data message -> notification. One notification per Yommy day (tag yommy-YYYY-MM-DD): a newer reminder replaces the older one
   (renotify = it alerts again), and reminders left over from earlier days are removed so a stale count is never shown. */
self.addEventListener('push',e=>{let j={};try{j=e.data.json()}catch(x){}const d=j.data||j;if(!d.title)return;const tag=d.tag||'yommy';
 e.waitUntil((async()=>{try{(await self.registration.getNotifications()).forEach(n=>{if(n.tag&&n.tag!==tag&&/^(yommy-|\d{4}-\d\d-\d\d-\d)/.test(n.tag))n.close()})}catch(x){}
  await self.registration.showNotification(d.title,{body:d.body||'',tag,icon:'icon-192.png',renotify:true})})())});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUninstalled:false}).then(l=>l.length?l[0].focus():clients.openWindow('./')))});

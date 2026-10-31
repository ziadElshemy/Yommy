const C='yommy-v3',F=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(F)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('fetch',e=>{const q=e.request;if(q.method!=='GET'||new URL(q.url).origin!==self.location.origin)return; /* only our own files; Firebase/Google requests go straight to the network */
 e.respondWith(fetch(q).then(r=>{if(r.ok){const c=r.clone();caches.open(C).then(x=>x.put(q,c))}return r}).catch(()=>caches.match(q).then(m=>m||(q.mode==='navigate'?caches.match('index.html'):Response.error()))))});
/* FCM data message -> notification (same tag as the in-page reminder, so they never show twice) */
self.addEventListener('push',e=>{let j={};try{j=e.data.json()}catch(x){}const d=j.data||j;if(!d.title)return;
 e.waitUntil(self.registration.showNotification(d.title,{body:d.body||'',tag:d.tag||'yommy',icon:'icon-192.png'}))});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUninstalled:false}).then(l=>l.length?l[0].focus():clients.openWindow('./')))});

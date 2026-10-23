const C='yommy-v2',F=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png','apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>Promise.allSettled(F.map(u=>c.add(u)))));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('fetch',e=>{const q=e.request;if(q.method!=='GET')return;e.respondWith(fetch(q).then(r=>{if(r.ok&&new URL(q.url).origin===location.origin){const c=r.clone();e.waitUntil(caches.open(C).then(x=>x.put(q,c)))}return r}).catch(()=>caches.match(q).then(m=>m||(q.mode==='navigate'?caches.match('index.html'):Response.error()))))});
self.addEventListener('push',e=>{let d={};try{d=e.data.json()}catch(x){}e.waitUntil(self.registration.showNotification(d.title||'يومي',{body:d.body||'',icon:'icon-192.png',badge:'icon-192.png',tag:d.tag}))});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{for(const c of l){if('focus'in c)return c.focus()}return clients.openWindow('./')}))});

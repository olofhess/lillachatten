'use strict';
// Lillachatten 0.5 — local-only prototype. No external dependencies.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const Pool = process.env.DATABASE_URL ? require('pg').Pool : null;
const PORT = Number(process.env.PORT || 3000);
const HOST = (process.env.PORT || process.env.DATABASE_URL) ? '0.0.0.0' : '127.0.0.1';
const pool = process.env.DATABASE_URL ? new Pool({connectionString:process.env.DATABASE_URL, max:4}) : null;
const DATA_PATH = path.join(__dirname, 'data', 'state.json');
const IMAGE_DIR = path.join(__dirname, 'data', 'images');
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGES_POST = 3;
const imageUploads = new Map();
const ADMIN_EMAIL = 'olof.hesselmark@gmail.com';
const ADMIN_NAME = 'Olof';
const sessions = new Map();

function readState() {
  try { const v = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); return { users: v.users || [], association: v.association || '', posts: v.posts || [], invitations: v.invitations || [], privateMessages: v.privateMessages || [] }; }
  catch (e) { if (e.code !== 'ENOENT') throw e; return { users: [], association: '', posts: [], invitations: [] }; }
}
let state;
function emptyState() { return {users:[],association:'',posts:[],invitations:[],privateMessages:[]}; }
async function initialize() {
  if (pool && !process.env.SETUP_SECRET) throw Error('SETUP_SECRET måste anges när PostgreSQL används.');
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS lc_state (id INTEGER PRIMARY KEY CHECK(id=1), value JSONB NOT NULL)');
    await pool.query(`CREATE TABLE IF NOT EXISTS lc_images (
      id UUID PRIMARY KEY, owner_email TEXT NOT NULL, mime TEXT NOT NULL,
      image_data BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // Brand-new Render databases start empty. Existing local test accounts stay on the Mac.
    await pool.query('INSERT INTO lc_state (id,value) VALUES (1,$1::jsonb) ON CONFLICT (id) DO NOTHING', [JSON.stringify(emptyState())]);
    const result = await pool.query('SELECT value FROM lc_state WHERE id=1');
    state = result.rows[0].value;
  } else state = readState();
  if (!Array.isArray(state.privateMessages)) state.privateMessages=[];
  let changed = false;
  for (const inv of state.invitations) {
    if (Object.hasOwn(inv,'email')) {
      delete inv.email;
      if (inv.status==='pending') { inv.status='replaced';inv.tokenHash=null; }
      changed=true;
    }
  }
  if (changed) await persist();
}
let saveQueue=Promise.resolve();
async function persist() {
  // Serialize writes to prevent a slower save overwriting a newer one.
  const snapshot = JSON.stringify(state);
  saveQueue=saveQueue.catch(()=>{}).then(async()=>{
    if (pool) {
      await pool.query('UPDATE lc_state SET value=$1::jsonb WHERE id=1',[snapshot]);
    } else {
      const dir=path.dirname(DATA_PATH);fs.mkdirSync(dir,{recursive:true,mode:0o700});
      const temp=DATA_PATH+'.tmp';fs.writeFileSync(temp,snapshot,{mode:0o600});fs.renameSync(temp,DATA_PATH);
    }
  });
  return saveQueue;
}
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function passwordHash(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function send(res, status, data, headers = {}) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}); res.end(JSON.stringify(data));
}
async function body(req) {
  let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 20000) throw new Error('För stor begäran'); }
  return JSON.parse(text || '{}');
}
// Endast bildformat som kan identifieras från själva filens bytes. SVG tillåts inte.
function detectImage(data) {
  if (data.length >= 3 && data.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff]))) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (data.length >= 6 && ['GIF87a','GIF89a'].includes(data.subarray(0,6).toString('ascii'))) return 'image/gif';
  if (data.length >= 12 && data.toString('ascii',0,4)==='RIFF' && data.toString('ascii',8,12)==='WEBP') return 'image/webp';
  return null;
}
async function imageBody(req, limit=MAX_IMAGE_BYTES * 1.40 + 2048) {
  let size=0, parts=[];
  for await (const chunk of req) {
    size+=chunk.length;
    if (size > limit) throw Error('Bilden är för stor (max 2 MB).');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');
}
function uploadAllowed(email) {
  const now=Date.now();
  const prev=(imageUploads.get(email)||[]).filter(t=>t>now-3600000);
  if(prev.length>=20) return false;
  prev.push(now);imageUploads.set(email,prev);return true;
}
async function storeImage(email,bytes) {
  if(!bytes.length || bytes.length>MAX_IMAGE_BYTES) throw Error('Bilden måste vara högst 2 MB.');
  const mime=detectImage(bytes);
  if(!mime) throw Error('Bara JPG, PNG, GIF eller WebP stöds.');
  const id=crypto.randomUUID();
  if(pool) await pool.query('INSERT INTO lc_images (id,owner_email,mime,image_data) VALUES ($1,$2,$3,$4)',[id,email,mime,bytes]);
  else {fs.mkdirSync(IMAGE_DIR,{recursive:true,mode:0o700});fs.writeFileSync(path.join(IMAGE_DIR,id+'.bin'),bytes,{mode:0o600});fs.writeFileSync(path.join(IMAGE_DIR,id+'.json'),JSON.stringify({owner:email,mime}),{mode:0o600});}
  return {id,mime,url:'/api/images/'+id};
}
async function imageMeta(id, includeData=false) {
  if(pool) {
    const columns=includeData?'owner_email,mime,image_data':'owner_email,mime';
    const row=await pool.query(`SELECT ${columns} FROM lc_images WHERE id=$1`,[id]);
    if(!row.rows.length)return null;
    return {owner:row.rows[0].owner_email,mime:row.rows[0].mime,data:row.rows[0].image_data};
  }
  try {
    const obj=JSON.parse(fs.readFileSync(path.join(IMAGE_DIR,id+'.json'),'utf8'));
    return {owner:obj.owner,mime:obj.mime,data:includeData?fs.readFileSync(path.join(IMAGE_DIR,id+'.bin')):undefined};
  }catch(e){if(e.code==='ENOENT')return null;throw e;}
}
async function removeImages(ids) {
  if(!ids.length)return;
  if(pool)await pool.query('DELETE FROM lc_images WHERE id=ANY($1::uuid[])',[ids]);
  else for(const id of ids)for(const ext of ['bin','json'])try{fs.unlinkSync(path.join(IMAGE_DIR,id+'.'+ext))}catch(e){if(e.code!=='ENOENT')throw e;}
}
function isPublicIPv4(ip) {
  if(net.isIP(ip)!==4)return false;
  const [a,b,c]=ip.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||
    a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||
    a===192&&b===0&&c===0||a===192&&b===0&&c===2||a===198&&b>=18&&b<=19||
    a===198&&b===51&&c===100||a===203&&b===0&&c===113||a===192&&b===88&&c===99);
}
async function fetchPublicImage(raw) {
  if(typeof raw!=='string'||raw.length>2048)throw Error('Ogiltig bildadress.');
  let url;
  try{url=new URL(raw);}catch{throw Error('Ogiltig bildadress.');}
  if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||!url.hostname||net.isIP(url.hostname)|| /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname))
    throw Error('Använd en offentlig HTTPS-länk till en bild.');
  const addresses=await dns.resolve4(url.hostname);
  if(!addresses.length||!addresses.every(isPublicIPv4))throw Error('Bildadressen är inte tillåten.');
  const pinned=addresses[0];
  return await new Promise((resolve,reject)=>{
    const request=https.get(url,{timeout:12000,lookup:(_host,_opts,cb)=>cb(null,pinned,4),headers:{'Accept':'image/jpeg,image/png,image/webp,image/gif','User-Agent':'Lillachatten/0.9'}},response=>{
      if(response.statusCode!==200){response.resume();return reject(Error('Bilden kunde inte hämtas (HTTP '+response.statusCode+').'));}
      if(Number(response.headers['content-length']||0)>MAX_IMAGE_BYTES){response.destroy();return reject(Error('Bilden är för stor (max 2 MB).'));}
      let size=0;const parts=[];
      response.on('data',chunk=>{size+=chunk.length;if(size>MAX_IMAGE_BYTES){response.destroy();reject(Error('Bilden är för stor (max 2 MB).'));}else parts.push(chunk)});
      response.on('end',()=>resolve(Buffer.concat(parts)));
      response.on('error',reject);
    });
    request.on('timeout',()=>request.destroy(Error('Bildhämtningen tog för lång tid.')));
    request.on('error',reject);
  });
}
function session(req) {
  const match = /(?:^|;\s*)lc_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
  return match && sessions.get(match[1]);
}
function requireLogin(req, res) { const user = session(req); if (!user) send(res,401,{error:'Logga in först.'}); return user; }
function userView(user) { return { email:user.email, firstName:user.firstName, role:user.role, avatarId:user.avatarId||null }; }
function issueSession(res,user) {
  const token = crypto.randomBytes(32).toString('hex'); sessions.set(token,user.email);
  return `lc_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`;
}
function currentUser(req) { const email = session(req); return state.users.find(u=>u.email===email) || null; }
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url,'http://localhost');
  const pathname = url.pathname;
  try {
    if (pathname === '/health' && req.method==='GET') return send(res,200,{ok:true});
    if (pathname === '/' || pathname === '/index.html') {
      if (req.method !== 'GET') return send(res,405,{error:'Metoden stöds inte'});
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      return fs.createReadStream(path.join(__dirname,'index.html')).pipe(res);
    }
    if (pathname === '/api/status' && req.method==='GET') return send(res,200,{needsSetup:state.users.length===0,adminEmail:ADMIN_EMAIL,version:'0.9.5',requiresSetupSecret:!!process.env.SETUP_SECRET});
    if (pathname === '/api/setup' && req.method==='POST') {
      if (state.users.length) return send(res,409,{error:'Administratören är redan skapad.'});
      const data = await body(req); const pw = data.password;
      if (process.env.SETUP_SECRET && data.setupSecret !== process.env.SETUP_SECRET) return send(res,403,{error:'Fel startkod för administratören.'});
      if (typeof pw !== 'string' || pw.length < 6 || pw.length > 200) return send(res,400,{error:'Välj ett lösenord med 6–200 tecken.'});
      const salt=crypto.randomBytes(16).toString('hex');
      const user={email:ADMIN_EMAIL,firstName:ADMIN_NAME,role:'admin',salt,hash:passwordHash(pw,salt)};
      state.users.push(user); await persist();
      return send(res,201,{user:userView(user)}, {'Set-Cookie':issueSession(res,user)});
    }
    if (pathname === '/api/login' && req.method==='POST') {
      const data=await body(req); const email=String(data.email||'').trim().toLowerCase();
      const u=state.users.find(x=>x.email===email);
      if (!u || typeof data.password!=='string') return send(res,401,{error:'Fel e-postadress eller lösenord.'});
      const a=Buffer.from(u.hash,'hex'), b=Buffer.from(passwordHash(data.password,u.salt),'hex');
      if (!crypto.timingSafeEqual(a,b)) return send(res,401,{error:'Fel e-postadress eller lösenord.'});
      return send(res,200,{user:userView(u)}, {'Set-Cookie':issueSession(res,u)});
    }
    if (pathname === '/api/invitations/inspect' && req.method==='GET') {
      const token=url.searchParams.get('token') || '';
      const inv=state.invitations.find(x=>x.tokenHash===tokenHash(token));
      if (!inv || inv.status!=='pending' || Date.parse(inv.expiresAt)<Date.now()) return send(res,404,{error:'Inbjudan är ogiltig eller har gått ut.'});
      return send(res,200,{association:state.association||'Lillachatten',expiresAt:inv.expiresAt});
    }
    if (pathname === '/api/invitations/respond' && req.method==='POST') {
      const data=await body(req), token=String(data.token||'');
      const inv=state.invitations.find(x=>x.tokenHash===tokenHash(token));
      if (!inv || inv.status!=='pending' || Date.parse(inv.expiresAt)<Date.now()) return send(res,404,{error:'Inbjudan är ogiltig eller har gått ut.'});
      if (data.decision==='decline') {inv.status='declined';inv.tokenHash=null;await persist();return send(res,200,{ok:true,declined:true});}
      if (data.decision!=='accept') return send(res,400,{error:'Ogiltigt val.'});
      const firstName=String(data.firstName||'').trim(),pw=data.password;
      const email=String(data.email||'').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>254) return send(res,400,{error:'Ange en giltig e-postadress.'});
      if (!firstName || firstName.length>60) return send(res,400,{error:'Ange förnamn (högst 60 tecken).'});
      if (typeof pw!=='string' || pw.length<6 || pw.length>200) return send(res,400,{error:'Lösenordet ska vara 6–200 tecken.'});
      if (state.users.some(x=>x.email===email)) return send(res,409,{error:'Det finns redan en medlem med den adressen.'});
      const salt=crypto.randomBytes(16).toString('hex');
      const user={email,firstName,role:'member',salt,hash:passwordHash(pw,salt)};
      state.users.push(user);inv.status='accepted';inv.tokenHash=null;await persist();
      return send(res,201,{user:userView(user)}, {'Set-Cookie':issueSession(res,user)});
    }
    if (pathname === '/api/logout' && req.method==='POST') {
      const match=/(?:^|;\s*)lc_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'');
      if (match) sessions.delete(match[1]);
      return send(res,200,{ok:true},{'Set-Cookie':'lc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
    }
    const u = currentUser(req);
    if (!u) return send(res,401,{error:'Logga in först.'});
    // 0.9.3: byt eller ta bort eget profilfoto. Endast bildens ägare kan välja det.
    if(pathname==='/api/profile/photo' && req.method==='PATCH') {
      const data=await body(req);
      const imageId=data.imageId;
      if(imageId!==null && (typeof imageId!=='string'||!/^[a-f0-9-]{36}$/.test(imageId)))
        return send(res,400,{error:'Ogiltigt profilfoto.'});
      if(imageId!==null){
        const info=await imageMeta(imageId);
        if(!info||info.owner!==u.email)return send(res,403,{error:'Du kan bara använda dina egna uppladdade bilder.'});
        if(state.posts.some(p=>(p.images||[]).includes(imageId)))
          return send(res,409,{error:'Välj en separat bild som profilfoto.'});
      }
      const previous=u.avatarId||null;
      u.avatarId=imageId;
      await persist();
      if(previous && previous!==imageId && !state.users.some(x=>x.avatarId===previous)
        && !state.posts.some(p=>(p.images||[]).includes(previous)))await removeImages([previous]);
      return send(res,200,{avatarId:u.avatarId});
    }
    const imageGet=pathname.match(/^\/api\/images\/([a-f0-9-]{36})$/);
    if(imageGet && req.method==='GET') {
      const info=await imageMeta(imageGet[1],true);
      if(!info)return send(res,404,{error:'Bilden hittades inte.'});
      res.writeHead(200,{'Content-Type':info.mime,'Content-Length':info.data.length,
        'Cache-Control':'private, max-age=600','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});
      return res.end(info.data);
    }
    if(imageGet && req.method==='DELETE') {
      const info=await imageMeta(imageGet[1]);
      if(!info)return send(res,404,{error:'Bilden hittades inte.'});
      if(info.owner!==u.email)return send(res,403,{error:'Du kan bara ta bort dina egna bilder.'});
      if(state.users.some(x=>x.avatarId===imageGet[1]) || state.posts.some(p=>(p.images||[]).includes(imageGet[1])))
        return send(res,409,{error:'Bilden används redan i ett inlägg.'});
      await removeImages([imageGet[1]]);return send(res,200,{ok:true});
    }
    if(pathname==='/api/images/upload' && req.method==='POST') {
      const data=await imageBody(req);
      if(typeof data.base64!=='string'||data.base64.length>Math.ceil(MAX_IMAGE_BYTES*4/3)+8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64))
        return send(res,400,{error:'Ogiltig eller för stor bild.'});
      const bytes=Buffer.from(data.base64,'base64');
      if(!detectImage(bytes))return send(res,400,{error:'Bara JPG, PNG, GIF eller WebP stöds.'});
      if(bytes.length>MAX_IMAGE_BYTES)return send(res,413,{error:'Bilden är för stor (max 2 MB).'});
      if(!uploadAllowed(u.email))return send(res,429,{error:'Högst 20 bilder per timme.'});
      return send(res,201,{image:await storeImage(u.email,bytes)});
    }
    if(pathname==='/api/images/import' && req.method==='POST') {
      const data=await body(req);
      if(!uploadAllowed(u.email))return send(res,429,{error:'Högst 20 bilder per timme.'});
      const bytes=await fetchPublicImage(data.url);
      return send(res,201,{image:await storeImage(u.email,bytes)});
    }
    if (pathname === '/api/invitations' && req.method==='GET') {
      if (u.role!=='admin') return send(res,403,{error:'Endast administratören kan visa inbjudningar.'});
      return send(res,200,{invitations:state.invitations.map(({tokenHash,...rest})=>rest),members:state.users.map(userView)});
    }
    // Resend: bara administratören får skicka. Adressen används för leverans,
    // men registreras INTE som medlem eller i Lillachattens databas.
    if (pathname === '/api/invitations/send' && req.method === 'POST') {
      if (u.role !== 'admin') return send(res, 403, {error:'Endast administratören kan bjuda in.'});
      const data = await body(req);
      const recipient = String(data.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) || recipient.length > 254)
        return send(res,400,{error:'Ange en giltig mottagaradress.'});
      if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM)
        return send(res,503,{error:'E-post är inte konfigurerad i Render (RESEND_API_KEY och RESEND_FROM).'});
      const now = Date.now();
      // Skydd mot oavsiktligt massutskick: max 10 per timme per administratör.
      globalThis.lcInviteSends ||= new Map();
      const recent = (globalThis.lcInviteSends.get(u.email) || []).filter(t => now-t < 3600000);
      if (recent.length >= 10) return send(res,429,{error:'Högst 10 inbjudningar per timme. Försök senare.'});
      const base = (process.env.PUBLIC_URL || 'https://lillachatten.onrender.com').replace(/\/$/, '');
      if (!/^https:\/\/[^/]+$/.test(base) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(base))
        return send(res,503,{error:'PUBLIC_URL är felaktigt inställd.'});
      const token = crypto.randomBytes(32).toString('hex');
      const link = `${base}/?invite=${token}`;
      const group = state.association || 'Lillachatten';
      const escapeHtml = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const safeGroup = escapeHtml(group);
      const safeLink = escapeHtml(link);
      const html = `<div style="font-family:Arial,sans-serif;max-width:500px;margin:auto;color:#263445">
        <h2>Inbjudan till ${safeGroup}</h2>
        <p>Du har blivit inbjuden att gå med i ${safeGroup} på Lillachatten.</p>
        <p><a href="${safeLink}" style="display:inline-block;padding:13px 20px;background:#2865b0;color:#fff;text-decoration:none;border-radius:9px">Visa inbjudan</a></p>
        <p>Du kan tacka ja eller nej på sidan. Länken gäller i sju dagar.</p>
        <p style="font-size:12px;color:#667486">Om du inte väntade dig detta mejl behöver du inte göra någonting.</p></div>`;
      let response;
      try {
        response = await fetch('https://api.resend.com/emails', {
          method:'POST',
          headers:{'Authorization':`Bearer ${process.env.RESEND_API_KEY}`,
                   'Content-Type':'application/json',
                   'User-Agent':'Lillachatten/0.7',
                   'Idempotency-Key':`lillachatten/${tokenHash(token)}`},
          body:JSON.stringify({from:process.env.RESEND_FROM,to:[recipient],
                               subject:`Inbjudan till ${group}`,html}),
          signal:AbortSignal.timeout(15000)
        });
      } catch (err) {
        console.error('Resend kunde inte nås:',err.name);
        return send(res,502,{error:'E-posttjänsten kunde inte nås. Ingen inbjudan sparades.'});
      }
      if (!response.ok) {
        // Ta inte med API-nyckeln eller hela Resends svar i loggarna.
        console.error('Resend nekade utskicket, HTTP',response.status);
        return send(res,502,{error: response.status===403
          ? 'Resend nekade utskicket. Kontrollera verifierad avsändardomän och RESEND_FROM.'
          : `Resend kunde inte skicka mejlet (HTTP ${response.status}).`});
      }
      const inv = {id:crypto.randomUUID(),status:'pending',
        createdAt:new Date().toISOString(),
        expiresAt:new Date(now+7*86400000).toISOString(),tokenHash:tokenHash(token)};
      state.invitations.unshift(inv);
      await persist();
      globalThis.lcInviteSends.set(u.email, [...recent,now]);
      return send(res,201,{ok:true,invitation:{id:inv.id,status:inv.status,expiresAt:inv.expiresAt}});
    }
    if (pathname === '/api/invitations' && req.method==='POST') {
      if (u.role!=='admin') return send(res,403,{error:'Endast administratören kan bjuda in.'});
            const token=crypto.randomBytes(32).toString('hex');
      const inv={id:crypto.randomUUID(),status:'pending',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+7*86400000).toISOString(),tokenHash:tokenHash(token)};
      state.invitations.unshift(inv);await persist();
      const host=req.headers.host||`127.0.0.1:${PORT}`;
      const proto=(req.headers['x-forwarded-proto']==='https'?'https':'http');
      const link=`${proto}://${host}/?invite=${token}`;
      return send(res,201,{invitation:{id:inv.id,status:inv.status,expiresAt:inv.expiresAt},link});
    }
    // Lillachatten PRIVATE 0.9.5 — endast samtalets två medlemmar.
    // Ingen admin-genväg. Alla resultat filtreras på den inloggades e-post.
    if (pathname==='/api/private/conversations' && req.method==='GET') {
      const result=new Map();
      for(const m of state.privateMessages){
        if(m.from!==u.email && m.to!==u.email)continue;
        const other=m.from===u.email?m.to:m.from;
        if(!state.users.some(x=>x.email===other))continue;
        const prior=result.get(other);
        if(!prior || prior.createdAt<m.createdAt)result.set(other,{email:other,createdAt:m.createdAt});
      }
      return send(res,200,{conversations:Array.from(result.values()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});
    }
    if(pathname==='/api/private/messages' && req.method==='GET') {
      const other=String(url.searchParams.get('with')||'').toLowerCase();
      if(!state.users.some(x=>x.email===other && x.email!==u.email))return send(res,404,{error:'Medlemmen hittades inte.'});
      const messages=state.privateMessages.filter(m=>(m.from===u.email&&m.to===other)||(m.from===other&&m.to===u.email));
      return send(res,200,{messages:messages.slice(-300).map(m=>({id:m.id,from:m.from,text:m.text,createdAt:m.createdAt}))});
    }
    if(pathname==='/api/private/messages' && req.method==='POST') {
      const data=await body(req);
      const other=typeof data.to==='string'?data.to.trim().toLowerCase():'';
      const text=typeof data.text==='string'?data.text.trim():'';
      if(!state.users.some(x=>x.email===other && x.email!==u.email))return send(res,404,{error:'Medlemmen hittades inte.'});
      if(!text||text.length>2000)return send(res,400,{error:'Meddelandet måste vara 1–2000 tecken.'});
      // Enkel begränsning: högst 20 privata meddelanden per minut och konto.
      const now=Date.now();globalThis.lcPrivateRate ||= new Map();
      const recent=(globalThis.lcPrivateRate.get(u.email)||[]).filter(t=>now-t<60000);
      if(recent.length>=20)return send(res,429,{error:'Vänta en stund innan du skickar fler meddelanden.'});
      recent.push(now);globalThis.lcPrivateRate.set(u.email,recent);
      const message={id:crypto.randomUUID(),from:u.email,to:other,text,createdAt:new Date(now).toISOString()};
      state.privateMessages.push(message);await persist();
      return send(res,201,{message:{id:message.id,from:message.from,text:message.text,createdAt:message.createdAt}});
    }
    if (pathname === '/api/me' && req.method==='GET') return send(res,200,{user:userView(u),association:state.association,members:state.users.map(userView),posts:state.posts.map(p=>{
      // Tidigare Gilla-markeringar blir hjärtan, utan att ändra databasen.
      const reactions=p.reactions||{};
      const members=t=>Array.isArray(reactions[t])?reactions[t]:(t==='heart'&&Array.isArray(p.likes)?p.likes:[]);
      const types=['up','down','heart'];
      return {...p,likes:undefined,reactions:undefined,
        reactionCounts:Object.fromEntries(types.map(t=>[t,members(t).length])),
        myReactions:Object.fromEntries(types.map(t=>[t,members(t).includes(u.email)]))};
    })});
    if (pathname === '/api/association' && req.method==='POST') {
      if (u.role!=='admin') return send(res,403,{error:'Endast administratören kan ändra namnet.'});
      const data=await body(req); const name=String(data.name||'').trim();
      if (!name || name.length>80) return send(res,400,{error:'Namnet måste vara 1–80 tecken.'});
      state.association=name;await persist();return send(res,200,{name});
    }
    if (pathname === '/api/posts' && req.method==='POST') {
      const data=await body(req);const text=String(data.text||'').trim();
      const images=Array.isArray(data.images)?data.images:[];
      if(!text && !images.length)return send(res,400,{error:'Skriv text eller bifoga minst en bild.'});
      if(text.length>5000 || images.length>MAX_IMAGES_POST || images.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)) || new Set(images).size!==images.length)
        return send(res,400,{error:'Felaktiga bildval (högst tre).'});
      for(const id of images){const img=await imageMeta(id);if(!img||img.owner!==u.email)return send(res,403,{error:'En bild saknas eller tillhör en annan medlem.'});}
      const post={id:crypto.randomUUID(),author:u.firstName,email:u.email,text,images,createdAt:new Date().toISOString(),comments:[]};
      state.posts.unshift(post);await persist();return send(res,201,{post});
    }
    // 0.9.3: radera exakt en publicerad bild, endast från eget inlägg.
    const postImageRoute=pathname.match(/^\/api\/posts\/([a-f0-9-]+)\/images\/([a-f0-9-]{36})$/);
    if(postImageRoute && req.method==='DELETE') {
      const post=state.posts.find(p=>p.id===postImageRoute[1]);
      if(!post)return send(res,404,{error:'Inlägget hittades inte.'});
      if(post.email!==u.email)return send(res,403,{error:'Du kan bara ändra dina egna inlägg.'});
      const imageId=postImageRoute[2];
      if(!Array.isArray(post.images)||!post.images.includes(imageId))
        return send(res,404,{error:'Bilden finns inte i inlägget.'});
      if(post.images.length===1 && !String(post.text||'').trim())
        return send(res,409,{error:'Ett inlägg måste innehålla text eller minst en bild. Ta bort hela inlägget i stället.'});
      // Ändra inlägget först så det aldrig pekar på en borttagen bild.
      post.images=post.images.filter(id=>id!==imageId);
      post.editedAt=new Date().toISOString();
      await persist();
      // Radera filen bara om den inte används i något annat inlägg.
      if(!state.posts.some(p=>(p.images||[]).includes(imageId)))await removeImages([imageId]);
      return send(res,200,{ok:true});
    }
    // Inlägg: endast upphovspersonen får ändra eller radera.
    const postRoute = pathname.match(/^\/api\/posts\/([a-f0-9-]+)$/);
    if (postRoute && (req.method==='PATCH' || req.method==='DELETE')) {
      const post=state.posts.find(p=>p.id===postRoute[1]);
      if (!post) return send(res,404,{error:'Inlägget hittades inte.'});
      if (post.email!==u.email) return send(res,403,{error:'Du kan bara ändra dina egna inlägg.'});
      if (req.method==='DELETE') {
        state.posts=state.posts.filter(p=>p.id!==post.id);
        await persist();
        await removeImages(Array.isArray(post.images)?post.images:[]);
        return send(res,200,{ok:true});
      }
      const data=await body(req);
      if (typeof data.text!=='string') return send(res,400,{error:'Text saknas.'});
      const text=data.text.trim();
      if((!text && !(post.images||[]).length) || text.length>5000)return send(res,400,{error:'Skriv text eller bifoga en bild.'});
      post.text=text;
      post.editedAt=new Date().toISOString();
      await persist();
      return send(res,200,{ok:true});
    }
    // En reaktion per medlem och typ. Tumme upp och ner utesluter varandra.
    const reactionRoute=pathname.match(/^\/api\/posts\/([a-f0-9-]+)\/reaction$/);
    if (reactionRoute && req.method==='POST') {
      const post=state.posts.find(p=>p.id===reactionRoute[1]);
      if (!post) return send(res,404,{error:'Inlägget hittades inte.'});
      const data=await body(req);
      const type=data.type;
      if (!['up','down','heart'].includes(type)) return send(res,400,{error:'Okänd reaktion.'});
      if (!post.reactions) post.reactions={
        up:[],down:[],heart:Array.isArray(post.likes)?[...post.likes]:[]
      };
      for (const t of ['up','down','heart']) {
        if (!Array.isArray(post.reactions[t])) post.reactions[t]=[];
      }
      const existing=post.reactions[type].includes(u.email);
      post.reactions[type]=post.reactions[type].filter(email=>email!==u.email);
      if (!existing) {
        if (type==='up' || type==='down') {
          const opposite=type==='up'?'down':'up';
          post.reactions[opposite]=post.reactions[opposite].filter(email=>email!==u.email);
        }
        post.reactions[type].push(u.email);
      }
      // Den gamla listan används inte efter migrering.
      delete post.likes;
      await persist();
      return send(res,200,{ok:true});
    }
    // Ett gilla per användare. Samma knapp tar bort gillamarkeringen.
    const likeRoute = pathname.match(/^\/api\/posts\/([a-f0-9-]+)\/like$/);
    if (likeRoute && req.method==='POST') {
      const post=state.posts.find(p=>p.id===likeRoute[1]);
      if (!post) return send(res,404,{error:'Inlägget hittades inte.'});
      if (!Array.isArray(post.likes)) post.likes=[];
      if (post.likes.includes(u.email)) post.likes=post.likes.filter(email=>email!==u.email);
      else post.likes.push(u.email);
      await persist();
      return send(res,200,{liked:post.likes.includes(u.email),count:post.likes.length});
    }
    const cm=pathname.match(/^\/api\/posts\/([a-f0-9-]+)\/comments$/);
    if (cm && req.method==='POST') {
      const post=state.posts.find(p=>p.id===cm[1]);
      if (!post) return send(res,404,{error:'Inlägget hittades inte.'});
      const data=await body(req);const text=String(data.text||'').trim();
      if (!text || text.length>1000) return send(res,400,{error:'Kommentaren måste vara 1–1000 tecken.'});
      post.comments.push({author:u.firstName,email:u.email,text,createdAt:new Date().toISOString()});await persist();return send(res,201,{ok:true});
    }
    return send(res,404,{error:'Adressen finns inte.'});
  } catch(e) { console.error(e); return send(res,400,{error:'Begäran kunde inte behandlas.'}); }
});
initialize().then(()=>server.listen(PORT,HOST,()=>console.log(`Lillachatten 0.9.5 körs på http://${HOST}:${PORT} (${pool?'PostgreSQL':'lokal testfil'})`))).catch(e=>{console.error('Serverstart misslyckades:',e.message);process.exit(1)});

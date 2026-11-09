'use strict';
// Lillachatten 0.5 — local-only prototype. No external dependencies.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Pool = process.env.DATABASE_URL ? require('pg').Pool : null;
const PORT = Number(process.env.PORT || 3000);
const HOST = (process.env.PORT || process.env.DATABASE_URL) ? '0.0.0.0' : '127.0.0.1';
const pool = process.env.DATABASE_URL ? new Pool({connectionString:process.env.DATABASE_URL, max:4}) : null;
const DATA_PATH = path.join(__dirname, 'data', 'state.json');
const ADMIN_EMAIL = 'olof.hesselmark@gmail.com';
const ADMIN_NAME = 'Olof';
const sessions = new Map();

function readState() {
  try { const v = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); return { users: v.users || [], association: v.association || '', posts: v.posts || [], invitations: v.invitations || [] }; }
  catch (e) { if (e.code !== 'ENOENT') throw e; return { users: [], association: '', posts: [], invitations: [] }; }
}
let state;
function emptyState() { return {users:[],association:'',posts:[],invitations:[]}; }
async function initialize() {
  if (pool && !process.env.SETUP_SECRET) throw Error('SETUP_SECRET måste anges när PostgreSQL används.');
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS lc_state (id INTEGER PRIMARY KEY CHECK(id=1), value JSONB NOT NULL)');
    // Brand-new Render databases start empty. Existing local test accounts stay on the Mac.
    await pool.query('INSERT INTO lc_state (id,value) VALUES (1,$1::jsonb) ON CONFLICT (id) DO NOTHING', [JSON.stringify(emptyState())]);
    const result = await pool.query('SELECT value FROM lc_state WHERE id=1');
    state = result.rows[0].value;
  } else state = readState();
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
function session(req) {
  const match = /(?:^|;\s*)lc_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
  return match && sessions.get(match[1]);
}
function requireLogin(req, res) { const user = session(req); if (!user) send(res,401,{error:'Logga in först.'}); return user; }
function userView(user) { return { email:user.email, firstName:user.firstName, role:user.role }; }
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
    if (pathname === '/api/status' && req.method==='GET') return send(res,200,{needsSetup:state.users.length===0,adminEmail:ADMIN_EMAIL,version:'0.6',requiresSetupSecret:!!process.env.SETUP_SECRET});
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
    if (pathname === '/api/invitations' && req.method==='GET') {
      if (u.role!=='admin') return send(res,403,{error:'Endast administratören kan visa inbjudningar.'});
      return send(res,200,{invitations:state.invitations.map(({tokenHash,...rest})=>rest),members:state.users.map(userView)});
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
    if (pathname === '/api/me' && req.method==='GET') return send(res,200,{user:userView(u),association:state.association,posts:state.posts});
    if (pathname === '/api/association' && req.method==='POST') {
      if (u.role!=='admin') return send(res,403,{error:'Endast administratören kan ändra namnet.'});
      const data=await body(req); const name=String(data.name||'').trim();
      if (!name || name.length>80) return send(res,400,{error:'Namnet måste vara 1–80 tecken.'});
      state.association=name;await persist();return send(res,200,{name});
    }
    if (pathname === '/api/posts' && req.method==='POST') {
      const data=await body(req);const text=String(data.text||'').trim();
      if (!text || text.length>5000) return send(res,400,{error:'Inlägget måste vara 1–5000 tecken.'});
      const post={id:crypto.randomUUID(),author:u.firstName,email:u.email,text,createdAt:new Date().toISOString(),comments:[]};
      state.posts.unshift(post);await persist();return send(res,201,{post});
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
initialize().then(()=>server.listen(PORT,HOST,()=>console.log(`Lillachatten 0.6 körs på http://${HOST}:${PORT} (${pool?'PostgreSQL':'lokal testfil'})`))).catch(e=>{console.error('Serverstart misslyckades:',e.message);process.exit(1)});

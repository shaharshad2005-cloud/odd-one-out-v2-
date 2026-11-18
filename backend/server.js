import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { Server } from 'socket.io';
import { createClient } from '@supabase/supabase-js';

const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}; copy .env.example to .env and configure Supabase.`);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const app = express();
const server = http.createServer(app);
const origin = (process.env.PUBLIC_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean);
app.use(cors({ origin: origin.length ? origin : true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
const io = new Server(server, { cors: { origin: origin.length ? origin : true, methods: ['GET','POST'], credentials: true }, maxHttpBufferSize: 1e6 });

const online = new Map(); // userId -> socketId; presence is ephemeral, not authoritative profile data
const roomTimers = new Map();
const GRACE_MS = 120_000;
const safeCode = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
const fail = (message, code = 'BAD_REQUEST') => Object.assign(new Error(message), { data: { code, message } });

async function authUser(token) {
  if (!token) throw fail('Sign in or continue as guest first.', 'UNAUTHENTICATED');
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw fail('Your session expired. Sign in again.', 'UNAUTHENTICATED');
  return data.user;
}
async function roomRow(code) {
  const { data, error } = await supabase.from('game_rooms').select('*').eq('code', code).maybeSingle();
  if (error) throw error;
  return data;
}
async function saveRoom(code, patch) {
  const { data, error } = await supabase.from('game_rooms').update({ ...patch, updated_at: new Date().toISOString() }).eq('code', code).select().single();
  if (error) throw error;
  return data;
}
async function profile(user) {
  const { data, error } = await supabase.from('profiles').upsert({ id: user.id, display_name: user.user_metadata?.display_name || user.email?.split('@')[0] || 'Guest', avatar: user.user_metadata?.avatar || 'none', updated_at: new Date().toISOString() }).select().single();
  if (error) throw error;
  return data;
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'odd-one-out-online', time: new Date().toISOString() }));
app.get('/api/me', async (req, res) => {
  try { const user = await authUser(req.headers.authorization?.replace(/^Bearer\s+/i, '')); res.json({ user, profile: await profile(user) }); }
  catch (e) { res.status(401).json({ error: e.message }); }
});
app.get('/api/friends', async (req, res) => {
  try {
    const user = await authUser(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
    const { data, error } = await supabase.from('friendships').select('id,requester_id,addressee_id,status,created_at,requester:profiles!friendships_requester_id_fkey(id,display_name,avatar),addressee:profiles!friendships_addressee_id_fkey(id,display_name,avatar)').or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`).order('created_at', { ascending: false });
    if (error) throw error; res.json({ friends: data || [] });
  } catch (e) { res.status(401).json({ error: e.message }); }
});
app.post('/api/friends/request', async (req, res) => {
  try {
    const user = await authUser(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
    const target = String(req.body?.username || '').trim().replace(/^@/, '').slice(0, 32);
    if (!target) throw fail('Enter a username.');
    const { data: p, error: pe } = await supabase.from('profiles').select('id,username,display_name').ilike('username', target).maybeSingle();
    if (pe) throw pe; if (!p || p.id === user.id) throw fail('Player not found.');
    const [a,b] = [user.id,p.id].sort();
    const { data: existing, error: ee } = await supabase.from('friendships').select('id,status').eq('pair_key', `${a}:${b}`).maybeSingle();
    if (ee) throw ee; if (existing) throw fail('A friend request or friendship already exists.');
    const { data, error } = await supabase.from('friendships').insert({ requester_id: user.id, addressee_id: p.id, pair_key: `${a}:${b}`, status: 'pending' }).select().single();
    if (error) throw error; res.status(201).json({ request: data, target: p });
    const targetSocket = online.get(p.id); if (targetSocket) io.to(targetSocket).emit('friend:request', { requestId: data.id, from: user.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/friends/respond', async (req, res) => {
  try {
    const user = await authUser(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
    const id = String(req.body?.requestId || ''); const accept = !!req.body?.accept;
    const { data, error } = await supabase.from('friendships').update({ status: accept ? 'accepted' : 'rejected', updated_at: new Date().toISOString() }).eq('id', id).eq('addressee_id', user.id).eq('status', 'pending').select().maybeSingle();
    if (error) throw error; if (!data) throw fail('Request not found or already handled.'); res.json({ friendship: data });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

io.use(async (socket, next) => {
  try { socket.user = await authUser(socket.handshake.auth?.accessToken); next(); }
  catch (e) { next(fail('Authentication required.')); }
});
io.on('connection', async socket => {
  const user = socket.user; online.set(user.id, socket.id);
  try { await profile(user); } catch {}
  socket.emit('presence:ready', { userId: user.id });
  socket.broadcast.emit('presence:changed', { userId: user.id, online: true });

  socket.on('friend:invite', async ({ friendId, roomCode } = {}, ack = () => {}) => {
    try {
      const code = safeCode(roomCode); if (!code || !friendId) throw fail('Friend and room code are required.');
      const { data, error } = await supabase.from('friendships').select('id').eq('status','accepted').or(`and(requester_id.eq.${user.id},addressee_id.eq.${friendId}),and(requester_id.eq.${friendId},addressee_id.eq.${user.id})`).maybeSingle();
      if (error) throw error; if (!data) throw fail('You can invite accepted friends only.');
      const sid = online.get(friendId); if (!sid) throw fail('Your friend is offline.');
      io.to(sid).emit('friend:invite', { from: user.id, roomCode: code, expiresIn: 60 }); ack({ ok: true });
    } catch (e) { ack({ ok: false, error: e.message }); }
  });

  socket.on('room:create', async ({ code, snapshot, isPrivate = false } = {}, ack = () => {}) => {
    try {
      code = safeCode(code); if (code.length < 4) throw fail('Room code must contain at least 4 letters or numbers.');
      const clean = snapshot && typeof snapshot === 'object' ? snapshot : {};
      const { data, error } = await supabase.from('game_rooms').insert({ code, host_user_id: user.id, state: clean, is_private: !!isPrivate, status: 'active', heartbeat_at: new Date().toISOString() }).select().single();
      if (error) throw error; socket.join(`room:${code}`); ack({ ok: true, room: data });
    } catch (e) { ack({ ok: false, error: e.message }); }
  });
  socket.on('room:join', async ({ code } = {}, ack = () => {}) => {
    try {
      code = safeCode(code); const room = await roomRow(code); if (!room || room.status !== 'active') throw fail('Room not found or expired.');
      if (room.is_private && room.host_user_id !== user.id) throw fail('This is a private room. Join through a friend invitation.');
      socket.join(`room:${code}`); ack({ ok: true, state: room.state, hostUserId: room.host_user_id, updatedAt: room.updated_at });
    } catch (e) { ack({ ok: false, error: e.message }); }
  });
  socket.on('room:save', async ({ code, snapshot } = {}, ack = () => {}) => {
    try {
      code = safeCode(code); const room = await roomRow(code); if (!room) throw fail('Room not found.');
      if (room.host_user_id !== user.id) throw fail('Only the current host can save authoritative room state.', 'FORBIDDEN');
      const state = snapshot && typeof snapshot === 'object' ? snapshot : {};
      await saveRoom(code, { state, heartbeat_at: new Date().toISOString(), status: 'active' }); ack({ ok: true });
    } catch (e) { ack({ ok: false, error: e.message }); }
  });
  socket.on('room:heartbeat', async ({ code } = {}, ack = () => {}) => {
    try { code = safeCode(code); const room = await roomRow(code); if (!room) throw fail('Room not found.'); await saveRoom(code, { heartbeat_at: new Date().toISOString() }); ack({ ok: true }); }
    catch (e) { ack({ ok: false, error: e.message }); }
  });
  socket.on('room:transfer-host', async ({ code, nextHostUserId } = {}, ack = () => {}) => {
    try {
      code = safeCode(code); const room = await roomRow(code); if (!room || room.host_user_id !== user.id) throw fail('Only the current host can transfer host control.');
      const { data: friendship, error } = await supabase.from('friendships').select('id').eq('status','accepted').or(`and(requester_id.eq.${user.id},addressee_id.eq.${nextHostUserId}),and(requester_id.eq.${nextHostUserId},addressee_id.eq.${user.id})`).maybeSingle();
      if (error) throw error; if (!friendship) throw fail('New host must be an accepted friend.');
      await saveRoom(code, { host_user_id: nextHostUserId }); io.to(`room:${code}`).emit('room:host-changed', { hostUserId: nextHostUserId }); ack({ ok: true });
    } catch (e) { ack({ ok: false, error: e.message }); }
  });
  socket.on('disconnect', () => {
    if (online.get(user.id) === socket.id) { online.delete(user.id); socket.broadcast.emit('presence:changed', { userId: user.id, online: false, graceMs: GRACE_MS }); }
  });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`Odd One Out backend listening on :${port}`));

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const { Server } = require('socket.io');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin@123';
const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
[DATA, UPLOADS].forEach(d => fs.mkdirSync(d, { recursive: true }));

let orders = [], chats = {};
try { orders = JSON.parse(fs.readFileSync(path.join(DATA,'orders.json'))); } catch {}
try { chats = JSON.parse(fs.readFileSync(path.join(DATA,'chats.json'))); } catch {}
const saveOrders = () => fs.writeFileSync(path.join(DATA,'orders.json'), JSON.stringify(orders,null,2));
const saveChats = () => fs.writeFileSync(path.join(DATA,'chats.json'), JSON.stringify(chats,null,2));

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (_,res) => res.sendFile(path.join(__dirname,'public','admin.html')));
const upload = multer({ dest: UPLOADS });

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmt = d => `${String(d.getDate()).padStart(2,'0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
const nk = k => String(k).toLowerCase().replace(/[^a-z0-9]/g,'');

function parseDate(v){
  if(!v) return '';
  if(v instanceof Date) return fmt(v);
  if(typeof v === 'number'){ const d = XLSX.SSF.parse_date_code(v); if(d) return `${String(d.d).padStart(2,'0')}-${MONTHS[d.m-1]}-${d.y}`; }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if(m){ let d=+m[1], mo=+m[2], y=+m[3]; if(y<100) y+=2000; return `${String(d).padStart(2,'0')}-${MONTHS[mo-1]}-${y}`; }
  return s;
}

function normRow(row){
  const m = {}; for(const [k,v] of Object.entries(row)) m[nk(k)] = v;
  const r = (...ks) => { for(const k of ks){ const v = m[nk(k)]; if(v!==undefined && v!==null && String(v).trim()) return v; } return ''; };
  const s = (...ks) => String(r(...ks)).trim();
  return {
    dealerCode: s('dealer code','dealercode').toUpperCase(),
    dealerName: s('dealer name','dealername'),
    poNumber: s('po number','ponumber','po no').toUpperCase(),
    poDate: parseDate(r('po date','podate')),
    partNumber: s('part number','partnumber','part no').toUpperCase(),
    description: s('description','desc'),
    quantity: s('quantity','qty'),
    value: s('value','amount'),
    status: s('status').toLowerCase(),
    date: parseDate(r('date','lr date')),
    lrNumber: s('lr number','lrnumber','lr no'),
    etaDate: parseDate(r('eta date','etadate','eta'))
  };
}

function findOrders(text, code){
  const up = text.toUpperCase(), out = [];
  for(const o of orders){
    if(o.dealerCode && o.dealerCode !== code) continue;
    if(o.poNumber && o.poNumber.length>=3 && up.includes(o.poNumber)){ out.push(o); continue; }
    if(o.partNumber && o.partNumber.length>=3 && up.includes(o.partNumber)) out.push(o);
  }
  return out;
}

function fmtOrder(o){
  const L = [`📦 PO: ${o.poNumber||'-'} | Part: ${o.partNumber||'-'}`];
  if(o.description) L.push(`   ${o.description}`);
  if(o.quantity) L.push(`   Qty: ${o.quantity}${o.value?' | ₹'+o.value:''}`);
  const st = (o.status||'').toLowerCase();
  if(/execut|dispatch|deliver|complete|shipped|done/.test(st)){
    L.push(`   ✅ Status: Executed`);
    if(o.lrNumber) L.push(`   🚚 LR Number: ${o.lrNumber}`);
    if(o.date||o.poDate) L.push(`   📅 LR Date: ${o.date||o.poDate}`);
  } else if(/back|pending|hold|await|process/.test(st)){
    L.push(`   ⏳ Status: Back Order`);
    if(o.etaDate||o.date) L.push(`   📅 ETA Date: ${o.etaDate||o.date}`);
  } else {
    L.push(`   Status: ${o.status||'(not updated)'}`);
    if(o.date) L.push(`   Date: ${o.date}`);
  }
  return L.join('\n');
}

function buildSessions(){
  const out = [];
  for(const [code, msgs] of Object.entries(chats)){
    const last = msgs[msgs.length-1];
    const dOrder = orders.find(o => o.dealerCode === code);
    out.push({ dealerCode: code, dealerName: dOrder?.dealerName||'', lastMessage: last?.message||'', lastAt: last?.created_at||'', unread: last?.sender==='dealer', count: msgs.length });
  }
  return out.sort((a,b) => new Date(b.lastAt||0) - new Date(a.lastAt||0));
}

function pushChat(code, msg){
  if(!chats[code]) chats[code] = [];
  chats[code].push(msg);
  saveChats();
}

function botReply(socket, code, text){
  const lower = text.toLowerCase();
  const wantsAgent = /\b(agent|executive|human|insaan|baat|call|representative|manager)\b/.test(lower);
  io.to('dealer:'+code).emit('bot:typing', true);
  setTimeout(() => {
    io.to('dealer:'+code).emit('bot:typing', false);
    let reply = '', escalate = false;
    if(wantsAgent){
      reply = 'Ji bilkul! Maine aapki request support team ko bhej di hai. 👨‍💼';
      escalate = true;
    } else {
      const matches = findOrders(text, code);
      if(matches.length === 1){
        reply = `Yeh aapke order ka status:\n\n${fmtOrder(matches[0])}`;
      } else if(matches.length > 1){
        reply = `Mujhe ${matches.length} orders mile:\n\n` + matches.slice(0,5).map((o,i) => `${i+1}. ${fmtOrder(o)}`).join('\n\n');
      } else if(/\b(saare|all|recent|sab|list)\b/.test(lower)){
        const mine = orders.filter(o => o.dealerCode === code).slice(0,10);
        reply = mine.length
          ? `Aapke recent ${mine.length} orders:\n\n` + mine.map((o,i) => `${i+1}. ${fmtOrder(o)}`).join('\n\n')
          : `Dealer code (${code}) ke against koi order nahi mila.`;
      } else {
        reply = 'Maaf kijiye, is query ka exact jawab nahi mila. Maine query support team ko bhej di hai.';
        escalate = true;
      }
    }
    const botMsg = { sender:'bot', message: reply, created_at: new Date().toISOString(), dealerCode: code };
    pushChat(code, botMsg);
    io.to('dealer:'+code).emit('chat:message', botMsg);
    io.to('admins').emit('chat:message', botMsg);
    if(escalate) io.to('admins').emit('need:agent', { dealerCode: code, dealerName: socket.data.dealerName||'', text });
    io.to('admins').emit('sessions:update', buildSessions());
  }, 600);
}

io.on('connection', socket => {
  socket.on('dealer:join', ({ dealerCode, dealerName } = {}, cb) => {
    dealerCode = String(dealerCode||'').trim().toUpperCase();
    if(!dealerCode) return cb?.({ ok:false, error:'Dealer code required' });
    socket.data.role = 'dealer';
    socket.data.dealerCode = dealerCode;
    const dOrder = orders.find(o => o.dealerCode === dealerCode);
    socket.data.dealerName = dealerName || dOrder?.dealerName || '';
    socket.join('dealer:'+dealerCode);
    if(!chats[dealerCode]){ chats[dealerCode] = []; saveChats(); }
    io.to('admins').emit('sessions:update', buildSessions());
    cb?.({ ok:true, dealerName: socket.data.dealerName, history: chats[dealerCode] });
  });

  socket.on('dealer:message', ({ text } = {}) => {
    if(socket.data.role !== 'dealer' || !text) return;
    const code = socket.data.dealerCode;
    const msg = { sender:'dealer', message: String(text).trim(), created_at: new Date().toISOString(), dealerCode: code };
    pushChat(code, msg);
    io.to('dealer:'+code).emit('chat:message', msg);
    io.to('admins').emit('chat:message', msg);
    io.to('admins').emit('sessions:update', buildSessions());
    botReply(socket, code, msg.message);
  });

  socket.on('admin:join', ({ password } = {}, cb) => {
    if(password !== ADMIN_PASSWORD) return cb?.({ ok:false, error:'Invalid password' });
    socket.data.role = 'admin';
    socket.join('admins');
    cb?.({ ok:true, sessions: buildSessions(), chats, orderCount: orders.length });
  });

  socket.on('admin:reply', ({ dealerCode, text } = {}, cb) => {
    if(socket.data.role !== 'admin' || !dealerCode || !text) return cb?.({ ok:false });
    const msg = { sender:'agent', message: String(text).trim(), created_at: new Date().toISOString(), dealerCode };
    pushChat(dealerCode, msg);
    io.to('dealer:'+dealerCode).emit('chat:message', msg);
    io.to('admins').emit('chat:message', msg);
    io.to('admins').emit('sessions:update', buildSessions());
    cb?.({ ok:true });
  });
});

app.post('/api/admin/upload', upload.single('file'), (req, res) => {
  if(req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error:'unauthorized' });
  if(!req.file) return res.status(400).json({ error:'no file' });
  try {
    const wb = XLSX.readFile(req.file.path, { cellDates:true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval:'' });
    orders = rows.map(normRow).filter(o => o.poNumber || o.partNumber);
    saveOrders();
    fs.unlinkSync(req.file.path);
    io.to('admins').emit('orders:update', { count: orders.length });
    res.json({ ok:true, count: orders.length });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/summary', (req, res) => {
  if(req.query.password !== ADMIN_PASSWORD) return res.status(401).send('unauthorized');
  const wb = XLSX.utils.book_new();
  const orderRows = orders.map(o => ({
    'Dealer Code':o.dealerCode,'Dealer Name':o.dealerName,'PO Number':o.poNumber,'PO Date':o.poDate,
    'Part Number':o.partNumber,'Description':o.description,'Quantity':o.quantity,'Value':o.value,
    'Status':o.status,'LR Number':o.lrNumber,'LR/Date':o.date,'ETA Date':o.etaDate
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(orderRows.length?orderRows:[{}]), 'Orders');
  const chatRows = [];
  for(const [code, msgs] of Object.entries(chats))
    msgs.forEach(m => chatRows.push({ 'Dealer Code':code, 'Sender':m.sender, 'Message':m.message, 'Time': new Date(m.created_at).toLocaleString('en-IN') }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(chatRows.length?chatRows:[{}]), 'Chats');
  const summary = [];
  for(const [code, msgs] of Object.entries(chats)){
    const dOrders = orders.filter(o => o.dealerCode === code);
    summary.push({
      'Dealer Code':code, 'Dealer Name':dOrders[0]?.dealerName||'',
      'Total Orders':dOrders.length,
      'Executed':dOrders.filter(o => /execut|dispatch|deliver|complete|shipped/i.test(o.status||'')).length,
      'Back Order':dOrders.filter(o => /back|pending|hold|await/i.test(o.status||'')).length,
      'Total Messages':msgs.length,
      'Last Activity': msgs.length ? new Date(msgs[msgs.length-1].created_at).toLocaleString('en-IN') : ''
    });
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary.length?summary:[{}]), 'Summary');
  const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="summary.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.get('/api/admin/template', (_, res) => {
  const wb = XLSX.utils.book_new();
  const rows = [
    { 'Dealer Code':'D1001','Dealer Name':'ABC Traders','PO Number':'PO4500123','PO Date':'01-04-2025','Part Number':'AX-2201','Description':'Hydraulic Pump','Quantity':5,'Value':25000,'Status':'Executed','LR Number':'LR99887','Date':'05-04-2025','ETA Date':'' },
    { 'Dealer Code':'D1001','Dealer Name':'ABC Traders','PO Number':'PO4500124','PO Date':'02-04-2025','Part Number':'AX-2202','Description':'Control Valve','Quantity':3,'Value':18000,'Status':'Back Order','LR Number':'','Date':'','ETA Date':'20-04-2025' }
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Orders');
  const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

server.listen(PORT, () => console.log(`✅ Server started on port ${PORT}`));

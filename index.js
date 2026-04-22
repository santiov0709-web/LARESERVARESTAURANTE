process.env.TZ = 'America/Bogota';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const ExcelJS    = require('exceljs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname)));
['/', '/mesero', '/cocina', '/caja'].forEach(r =>
  app.get(r, (req, res) => res.sendFile(path.join(__dirname, 'index.html')))
);

/* ══════════════════════════════════════════════
   IN-MEMORY STATE  (source of truth, always works)
   ══════════════════════════════════════════════ */
const activeOrders = new Map();   // id → order
const tableBills   = new Map();   // mesa → bill
let   orderCounter = 0;
let   inventory    = {};
let   dailySales   = [];
let   MENU = {
  'Bebidas': [
    {n:'Coca-Cola',p:5000},{n:'Coronita',p:8000},{n:'Jugo Natural',p:7000},
    {n:'Sprite',p:5000},{n:'Agua Cristal',p:3000},{n:'Club Colombia',p:7000},{n:'Limonada',p:6000}
  ],
  'Licores': [
    {n:'Aguardiente (Copa)',p:5000},{n:'Aguardiente (Media)',p:45000},
    {n:'Tequila (Trago)',p:15000},{n:'Ron Viejo (Trago)',p:10000},{n:'Whisky Old Parr',p:220000}
  ],
  'Comidas': [
    {n:'Patacones',p:12000},{n:'Filete Miñón',p:45000},{n:'Hamburguesa',p:18000},
    {n:'Alitas BBQ (x6)',p:16000},{n:'Picada Mixta',p:35000},{n:'Ceviche',p:28000}
  ]
};
let dailyDate = new Date().toLocaleDateString('es-CO',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'});
const CAJA_PASSWORD = '0707';

function formatCOP(n){ return '$' + Math.round(n).toLocaleString('es-CO'); }
function getDailyTotal(){ return dailySales.reduce((s,t)=>s+t.total,0); }
function resetDailyIfNewDay(){
  const today = new Date().toLocaleDateString('es-CO',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'});
  if(today !== dailyDate){ dailySales=[]; dailyDate=today; }
}

/* ══════════════════════════════════════════════
   MONGODB  (optional persistence — never blocks events)
   ══════════════════════════════════════════════ */
let dbReady = false;
let Order, Bill, Sale, Inventory, Config;

try {
  const mongoose = require('mongoose');
  const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/la-reserva';

  mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
    .then(async () => {
      dbReady = true;
      console.log('✅ MongoDB conectado — cargando estado persistido...');

      Order     = mongoose.model('Order',     new mongoose.Schema({id:Number,mesa:Number,items:Array,mesero:String,hora:String,timestamp:Number}));
      Bill      = mongoose.model('Bill',      new mongoose.Schema({mesa:Number,items:{type:Array,default:[]},total:{type:Number,default:0},mesero:String,openedAt:String}));
      Sale      = mongoose.model('Sale',      new mongoose.Schema({mesa:Number,mesero:String,items:Array,total:Number,paymentMethod:String,openedAt:String,closedAt:String,timestamp:{type:Number,default:Date.now}}));
      Inventory = mongoose.model('Inventory', new mongoose.Schema({itemName:{type:String,unique:true},stock:{type:Number,default:0}}));
      Config    = mongoose.model('Config',    new mongoose.Schema({key:{type:String,unique:true},value:Object}));

      // Restore in-memory state from DB
      const [orders, bills, invDocs, cfgMenu, sales] = await Promise.all([
        Order.find().sort({timestamp:1}),
        Bill.find(),
        Inventory.find(),
        Config.findOne({key:'menu'}),
        Sale.find({timestamp:{$gte: (() => { const d=new Date(); d.setHours(0,0,0,0); return d.getTime(); })()}})
      ]);

      orders.forEach(o => { activeOrders.set(o.id, o.toObject()); if(o.id>=orderCounter) orderCounter=o.id; });
      bills.forEach(b => tableBills.set(b.mesa, b.toObject()));
      invDocs.forEach(d => { inventory[d.itemName] = d.stock; });
      if(cfgMenu && cfgMenu.value) MENU = cfgMenu.value;
      dailySales = sales.map(s => s.toObject());

      console.log(`📦 Estado restaurado: ${activeOrders.size} pedidos, ${tableBills.size} cuentas, ${Object.keys(inventory).length} items de inventario`);

      // Notify all connected clients of restored state
      io.emit('menu-updated', MENU);
      io.emit('active-orders', Array.from(activeOrders.values()));
      io.emit('all-bills', Object.fromEntries(tableBills));
      io.emit('all-inventory', inventory);
      io.emit('daily-sales-update', {total:getDailyTotal(), count:dailySales.length, date:dailyDate, transactions:dailySales});
    })
    .catch(err => console.warn('⚠️  MongoDB no disponible — modo en memoria:', err.message));
} catch(e) {
  console.warn('⚠️  mongoose no instalado — modo en memoria puro');
}

/* ── Persist helpers (non-blocking, never throw) ── */
function persist(fn) {
  if (!dbReady) return;
  Promise.resolve().then(fn).catch(e => console.warn('DB persist warn:', e.message));
}

/* ══════════════════════════════════════════════
   REST API
   ══════════════════════════════════════════════ */
app.get('/api/menu', (req, res) => res.json(MENU));

app.post('/api/menu', (req, res) => {
  MENU = req.body;
  io.emit('menu-updated', MENU);
  persist(() => Config.findOneAndUpdate({key:'menu'},{value:MENU},{upsert:true,new:true}));
  res.json({ok:true});
});

app.get('/api/export-daily', async (req, res) => {
  try {
    resetDailyIfNewDay();
    const wb = new ExcelJS.Workbook();
    wb.creator = 'La Reserva';
    const ws = wb.addWorksheet('Venta Diaria');

    const hFill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1a3324'}};
    const hFont = {bold:true,color:{argb:'FFe8f0ec'},size:12};
    const gold  = {bold:true,color:{argb:'FFf0c040'},size:13};
    const bdr   = {top:{style:'thin'},left:{style:'thin'},bottom:{style:'thin'},right:{style:'thin'}};

    ws.mergeCells('A1:G1');
    const t = ws.getCell('A1');
    t.value='LA RESERVA — Reporte de Venta Diaria'; t.font={bold:true,color:{argb:'FF2ecc71'},size:16}; t.alignment={horizontal:'center'};
    t.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF0b140f'}};

    ws.mergeCells('A2:G2');
    const d = ws.getCell('A2');
    d.value=`Fecha: ${dailyDate}`; d.font={bold:true,size:11,color:{argb:'FF8fa89a'}}; d.alignment={horizontal:'center'};
    d.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF0b140f'}};

    ws.addRow([]);
    ws.columns=[{key:'num',width:6},{key:'mesa',width:10},{key:'mesero',width:18},{key:'hora',width:14},{key:'productos',width:42},{key:'metodo',width:16},{key:'total',width:16}];

    const hRow = ws.addRow(['#','Mesa','Mesero','Hora Cierre','Productos','Método Pago','Total']);
    hRow.height = 28;
    hRow.eachCell(c=>{c.fill=hFill;c.font=hFont;c.border=bdr;c.alignment={horizontal:'center',vertical:'middle'};});

    dailySales.forEach((tx,i) => {
      const list = tx.items.map(it=>`${it.name} x${it.qty}${it.note?' ['+it.note+']':''} (${formatCOP(it.price*it.qty)})`).join(', ');
      const row = ws.addRow([i+1,`Mesa ${tx.mesa}`,tx.mesero||'—',tx.closedAt,list,tx.paymentMethod||'—',tx.total]);
      row.getCell('total').numFmt='"$"#,##0';
      row.height = Math.max(22,Math.ceil(list.length/40)*18);
      row.eachCell(c=>{c.border=bdr;c.alignment={vertical:'middle',wrapText:true};});
      if(i%2===0) row.eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF0f1e15'}};});
    });

    ws.addRow([]);
    const totRow = ws.addRow(['','','','','','TOTAL DÍA:',getDailyTotal()]);
    totRow.getCell(6).font=gold; totRow.getCell(7).font=gold;
    totRow.getCell(7).numFmt='"$"#,##0'; totRow.getCell(6).alignment={horizontal:'right'};

    // Breakdown por método
    const methods={};
    dailySales.forEach(tx=>{ const m=tx.paymentMethod||'Sin método'; methods[m]=(methods[m]||0)+tx.total; });
    ws.addRow([]);
    const bh=ws.addRow(['','','','','','Método','Total']);
    bh.getCell(6).font=hFont; bh.getCell(6).fill=hFill;
    bh.getCell(7).font=hFont; bh.getCell(7).fill=hFill;
    Object.entries(methods).forEach(([m,t])=>{ const r=ws.addRow(['','','','','',m,t]); r.getCell(7).numFmt='"$"#,##0'; });

    const fileName=`Ventas_LaReserva_${dailyDate.replace(/\//g,'-')}.xlsx`;
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="${fileName}"`);
    await wb.xlsx.write(res); res.end();
  } catch(e) {
    console.error('Excel error:',e);
    res.status(500).json({error:'Error generando Excel'});
  }
});

/* ══════════════════════════════════════════════
   SOCKET.IO  — 100% in-memory, never blocked by DB
   ══════════════════════════════════════════════ */
io.on('connection', (socket) => {
  console.log(`🔌 Cliente: ${socket.id}`);
  resetDailyIfNewDay();

  // Send full current state immediately
  socket.emit('menu-updated',       MENU);
  socket.emit('active-orders',      Array.from(activeOrders.values()));
  socket.emit('all-bills',          Object.fromEntries(tableBills));
  socket.emit('all-inventory',      inventory);
  socket.emit('daily-sales-update', {total:getDailyTotal(),count:dailySales.length,date:dailyDate,transactions:dailySales});

  /* ── Verify caja ── */
  socket.on('verify-caja-password', (pwd, cb) => cb(pwd === CAJA_PASSWORD));

  /* ── New order ── */
  socket.on('new-order', (data) => {
    orderCounter++;
    const order = {
      id: orderCounter,
      mesa: data.mesa,
      items: data.items,
      mesero: data.mesero || 'Mesero',
      hora: new Date().toLocaleTimeString('es-CO',{timeZone:'America/Bogota',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}),
      timestamp: Date.now()
    };
    activeOrders.set(order.id, order);

    // Descontar inventario
    data.items.forEach(it => {
      if (inventory[it.name] !== undefined) {
        inventory[it.name] = Math.max(0, inventory[it.name] - it.qty);
      }
    });

    // Abrir cuenta si no existe
    if (!tableBills.has(order.mesa)) {
      tableBills.set(order.mesa, {
        mesa: order.mesa, items: [], total: 0,
        mesero: data.mesero || 'Mesero',
        openedAt: new Date().toLocaleTimeString('es-CO',{timeZone:'America/Bogota',hour:'2-digit',minute:'2-digit',hour12:true})
      });
    }

    // Broadcast immediately
    io.emit('order-received', order);
    io.emit('all-bills',   Object.fromEntries(tableBills));
    io.emit('all-inventory', inventory);
    console.log(`📋 Pedido #${order.id} — Mesa ${order.mesa} (${order.mesero}): ${order.items.length} ítems`);

    // Async persist
    persist(async () => {
      const o = new Order(order); await o.save();
      await Bill.findOneAndUpdate({mesa:order.mesa},{$setOnInsert:{mesa:order.mesa,items:[],total:0,mesero:order.mesero,openedAt:order.openedAt}},{upsert:true,new:true});
      for(const it of data.items){
        await Inventory.findOneAndUpdate({itemName:it.name},{stock:Math.max(0,(inventory[it.name]||0))},{upsert:true,new:true});
      }
    });
  });

  /* ── Dispatch order → items go to bill ── */
  socket.on('dispatch-order', (orderId) => {
    const order = activeOrders.get(orderId);
    if (!order) return;

    const bill = tableBills.get(order.mesa);
    if (bill) {
      order.items.forEach(item => {
        const key = item.note ? `${item.name}_${item.note}` : item.name;
        const ex  = bill.items.find(b => (b.note?`${b.name}_${b.note}`:b.name) === key);
        if (ex) ex.qty += item.qty;
        else bill.items.push({name:item.name,qty:item.qty,price:item.price,note:item.note||''});
        bill.total += item.price * item.qty;
      });
      tableBills.set(order.mesa, bill);
    }

    activeOrders.delete(orderId);
    io.emit('order-dispatched', {id:orderId, mesa:order.mesa, mesero:order.mesero});
    io.emit('all-bills', Object.fromEntries(tableBills));
    console.log(`✅ Pedido #${orderId} despachado — Mesa ${order.mesa}`);

    persist(async () => {
      await Order.deleteOne({id:orderId});
      if(bill) await Bill.findOneAndUpdate({mesa:order.mesa},{items:bill.items,total:bill.total},{upsert:true});
    });
  });

  /* ── Close account ── */
  socket.on('close-account', ({mesa, paymentMethod}) => {
    const bill = tableBills.get(mesa);
    if (!bill) return;

    const transaction = {
      mesa: bill.mesa, mesero: bill.mesero,
      items: [...bill.items], total: bill.total,
      paymentMethod, openedAt: bill.openedAt,
      closedAt: new Date().toLocaleTimeString('es-CO',{timeZone:'America/Bogota',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}),
      timestamp: Date.now()
    };
    dailySales.push(transaction);
    tableBills.delete(mesa);

    io.emit('account-closed', {mesa, bill:transaction});
    io.emit('all-bills', Object.fromEntries(tableBills));
    io.emit('daily-sales-update', {total:getDailyTotal(),count:dailySales.length,date:dailyDate,transactions:dailySales});
    console.log(`💰 Mesa ${mesa} cerrada — ${paymentMethod} — ${formatCOP(bill.total)}`);

    persist(async () => {
      await new Sale(transaction).save();
      await Bill.deleteOne({mesa});
    });
  });

  /* ── Update inventory ── */
  socket.on('update-inventory', (data) => {
    Object.assign(inventory, data);
    io.emit('all-inventory', inventory);

    persist(async () => {
      for(const [name, stock] of Object.entries(data)){
        await Inventory.findOneAndUpdate({itemName:name},{stock},{upsert:true,new:true});
      }
    });
  });

  /* ── Reset daily ── */
  socket.on('reset-daily', () => {
    dailySales = [];
    dailyDate = new Date().toLocaleDateString('es-CO',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'});
    io.emit('daily-sales-update', {total:0,count:0,date:dailyDate,transactions:[]});
    console.log('🔄 Venta diaria reiniciada manualmente');

    persist(async () => {
      const d=new Date(); d.setHours(0,0,0,0);
      await Sale.deleteMany({timestamp:{$gte:d.getTime()}});
    });
  });

  socket.on('disconnect', () => console.log(`👋 Desconectado: ${socket.id}`));
});

/* ══════════════════════════════════════════════
   START
   ══════════════════════════════════════════════ */
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🍽️  LA RESERVA — Sistema de Comandas`);
  console.log(`🟢 http://localhost:${PORT}`);
  console.log(`📋 Mesero: http://localhost:${PORT}/mesero`);
  console.log(`🍳 Cocina: http://localhost:${PORT}/cocina`);
  console.log(`💰 Caja:   http://localhost:${PORT}/caja\n`);
});

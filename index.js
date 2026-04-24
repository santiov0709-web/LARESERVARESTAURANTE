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
let MENU = {
  'ENTRADAS': [
    { n: 'Choricitos La Reserva', p: 25000 },
    { n: 'Tostadas de Ajo', p: 25000 },
    { n: 'Canastas de Plátano', p: 25000 }
  ],
  'CERVEZAS': [
    { n: 'Corona', p: 12000 },
    { n: 'Stella Artois', p: 12000 },
    { n: 'Club Colombia', p: 10000 },
    { n: 'Águila Light', p: 7000 },
    { n: 'Poker', p: 7000 },
    { n: 'Pilsen', p: 7000 },
    { n: 'Águila', p: 7000 }
  ],
  'GASEOSAS': [
    { n: 'Coca-Cola', p: 5000 },
    { n: 'Tamarindo', p: 5000 },
    { n: 'Manzana', p: 5000 },
    { n: 'Colombiana', p: 5000 },
    { n: 'Granizado Mandarina', p: 9000 }
  ],
  'PLATOS FUERTES (Principales)': [
    { n: 'FILET MIGNONT', p: 62000 },
    { n: 'STROGANOF', p: 62000 },
    { n: 'SOLOMITO', p: 62000 },
    { n: 'PARRILLADA', p: 60000 },
    { n: 'PICADA', p: 60000 },
    { n: 'SALMON', p: 55000 },
    { n: 'ROBALO', p: 55000 },
    { n: 'CAZUELA', p: 55000 },
    { n: 'CHURRASCO', p: 53000 },
    { n: 'PUNTA DE ANCA', p: 53000 },
    { n: 'BABY BEFF', p: 53000 },
    { n: 'PECHUGA', p: 48000 },
    { n: 'CORDON BLU', p: 48000 },
    { n: 'CHULETA', p: 48000 },
    { n: 'SOBREBARRIGA', p: 48000 },
    { n: 'COSTILLAS BBQ', p: 45000 },
    { n: 'CEVICHE', p: 43000 }
  ],
  'PASTAS': [
    { n: 'Carbonada', p: 50000 },
    { n: 'Bologñesa', p: 50000 },
    { n: 'En Camarón', p: 50000 },
    { n: 'Marinera', p: 50000 }
  ],
  'COMIDA RÁPIDA / INFANTIL': [
    { n: 'Papas Maxi', p: 45000 },
    { n: 'Árabe', p: 38000 },
    { n: 'Cajita Feliz', p: 37000 },
    { n: 'Hamburguesa', p: 35000 },
    { n: 'Salchipapa', p: 35000 },
    { n: 'Desgranado', p: 35000 },
    { n: 'Creps', p: 35000 },
    { n: 'Patacón', p: 35000 },
    { n: 'Menú Muslitos', p: 35000 },
    { n: 'Menú Pechuga', p: 35000 }
  ],
  'LICORES (Botellas)': [
    { n: 'Buchanans', p: 190000 },
    { n: 'Casillero', p: 150000 },
    { n: 'Dubonnet', p: 120000 },
    { n: 'Manischewitz', p: 120000 },
    { n: 'Baileys', p: 120000 },
    { n: 'Chivas Regal', p: 110000 },
    { n: 'Old Parr', p: 110000 },
    { n: 'JP Chenet', p: 100000 },
    { n: 'Sello Rojo', p: 95000 },
    { n: 'Lazo', p: 90000 },
    { n: 'Gato Negro', p: 90000 }
  ],
  'EXTRAS Y EMPAQUES': [
    { n: 'Crema de Pollo', p: 12000 },
    { n: 'Porción Tropi', p: 12000 },
    { n: 'Adicional de Papas Fritas', p: 10000 },
    { n: 'Pico de Gallo', p: 10000 },
    { n: 'Adicional (General)', p: 8000 },
    { n: 'Galleta', p: 2000 },
    { n: 'Sumo de Limón', p: 2000 },
    { n: 'Desechable de Caja', p: 2000 },
    { n: 'Desechable Plástico', p: 1000 }
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
let isServerEmpty = true; // Si es true, la primera Caja que entre enviará su copia
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

      console.log(`📦 Estado restaurado de Mongo: ${activeOrders.size} pedidos, ${tableBills.size} cuentas, ${Object.keys(inventory).length} items`);
      isServerEmpty = false;

      // Notify all connected clients of restored state
      io.emit('menu-updated', MENU);
      io.emit('active-orders', Array.from(activeOrders.values()));
      io.emit('all-bills', Object.fromEntries(tableBills));
      io.emit('all-inventory', inventory);
      io.emit('daily-sales-update', {total:getDailyTotal(), count:dailySales.length, date:dailyDate, transactions:dailySales});
    })
    .catch(err => { console.warn('⚠️  MongoDB no disponible — modo en memoria:', err.message); isServerEmpty = true; });
} catch(e) {
  console.warn('⚠️  mongoose no instalado — modo en memoria puro');
  isServerEmpty = true;
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
    const wb = new ExcelJS.Workbook();
    wb.creator = 'La Reserva';

    let allSales = [];
    if (dbReady) {
      allSales = await Sale.find().sort({timestamp: 1});
    } else {
      resetDailyIfNewDay();
      allSales = dailySales;
    }

    const grouped = {};
    allSales.forEach(s => {
      // Formato DD-MM-YYYY para el nombre de la pestaña
      const d = new Date(s.timestamp).toLocaleDateString('es-CO', {timeZone:'America/Bogota', year:'numeric', month:'2-digit', day:'2-digit'}).replace(/\//g,'-');
      if (!grouped[d]) grouped[d] = [];
      grouped[d].push(s);
    });

    if (Object.keys(grouped).length === 0) {
      const ws = wb.addWorksheet('Sin Ventas');
      ws.addRow(['No hay ventas registradas aún.']);
    } else {
      const hFill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1a3324'}}; // Dark Green
      const hFont = {bold:true,color:{argb:'FFFFFFFF'},size:12}; // White
      const gold  = {bold:true,color:{argb:'FF27ae60'},size:13}; // Darker Green for Totals
      const bdr   = {top:{style:'thin'},left:{style:'thin'},bottom:{style:'thin'},right:{style:'thin'}};

      // Ordenar fechas descendentes (la más reciente primero)
      const sortedDates = Object.keys(grouped).sort((a,b) => {
        const [d1,m1,y1] = a.split('-');
        const [d2,m2,y2] = b.split('-');
        return new Date(y2,m2-1,d2) - new Date(y1,m1-1,d1);
      });

      sortedDates.forEach(dateStr => {
        const sales = grouped[dateStr];
        const ws = wb.addWorksheet(dateStr);
        
        ws.mergeCells('A1:G1');
        const t = ws.getCell('A1');
        t.value='LA RESERVA — REPORTE DE VENTAS'; t.font={bold:true,color:{argb:'FFFFFFFF'},size:16}; t.alignment={horizontal:'center'};
        t.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1a3324'}};

        ws.mergeCells('A2:G2');
        const d = ws.getCell('A2');
        d.value=`Fecha: ${dateStr.replace(/-/g,'/')}`; d.font={bold:true,size:11,color:{argb:'FF8fa89a'}}; d.alignment={horizontal:'center'};
        d.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF0b140f'}};

        ws.addRow([]);
        ws.columns=[{key:'num',width:6},{key:'mesa',width:10},{key:'mesero',width:18},{key:'hora',width:14},{key:'productos',width:42},{key:'metodo',width:16},{key:'total',width:16}];

        const hRow = ws.addRow(['#','Mesa','Mesero','Hora Cierre','Productos','Método Pago','Total']);
        hRow.height = 28;
        hRow.eachCell(c=>{c.fill=hFill;c.font=hFont;c.border=bdr;c.alignment={horizontal:'center',vertical:'middle'};});

        let dayTotal = 0;
        const methods = {};

        sales.forEach((tx,i) => {
          const list = tx.items.map(it=>`${it.name} x${it.qty}${it.note?' ['+it.note+']':''} (${formatCOP(it.price*it.qty)})`).join(', ');
          const row = ws.addRow([i+1,`Mesa ${tx.mesa}`,tx.mesero||'—',tx.closedAt,list,tx.paymentMethod||'—',tx.total]);
          row.getCell('total').numFmt='"$"#,##0';
          row.height = Math.max(22,Math.ceil(list.length/40)*18);
          row.eachCell(c=>{c.border=bdr;c.alignment={vertical:'middle',wrapText:true};});
          if(i%2===0) row.eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF2F2F2'}};}); // Light Grey
          
          dayTotal += tx.total;
          const m = tx.paymentMethod || 'Sin método';
          methods[m] = (methods[m]||0) + tx.total;
        });

        ws.addRow([]);
        const totRow = ws.addRow(['','','','','','TOTAL DÍA:',dayTotal]);
        totRow.getCell(6).font=gold; totRow.getCell(7).font=gold;
        totRow.getCell(7).numFmt='"$"#,##0'; totRow.getCell(6).alignment={horizontal:'right'};

        // Breakdown por método en esa hoja
        ws.addRow([]);
        const bh=ws.addRow(['','','','','','Método','Total']);
        bh.getCell(6).font=hFont; bh.getCell(6).fill=hFill;
        bh.getCell(7).font=hFont; bh.getCell(7).fill=hFill;
        Object.entries(methods).forEach(([m,t])=>{ const r=ws.addRow(['','','','','',m,t]); r.getCell(7).numFmt='"$"#,##0'; });
      });
    }

    const fileName='Reporte_Ventas_LaReserva.xlsx';
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
  socket.on('verify-caja-password', (pwd, cb) => {
    const ok = (pwd === CAJA_PASSWORD);
    cb(ok);
    if (ok && isServerEmpty) { socket.emit('request-backup'); }
  });

  /* ── INYECCIÓN DEL RESPALDO DESDE LA CAJA (Client-Side DB) ── */
  socket.on('restore-backup', (bk) => {
    if (!isServerEmpty) return; // si ya se inyectó, ignora
    if (!bk) return;

    try {
      if (bk.menu) MENU = bk.menu;
      if (bk.inv) inventory = bk.inv;
      if (bk.sales) dailySales = bk.sales;
      if (bk.date) dailyDate = bk.date;
      if (bk.orders) { activeOrders.clear(); bk.orders.forEach(o => activeOrders.set(o.id, o)); }
      if (bk.bills)  { tableBills.clear(); Object.entries(bk.bills).forEach(([m, b]) => tableBills.set(Number(m), b)); }
      
      let maxO = 0;
      activeOrders.forEach(o => { if(o.id>maxO) maxO=o.id; });
      orderCounter = maxO;
      isServerEmpty = false;

      console.log('✅ RESPALDO RECIBIDO DESDE CAJA. Datos restaurados.');
      io.emit('menu-updated', MENU);
      io.emit('active-orders', Array.from(activeOrders.values()));
      io.emit('all-bills', Object.fromEntries(tableBills));
      io.emit('all-inventory', inventory);
      io.emit('daily-sales-update', {total:getDailyTotal(),count:dailySales.length,date:dailyDate,transactions:dailySales});
      
      // Persistir a DB por si la DB de pura casualidad volvió luego (opcional)
      persist(async () => {
         await Config.findOneAndUpdate({key:'menu'},{value:MENU},{upsert:true});
      });
    } catch(e) { console.error('Error inyectando el backup', e); }
  });

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

  /* ── Partial payment (Dividir cuenta) ── */
  socket.on('partial-payment', ({mesa, paymentMethod, paidItems}) => {
    const bill = tableBills.get(mesa);
    if (!bill) return;
    
    // paidItems es array de { index: número, qtyToPay: número }
    // Asumimos que validan contra el bill real.
    const transactionItems = [];
    let partialTotal = 0;

    paidItems.forEach(pi => {
      const bItem = bill.items[pi.index];
      if (bItem && pi.qtyToPay > 0 && pi.qtyToPay <= bItem.qty) {
        // Añadir a la transacción
        transactionItems.push({ name: bItem.name, qty: pi.qtyToPay, price: bItem.price, note: bItem.note });
        partialTotal += (bItem.price * pi.qtyToPay);
        // Descontar del bill
        bItem.qty -= pi.qtyToPay;
      }
    });

    if (transactionItems.length === 0) return;

    // Limpiar items en 0 del bill
    bill.items = bill.items.filter(i => i.qty > 0);
    bill.total -= partialTotal;

    const transaction = {
      mesa: bill.mesa, mesero: bill.mesero,
      items: transactionItems, total: partialTotal,
      paymentMethod, openedAt: bill.openedAt,
      closedAt: new Date().toLocaleTimeString('es-CO',{timeZone:'America/Bogota',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}),
      timestamp: Date.now()
    };
    dailySales.push(transaction);

    console.log(`💰 Mesa ${mesa} PAGO PARCIAL — ${paymentMethod} — ${formatCOP(partialTotal)}`);

    // Si la mesa quedó vacía, se cierra del todo
    if (bill.items.length === 0) {
      tableBills.delete(mesa);
      io.emit('account-closed', {mesa, bill:transaction});
      persist(async () => { await new Sale(transaction).save(); await Bill.deleteOne({mesa}); });
    } else {
      tableBills.set(mesa, bill);
      persist(async () => { await new Sale(transaction).save(); await Bill.findOneAndUpdate({mesa},{items:bill.items,total:bill.total}); });
    }

    io.emit('all-bills', Object.fromEntries(tableBills));
    io.emit('daily-sales-update', {total:getDailyTotal(),count:dailySales.length,date:dailyDate,transactions:dailySales});
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
      await Sale.deleteMany({});
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

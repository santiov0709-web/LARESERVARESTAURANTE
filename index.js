process.env.TZ = 'America/Bogota';

// ── Imports ──
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const ExcelJS    = require('exceljs');
const mongoose   = require('mongoose');

// ── App Setup ──
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Routes for SPA ──
['/', '/mesero', '/cocina', '/caja'].forEach(r =>
  app.get(r, (req, res) => res.sendFile(path.join(__dirname, 'index.html')))
);

// ── MongoDB ──
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/la-reserva';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ── Schemas & Models ──
const Order = mongoose.model('Order', new mongoose.Schema({
  id: Number, mesa: Number, items: Array,
  mesero: String, hora: String, timestamp: { type: Number, default: Date.now }
}));

const Bill = mongoose.model('Bill', new mongoose.Schema({
  mesa: Number, items: { type: Array, default: [] },
  total: { type: Number, default: 0 },
  mesero: String, openedAt: String
}));

const Sale = mongoose.model('Sale', new mongoose.Schema({
  mesa: Number, mesero: String, items: Array,
  total: Number, paymentMethod: String,
  openedAt: String, closedAt: String,
  timestamp: { type: Number, default: Date.now }
}));

const Inventory = mongoose.model('Inventory', new mongoose.Schema({
  itemName: { type: String, unique: true }, stock: { type: Number, default: 0 }
}));

const Config = mongoose.model('Config', new mongoose.Schema({
  key: { type: String, unique: true }, value: Object
}));

// ── Default Menu ──
const DEFAULT_MENU = {
  'Bebidas':  [
    {n:'Coca-Cola', p:5000}, {n:'Coronita', p:8000}, {n:'Jugo Natural', p:7000},
    {n:'Sprite', p:5000},    {n:'Agua Cristal', p:3000}, {n:'Club Colombia', p:7000},
    {n:'Limonada', p:6000}
  ],
  'Licores': [
    {n:'Aguardiente (Copa)', p:5000},  {n:'Aguardiente (Media)', p:45000},
    {n:'Tequila (Trago)', p:15000},    {n:'Ron Viejo (Trago)', p:10000},
    {n:'Whisky Old Parr', p:220000}
  ],
  'Comidas': [
    {n:'Patacones', p:12000}, {n:'Filete Miñón', p:45000}, {n:'Hamburguesa', p:18000},
    {n:'Alitas BBQ (x6)', p:16000}, {n:'Picada Mixta', p:35000}, {n:'Ceviche', p:28000}
  ]
};

let MENU = { ...DEFAULT_MENU };

async function initMenu() {
  try {
    const cfg = await Config.findOne({ key: 'menu' });
    if (cfg && cfg.value) MENU = cfg.value;
  } catch(e) { console.error('Error cargando menú:', e); }
}

mongoose.connection.once('open', () => initMenu());

// ── REST: Menu ──
app.get('/api/menu', (req, res) => res.json(MENU));
app.post('/api/menu', async (req, res) => {
  try {
    MENU = req.body;
    await Config.findOneAndUpdate({ key: 'menu' }, { value: MENU }, { upsert: true, new: true });
    io.emit('menu-updated', MENU);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── REST: Excel Export ──
app.get('/api/export-daily', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('es-CO', {
      timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const sales = await Sale.find({ timestamp: { $gte: startOfDay.getTime() } });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'La Reserva';
    const ws = wb.addWorksheet('Venta Diaria');

    const green  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10b981' } };
    const hFont  = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
    const border = {
      top: {style:'thin'}, left: {style:'thin'},
      bottom: {style:'thin'}, right: {style:'thin'}
    };

    ws.mergeCells('A1:G1');
    const t = ws.getCell('A1');
    t.value = 'LA RESERVA — Reporte de Venta Diaria';
    t.font  = { bold: true, size: 16, color: { argb: 'FF10b981' } };
    t.alignment = { horizontal: 'center' };

    ws.mergeCells('A2:G2');
    const d = ws.getCell('A2');
    d.value = `Fecha: ${today}`;
    d.alignment = { horizontal: 'center' };

    ws.addRow([]);
    ws.columns = [
      {key:'num',width:6},{key:'mesa',width:10},{key:'mesero',width:18},
      {key:'hora',width:14},{key:'productos',width:42},{key:'metodo',width:16},{key:'total',width:16}
    ];

    const hRow = ws.addRow(['#','Mesa','Mesero','Hora Cierre','Productos','Método Pago','Total']);
    hRow.eachCell(c => { c.fill=green; c.font=hFont; c.border=border; c.alignment={horizontal:'center'}; });

    sales.forEach((tx, i) => {
      const list = tx.items.map(it =>
        `${it.name} x${it.qty}${it.note ? ' ['+it.note+']' : ''} ($${(it.price*it.qty).toLocaleString()})`
      ).join(', ');
      const row = ws.addRow([i+1, `Mesa ${tx.mesa}`, tx.mesero, tx.closedAt, list, tx.paymentMethod, tx.total]);
      row.getCell('total').numFmt = '"$"#,##0';
      row.eachCell(c => { c.border=border; c.alignment={vertical:'middle',wrapText:true}; });
    });

    const dayTotal = sales.reduce((s,t) => s + t.total, 0);
    ws.addRow([]);
    const tRow = ws.addRow(['','','','','','TOTAL DÍA:', dayTotal]);
    tRow.getCell(7).numFmt = '"$"#,##0';
    tRow.getCell(6).font = { bold: true };
    tRow.getCell(7).font = { bold: true, color: { argb: 'FFfbbf24' } };

    const fileName = `Ventas_LaReserva_${today.replace(/\//g,'-')}.xlsx`;
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch(e) {
    console.error('Excel error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Helpers ──
const CAJA_PASSWORD = '0707';
const todayStart = () => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); };
let dailyDate = new Date().toLocaleDateString('es-CO', {
  timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit'
});

// ── Socket.io ──
io.on('connection', async (socket) => {
  console.log(`🔌 Cliente: ${socket.id}`);

  try {
    const [orders, bills, sales, invDocs] = await Promise.all([
      Order.find().sort({ timestamp: 1 }),
      Bill.find(),
      Sale.find({ timestamp: { $gte: todayStart() } }),
      Inventory.find()
    ]);

    const inv = {};
    invDocs.forEach(d => { inv[d.itemName] = d.stock; });

    socket.emit('active-orders', orders);
    socket.emit('all-bills', Object.fromEntries(bills.map(b => [b.mesa, b])));
    socket.emit('daily-sales-update', {
      total: sales.reduce((s,t) => s + t.total, 0),
      count: sales.length, date: dailyDate, transactions: sales
    });
    socket.emit('all-inventory', inv);
    socket.emit('menu-updated', MENU);
  } catch(e) { console.error('Socket init error:', e); }

  // ─ Verify Caja ─
  socket.on('verify-caja-password', (pwd, cb) => cb(pwd === CAJA_PASSWORD));

  // ─ New Order ─
  socket.on('new-order', async (data) => {
    try {
      const last = await Order.findOne().sort({ id: -1 });
      const nextId = (last ? last.id : 0) + 1;

      const order = await new Order({
        id: nextId, mesa: data.mesa,
        items: data.items,
        mesero: data.mesero || 'Mesero',
        hora: new Date().toLocaleTimeString('es-CO', {
          timeZone:'America/Bogota', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true
        })
      }).save();

      // Descontar inventario
      for (const it of data.items) {
        await Inventory.findOneAndUpdate(
          { itemName: it.name },
          { $inc: { stock: -it.qty } },
          { upsert: true, new: true }
        );
      }

      // Cuenta de mesa
      let bill = await Bill.findOne({ mesa: data.mesa });
      if (!bill) {
        bill = new Bill({
          mesa: data.mesa, mesero: data.mesero || 'Mesero',
          openedAt: new Date().toLocaleTimeString('es-CO', {
            timeZone:'America/Bogota', hour:'2-digit', minute:'2-digit', hour12:true
          })
        });
      }
      await bill.save();

      const allBills = await Bill.find();
      const invDocs  = await Inventory.find();
      const inv = {}; invDocs.forEach(d => { inv[d.itemName] = d.stock; });

      io.emit('order-received', order);
      io.emit('all-bills', Object.fromEntries(allBills.map(b => [b.mesa, b])));
      io.emit('all-inventory', inv);
    } catch(e) { console.error('new-order error:', e); }
  });

  // ─ Dispatch Order ─
  socket.on('dispatch-order', async (orderId) => {
    try {
      const order = await Order.findOne({ id: orderId });
      if (!order) return;

      let bill = await Bill.findOne({ mesa: order.mesa });
      if (bill) {
        for (const item of order.items) {
          const key = item.note ? `${item.name}::${item.note}` : item.name;
          const ex  = bill.items.find(b => (b.note ? `${b.name}::${b.note}` : b.name) === key);
          if (ex) ex.qty += item.qty;
          else bill.items.push({ name: item.name, qty: item.qty, price: item.price, note: item.note || '' });
          bill.total += item.price * item.qty;
        }
        bill.markModified('items');
        await bill.save();
      }

      await Order.deleteOne({ id: orderId });

      const allBills = await Bill.find();
      io.emit('order-dispatched', { id: orderId, mesa: order.mesa, mesero: order.mesero });
      io.emit('all-bills', Object.fromEntries(allBills.map(b => [b.mesa, b])));
    } catch(e) { console.error('dispatch-order error:', e); }
  });

  // ─ Close Account ─
  socket.on('close-account', async ({ mesa, paymentMethod }) => {
    try {
      const bill = await Bill.findOne({ mesa });
      if (!bill) return;

      const sale = await new Sale({
        mesa: bill.mesa, mesero: bill.mesero, items: bill.items,
        total: bill.total, paymentMethod,
        openedAt: bill.openedAt,
        closedAt: new Date().toLocaleTimeString('es-CO', {
          timeZone:'America/Bogota', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true
        })
      }).save();

      await Bill.deleteOne({ mesa });

      const [allBills, sales] = await Promise.all([
        Bill.find(),
        Sale.find({ timestamp: { $gte: todayStart() } })
      ]);

      io.emit('account-closed', { mesa, bill: sale });
      io.emit('all-bills', Object.fromEntries(allBills.map(b => [b.mesa, b])));
      io.emit('daily-sales-update', {
        total: sales.reduce((s,t) => s + t.total, 0),
        count: sales.length, date: dailyDate, transactions: sales
      });
    } catch(e) { console.error('close-account error:', e); }
  });

  // ─ Update Inventory ─
  socket.on('update-inventory', async (data) => {
    try {
      for (const [name, stock] of Object.entries(data)) {
        await Inventory.findOneAndUpdate({ itemName: name }, { stock }, { upsert: true, new: true });
      }
      const invDocs = await Inventory.find();
      const inv = {}; invDocs.forEach(d => { inv[d.itemName] = d.stock; });
      io.emit('all-inventory', inv);
    } catch(e) { console.error('update-inventory error:', e); }
  });

  // ─ Reset Daily ─
  socket.on('reset-daily', async () => {
    try {
      await Sale.deleteMany({ timestamp: { $gte: todayStart() } });
      io.emit('daily-sales-update', { total: 0, count: 0, date: dailyDate, transactions: [] });
    } catch(e) { console.error('reset-daily error:', e); }
  });

  socket.on('disconnect', () => console.log(`👋 Desconectado: ${socket.id}`));
});

// ── Start Server ──
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🍽️  LA RESERVA — Sistema de Comandas`);
  console.log(`🟢 http://localhost:${PORT}`);
  console.log(`📱 Mesero: http://localhost:${PORT}/mesero`);
  console.log(`🍳 Cocina: http://localhost:${PORT}/cocina`);
  console.log(`💰 Caja:   http://localhost:${PORT}/caja\n`);
});

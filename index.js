process.env.TZ = 'America/Bogota';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const ExcelJS = require('exceljs');
const fs = require('fs');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ── Database Connection ──
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/la-reserva';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('📁 Conectado a MongoDB'))
  .catch(err => console.error('❌ Error de conexión MongoDB:', err));

// ── Schemas ──
const OrderSchema = new mongoose.Schema({
  id: Number, mesa: Number, items: Array, mesero: String, hora: String, timestamp: Number
});
const BillSchema = new mongoose.Schema({
  mesa: Number, items: Array, total: Number, mesero: String, openedAt: String
});
const SaleSchema = new mongoose.Schema({
  mesa: Number, mesero: String, items: Array, total: Number, paymentMethod: String, openedAt: String, closedAt: String, timestamp: { type: Number, default: Date.now }
});
const InventorySchema = new mongoose.Schema({
  itemName: String, stock: Number
});
const ConfigSchema = new mongoose.Schema({ key: String, value: Object });

const Order = mongoose.model('Order', OrderSchema);
const Bill = mongoose.model('Bill', BillSchema);
const Sale = mongoose.model('Sale', SaleSchema);
const Inventory = mongoose.model('Inventory', InventorySchema);
const Config = mongoose.model('Config', ConfigSchema);

// ── Menu ──
let MENU = {
  'Bebidas': [ {n:'Coca-Cola', p:5000}, {n:'Coronita', p:8000}, {n:'Jugo Natural', p:7000}, {n:'Sprite', p:5000}, {n:'Agua Cristal', p:3000}, {n:'Club Colombia', p:7000}, {n:'Limonada', p:6000} ],
  'Licores': [ {n:'Aguardiente (Copa)', p:5000}, {n:'Aguardiente (Media)', p:45000}, {n:'Tequila (Trago)', p:15000}, {n:'Ron Viejo (Trago)', p:10000}, {n:'Whisky Old Parr', p:220000} ],
  'Comidas': [ {n:'Patacones', p:12000}, {n:'Filete Miñón', p:45000}, {n:'Hamburguesa', p:18000}, {n:'Alitas BBQ (x6)', p:16000}, {n:'Picada Mixta', p:35000}, {n:'Ceviche', p:28000} ]
};

async function initMenu() {
  const cfg = await Config.findOne({ key: 'menu' });
  if (cfg) MENU = cfg.value;
}

// Caja password
const CAJA_PASSWORD = '0707';

// ── Initialization (Global) ──
let dailyDate = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' });

// ── Routes ──
app.use(express.json());

app.get('/api/menu', (req, res) => res.json(MENU));
app.post('/api/menu', async (req, res) => {
  MENU = req.body;
  await Config.findOneAndUpdate({ key: 'menu' }, { value: MENU }, { upsert: true });
  io.emit('menu-updated', MENU);
  res.json({ ok: true });
});

// ── Excel Export ──
app.get('/api/export-daily', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' });
    const sales = await Sale.find({ timestamp: { $gte: new Date().setHours(0,0,0,0) } });
    
    const wb = new ExcelJS.Workbook();
    wb.creator = 'La Reserva';
    wb.created = new Date();

    const ws = wb.addWorksheet('Venta Diaria');
    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10b981' } };
    const headerFont = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
    const borderStyle = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

    ws.mergeCells('A1:G1');
    const titleCell = ws.getCell('A1');
    titleCell.value = 'LA RESERVA — Reporte de Venta Diaria';
    titleCell.font = { bold: true, size: 16, color: { argb: 'FF10b981' } };
    titleCell.alignment = { horizontal: 'center' };

    ws.mergeCells('A2:G2');
    const dateCell = ws.getCell('A2');
    dateCell.value = `Fecha: ${today}`;
    dateCell.alignment = { horizontal: 'center' };

    ws.addRow([]);
    ws.columns = [
      { key: 'num', width: 6 }, { key: 'mesa', width: 10 }, { key: 'mesero', width: 18 },
      { key: 'hora', width: 14 }, { key: 'productos', width: 42 }, { key: 'metodo', width: 16 }, { key: 'total', width: 16 }
    ];

    const headerRow = ws.addRow(['#', 'Mesa', 'Mesero', 'Hora Cierre', 'Productos', 'Método Pago', 'Total']);
    headerRow.eachCell(c => { c.fill = headerFill; c.font = headerFont; c.border = borderStyle; c.alignment = { horizontal: 'center' }; });

    sales.forEach((tx, idx) => {
      const productList = tx.items.map(it => `${it.name} x${it.qty}${it.note ? ' [' + it.note + ']' : ''} ($${(it.price * it.qty).toLocaleString()})`).join(', ');
      const row = ws.addRow([idx + 1, `Mesa ${tx.mesa}`, tx.mesero, tx.closedAt, productList, tx.paymentMethod, tx.total]);
      row.getCell('total').numFmt = '"$"#,##0';
      row.eachCell(c => { c.border = borderStyle; c.alignment = { vertical: 'middle', wrapText: true }; });
    });

    const totalDay = sales.reduce((s,t) => s + t.total, 0);
    ws.addRow([]);
    const totalRow = ws.addRow(['', '', '', '', '', 'TOTAL DÍA:', totalDay]);
    totalRow.getCell(7).numFmt = '"$"#,##0';
    totalRow.getCell(6).font = { bold: true };
    totalRow.getCell(7).font = { bold: true, color: { argb: 'FFfbbf24' } };

    const fileName = `Ventas_LaReserva_${today.replace(/\//g, '-')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error Excel:', err);
    res.status(500).json({ error: 'Error' });
  }
});

// ── Static files ──
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/mesero', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/cocina', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/caja', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Socket.io ──
io.on('connection', async (socket) => {
  console.log(`✅ Cliente conectado: ${socket.id}`);

  // Load state from DB
  const orders = await Order.find().sort({ timestamp: 1 });
  const bills = await Bill.find();
  const sales = await Sale.find({ 
    closedAt: { $exists: true },
    timestamp: { $gte: new Date().setHours(0,0,0,0) } 
  });
  const invDocs = await Inventory.find();
  const inventory = {}; invDocs.forEach(d => inventory[d.itemName] = d.stock);

  socket.emit('active-orders', orders);
  socket.emit('all-bills', Object.fromEntries(bills.map(b => [b.mesa, b])));
  socket.emit('daily-sales-update', { 
    total: sales.reduce((s,t) => s + t.total, 0), 
    count: sales.length, 
    date: dailyDate, 
    transactions: sales 
  });
  socket.emit('all-inventory', inventory);
  socket.emit('menu-updated', MENU);

  // Inventario manual update
  socket.on('update-inventory', async (data) => {
    for (const [name, stock] of Object.entries(data)) {
      await Inventory.findOneAndUpdate({ itemName: name }, { stock }, { upsert: true });
    }
    const allInv = await Inventory.find();
    const invMap = {}; allInv.forEach(d => invMap[d.itemName] = d.stock);
    io.emit('all-inventory', invMap);
  });

  socket.on('verify-caja-password', (pwd, callback) => callback(pwd === CAJA_PASSWORD));

  // Reset daily sales manually
  socket.on('reset-daily', async () => {
    await Sale.deleteMany({ timestamp: { $gte: new Date().setHours(0,0,0,0) } });
    io.emit('daily-sales-update', { total: 0, count: 0, date: dailyDate, transactions: [] });
    console.log('🔄 Venta diaria reiniciada en DB');
  });

  socket.on('new-order', async (data) => {
    const lastOrder = await Order.findOne().sort({ id: -1 });
    const nextId = (lastOrder ? lastOrder.id : 0) + 1;
    
    const order = new Order({
      id: nextId,
      mesa: data.mesa,
      items: data.items,
      mesero: data.mesero || 'Mesero',
      hora: new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
      timestamp: Date.now()
    });

    await order.save();

    // Update inventory
    for (const it of data.items) {
      await Inventory.findOneAndUpdate(
        { itemName: it.name }, 
        { $inc: { stock: -it.qty } }, 
        { upsert: true }
      );
    }

    // Update Bill
    let bill = await Bill.findOne({ mesa: data.mesa });
    if (!bill) {
      bill = new Bill({
        mesa: data.mesa,
        items: [],
        total: 0,
        mesero: data.mesero || 'Mesero',
        openedAt: new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: true })
      });
    }
    await bill.save();

    const allInvDocs = await Inventory.find();
    const invMap = {}; allInvDocs.forEach(d => invMap[d.itemName] = d.stock);

    io.emit('all-inventory', invMap);
    io.emit('order-received', order);
    const allBills = await Bill.find();
    io.emit('all-bills', Object.fromEntries(allBills.map(b => [b.mesa, b])));
  });

  socket.on('dispatch-order', async (orderId) => {
    const order = await Order.findOne({ id: orderId });
    if (order) {
      const bill = await Bill.findOne({ mesa: order.mesa });
      if (bill) {
        order.items.forEach(item => {
          const key = item.note ? `${item.name}_${item.note}` : item.name;
          const existing = bill.items.find(b => (b.note ? `${b.name}_${b.note}` : b.name) === key);
          if (existing) existing.qty += item.qty;
          else bill.items.push({ name: item.name, qty: item.qty, price: item.price, note: item.note || '' });
          bill.total += item.price * item.qty;
        });
        bill.markModified('items');
        await bill.save();
      }
      await Order.deleteOne({ id: orderId });
      io.emit('order-dispatched', { id: orderId, mesa: order.mesa, mesero: order.mesero });
      const allBills = await Bill.find();
      io.emit('all-bills', Object.fromEntries(allBills.map(b => [b.mesa, b])));
    }
  });

  socket.on('close-account', async (data) => {
    const { mesa, paymentMethod } = data;
    const bill = await Bill.findOne({ mesa });
    if (bill) {
      const transaction = new Sale({
        mesa: bill.mesa,
        mesero: bill.mesero,
        items: bill.items,
        total: bill.total,
        paymentMethod: paymentMethod,
        openedAt: bill.openedAt,
        closedAt: new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
      });
      await transaction.save();
      await Bill.deleteOne({ mesa });
      
      const sales = await Sale.find({ timestamp: { $gte: new Date().setHours(0,0,0,0) } });
      io.emit('account-closed', { mesa, bill: transaction });
      const allBills = await Bill.find();
      io.emit('all-bills', Object.fromEntries(allBills.map(b => [b.mesa, b])));
      io.emit('daily-sales-update', { 
        total: sales.reduce((s,t) => s + t.total, 0), 
        count: sales.length, 
        date: dailyDate, 
        transactions: sales 
      });
    }
  });

  socket.on('disconnect', () => console.log(`❌ Cliente desconectado: ${socket.id}`));
});

// Initialize menu from DB after connection
mongoose.connection.once('open', () => initMenu());

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🍽️  LA RESERVA — Sistema de Comandas`);
  console.log(`🟢 Servidor en http://localhost:${PORT}`);
  console.log(`📱 Mesero:  http://localhost:${PORT}/mesero`);
  console.log(`🖥️  Cocina:  http://localhost:${PORT}/cocina`);
  console.log(`💰 Caja:    http://localhost:${PORT}/caja\n`);
});

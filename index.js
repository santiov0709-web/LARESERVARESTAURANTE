process.env.TZ = 'America/Bogota';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const ExcelJS = require('exceljs');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ── Routes ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/mesero', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/cocina', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/caja', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── State ──
const activeOrders = new Map();
const tableBills = new Map();
let orderCounter = 0;
let inventory = {};

// Daily sales: array of closed transactions
let dailySales = [];
let dailyDate = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' });

// Caja password
const CAJA_PASSWORD = '0707';

function formatCOP(n) {
  return '$' + n.toLocaleString('es-CO');
}

function getDailyTotal() {
  return dailySales.reduce((sum, tx) => sum + tx.total, 0);
}

function resetDailyIfNewDay() {
  const today = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' });
  if (today !== dailyDate) {
    dailySales = [];
    dailyDate = today;
  }
}

// ── Excel Export ──
app.get('/api/export-daily', async (req, res) => {
  try {
    resetDailyIfNewDay();
    const wb = new ExcelJS.Workbook();
    wb.creator = 'La Reserva';
    wb.created = new Date();

    const ws = wb.addWorksheet('Venta Diaria');

    // Header styling
    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a3324' } };
    const headerFont = { bold: true, color: { argb: 'FFe8f0ec' }, size: 12 };
    const titleFont = { bold: true, color: { argb: 'FF2ecc71' }, size: 16 };
    const goldFont = { bold: true, color: { argb: 'FFf0c040' }, size: 13 };
    const borderStyle = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

    // Title
    ws.mergeCells('A1:G1');
    const titleCell = ws.getCell('A1');
    titleCell.value = 'LA RESERVA — Reporte de Venta Diaria';
    titleCell.font = titleFont;
    titleCell.alignment = { horizontal: 'center' };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0b140f' } };

    // Date
    ws.mergeCells('A2:G2');
    const dateCell = ws.getCell('A2');
    dateCell.value = `Fecha: ${dailyDate}`;
    dateCell.font = { bold: true, size: 11, color: { argb: 'FF8fa89a' } };
    dateCell.alignment = { horizontal: 'center' };
    dateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0b140f' } };

    ws.addRow([]); // spacing

    // Column headers
    ws.columns = [
      { key: 'num', width: 6 },
      { key: 'mesa', width: 10 },
      { key: 'mesero', width: 18 },
      { key: 'hora', width: 14 },
      { key: 'productos', width: 42 },
      { key: 'metodo', width: 16 },
      { key: 'total', width: 16 }
    ];

    const headerRow = ws.addRow(['#', 'Mesa', 'Mesero', 'Hora Cierre', 'Productos', 'Método Pago', 'Total']);
    headerRow.eachCell((cell) => {
      cell.fill = headerFill;
      cell.font = headerFont;
      cell.border = borderStyle;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    headerRow.height = 28;

    // Data rows
    dailySales.forEach((tx, idx) => {
      const productList = tx.items.map(it => `${it.name} x${it.qty}${it.note ? ' [' + it.note + ']' : ''} (${formatCOP(it.price * it.qty)})`).join(', ');
      const row = ws.addRow([
        idx + 1,
        `Mesa ${tx.mesa}`,
        tx.mesero || '—',
        tx.closedAt,
        productList,
        tx.paymentMethod || '—',
        tx.total
      ]);

      row.getCell('total').numFmt = '"$"#,##0';
      row.eachCell((cell) => {
        cell.border = borderStyle;
        cell.alignment = { vertical: 'middle', wrapText: true };
      });
      row.height = Math.max(22, Math.ceil(productList.length / 40) * 18);

      // Alternate row color
      if (idx % 2 === 0) {
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0f1e15' } };
        });
      }
    });

    // Total row
    ws.addRow([]);
    const totalRow = ws.addRow(['', '', '', '', '', 'TOTAL DÍA:', getDailyTotal()]);
    totalRow.getCell(6).font = goldFont;
    totalRow.getCell(7).font = goldFont;
    totalRow.getCell(7).numFmt = '"$"#,##0';
    totalRow.getCell(6).alignment = { horizontal: 'right' };

    // Payment method breakdown
    const methods = {};
    dailySales.forEach(tx => {
      const m = tx.paymentMethod || 'Sin método';
      methods[m] = (methods[m] || 0) + tx.total;
    });

    ws.addRow([]);
    const breakdownHeader = ws.addRow(['', '', '', '', '', 'Método', 'Total']);
    breakdownHeader.getCell(6).font = headerFont;
    breakdownHeader.getCell(6).fill = headerFill;
    breakdownHeader.getCell(7).font = headerFont;
    breakdownHeader.getCell(7).fill = headerFill;

    Object.entries(methods).forEach(([method, total]) => {
      const row = ws.addRow(['', '', '', '', '', method, total]);
      row.getCell(7).numFmt = '"$"#,##0';
    });

    // Generate file
    const fileName = `Ventas_LaReserva_${dailyDate.replace(/\//g, '-')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    await wb.xlsx.write(res);
    res.end();
    console.log(`📊 Excel exportado: ${fileName}`);
  } catch (err) {
    console.error('Error generando Excel:', err);
    res.status(500).json({ error: 'Error generando archivo' });
  }
});

// ── Socket.io ──
io.on('connection', (socket) => {
  console.log(`✅ Cliente conectado: ${socket.id}`);

  resetDailyIfNewDay();

  socket.emit('active-orders', Array.from(activeOrders.values()));
  socket.emit('all-bills', Object.fromEntries(tableBills));
  socket.emit('daily-sales-update', { total: getDailyTotal(), count: dailySales.length, date: dailyDate, transactions: dailySales });
  socket.emit('all-inventory', inventory);

  // Inventario manual update
  socket.on('update-inventory', (data) => {
    inventory = { ...inventory, ...data };
    io.emit('all-inventory', inventory);
  });

  // Verify caja password
  socket.on('verify-caja-password', (pwd, callback) => {
    callback(pwd === CAJA_PASSWORD);
  });

  // Reset daily sales manually
  socket.on('reset-daily', () => {
    dailySales = [];
    dailyDate = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' });
    io.emit('daily-sales-update', { total: 0, count: 0, date: dailyDate, transactions: [] });
    console.log('🔄 Venta diaria reiniciada manualmente');
  });

  // Waiter sends a new order
  socket.on('new-order', (data) => {
    orderCounter++;
    const order = {
      id: orderCounter,
      mesa: data.mesa,
      items: data.items,
      mesero: data.mesero || 'Mesero',
      hora: new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
      timestamp: Date.now()
    };

    activeOrders.set(order.id, order);

    data.items.forEach(it => {
      if (inventory[it.name] !== undefined) {
        inventory[it.name] -= it.qty;
        if (inventory[it.name] < 0) inventory[it.name] = 0;
      }
    });

    if (!tableBills.has(order.mesa)) {
      tableBills.set(order.mesa, {
        mesa: order.mesa,
        items: [],
        total: 0,
        mesero: data.mesero || 'Mesero',
        openedAt: new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: true })
      });
    }

    io.emit('all-inventory', inventory);
    io.emit('order-received', order);
    io.emit('all-bills', Object.fromEntries(tableBills));
    console.log(`📋 Pedido #${order.id} — Mesa ${order.mesa} (${data.mesero}): ${order.items.length} items`);
  });

  // Kitchen dispatches an order → items go to the bill
  socket.on('dispatch-order', (orderId) => {
    const order = activeOrders.get(orderId);
    if (order) {
      const bill = tableBills.get(order.mesa);
      if (bill) {
        order.items.forEach(item => {
          const key = item.note ? `${item.name}_${item.note}` : item.name;
          const existing = bill.items.find(b => (b.note ? `${b.name}_${b.note}` : b.name) === key);
          if (existing) existing.qty += item.qty;
          else bill.items.push({ name: item.name, qty: item.qty, price: item.price, note: item.note || '' });
          bill.total += item.price * item.qty;
        });
        tableBills.set(order.mesa, bill);
      }
    }
    activeOrders.delete(orderId);
    io.emit('order-dispatched', { id: orderId, mesa: order ? order.mesa : '?', mesero: order ? order.mesero : '' });
    io.emit('all-bills', Object.fromEntries(tableBills));
    console.log(`✔️  Pedido #${orderId} despachado`);
  });

  // Close account with payment method
  socket.on('close-account', (data) => {
    const { mesa, paymentMethod } = data;
    const bill = tableBills.get(mesa);
    if (bill) {
      const transaction = {
        mesa: bill.mesa,
        mesero: bill.mesero,
        items: [...bill.items],
        total: bill.total,
        paymentMethod: paymentMethod,
        openedAt: bill.openedAt,
        closedAt: new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
      };
      dailySales.push(transaction);
      console.log(`💰 Mesa ${mesa} cerrada — ${paymentMethod} — Total: ${formatCOP(bill.total)}`);
      tableBills.delete(mesa);
      io.emit('account-closed', { mesa, bill: transaction });
      io.emit('all-bills', Object.fromEntries(tableBills));
      io.emit('daily-sales-update', { total: getDailyTotal(), count: dailySales.length, date: dailyDate, transactions: dailySales });
    }
  });

  socket.on('disconnect', () => {
    console.log(`❌ Cliente desconectado: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🍽️  LA RESERVA — Sistema de Comandas`);
  console.log(`🟢 Servidor en http://localhost:${PORT}`);
  console.log(`📱 Mesero:  http://localhost:${PORT}/mesero`);
  console.log(`🖥️  Cocina:  http://localhost:${PORT}/cocina`);
  console.log(`💰 Caja:    http://localhost:${PORT}/caja\n`);
});

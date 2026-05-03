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
  app.get(r, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'index.html'));
  })
);

console.log('🚀 RESERVA POS v1.5 - CARGANDO...');

/* ══════════════════════════════════════════════
   IN-MEMORY STATE  (source of truth, always works)
   ══════════════════════════════════════════════ */
const activeOrders = new Map();   // id → order
const tableBills   = new Map();   // mesa → bill
let   dispatchedOrders = [];      // Cola de los últimos 20 pedidos despachados
let   orderCounter = 0;
let   inventory    = {};
let   dailySales   = [];
const waiterCredits = new Map(); // waiterName → { waiterName, totalDebt, items }
let MENU = {
  'ENTRADAS': [
    { n: 'Choricitos La Reserva', p: 25000 },
    { n: 'Tostadas de Ajo', p: 25000 },
    { n: 'Canastas de Plátano', p: 25000 }
  ],
  'RESERVA DE LA CASA': [
    { n: 'Pechuga Clasica', p: 48000 },
    { n: 'Pechuga Tropical', p: 48000 },
    { n: 'Cordon Blue', p: 48000 },
    { n: 'Filet Mignon', p: 62000 },
    { n: 'Stroganoff de Res', p: 62000 },
    { n: 'Solomito al Vino', p: 62000 },
    { n: 'Philadelphia Steak', p: 55000 },
    { n: 'Chuleta de Cerdo', p: 48000 },
    { n: 'Chuleta Apanada', p: 50000 },
    { n: 'Medallones de Cerdo', p: 48000 },
    { n: 'Sobrebarriga', p: 48000 }
  ],
  'PARRILLA': [
    { n: 'Picada La Reserva', p: 60000 },
    { n: 'Parrillada La Reserva', p: 60000 },
    { n: 'Punta de Anca', p: 53000 },
    { n: 'Churrasco', p: 53000 },
    { n: 'Costillas BBQ', p: 45000 },
    { n: 'Baby Beff', p: 55000 }
  ],
  'RESERVA DEL MAR': [
    { n: 'Cazuela de Mariscos', p: 53000 },
    { n: 'Salmon en Salsa de Queso', p: 55000 },
    { n: 'Ceviche o Coctel', p: 43000 },
    { n: 'Trucha Tres Quesos', p: 53000 },
    { n: 'Robalo a la Marinera', p: 55000 }
  ],
  'PASTAS': [
    { n: 'Carbonada', p: 50000 },
    { n: 'Bologñesa', p: 50000 },
    { n: 'En Camarón', p: 50000 },
    { n: 'Marinera', p: 50000 }
  ],
  'LIGERA RESERVA': [
    { n: 'Cajita Feliz', p: 37000 },
    { n: 'Hamburguesa', p: 35000 },
    { n: 'Creppe Mixto', p: 35000 },
    { n: 'Desgranado', p: 35000 },
    { n: 'Patacón', p: 35000 },
    { n: 'Papas Especiales', p: 35000 },
    { n: 'Papas Maxi', p: 45000 },
    { n: 'Árabe', p: 38000 },
    { n: 'Menú Pechuga', p: 35000 },
    { n: 'Menú Muslitos', p: 35000 },
    { n: 'Salchipapa', p: 35000 }
  ],
  'BEBIDAS': [
    { n: 'Agua Natural', p: 4000 },
    { n: 'Agua con Gas', p: 4000 },
    { n: 'Agua Manantial', p: 7000 },
    { n: 'Te Hatsu', p: 13000 },
    { n: 'Soda Hatsu', p: 10000 },
    { n: 'Jugos Naturales', p: 9000 },
    { n: 'Jugos en Leche', p: 10000 },
    { n: 'Limonada de Coco', p: 13000 },
    { n: 'Limonada Hierbabuena', p: 13000 },
    { n: 'Limonada Cereza', p: 13000 },
    { n: 'Sodas Saborizadas', p: 13000 },
    { n: 'Jugos Hit', p: 5000 },
    { n: 'Mister Tea', p: 5000 },
    { n: 'Coca-Cola', p: 5000 },
    { n: 'Tamarindo', p: 5000 },
    { n: 'Manzana', p: 5000 },
    { n: 'Colombiana', p: 5000 },
    { n: 'Granizado Mandarina', p: 9000 }
  ],
  'CERVEZAS': [
    { n: 'Corona', p: 12000 },
    { n: 'Stella Artois', p: 12000 },
    { n: 'Club Colombia', p: 10000 },
    { n: 'Águila Light', p: 7000 },
    { n: 'Poker', p: 7000 },
    { n: 'Pilsen', p: 7000 },
    { n: 'Águila', p: 7000 },
    { n: 'Reds', p: 7000 }
  ],
  'VINOS': [
    { n: 'Casillero del Diablo', p: 150000 },
    { n: 'Undurraga', p: 110000 },
    { n: 'Santa Rita 120', p: 110000 },
    { n: 'Frontera', p: 90000 },
    { n: 'Gato Negro', p: 90000 },
    { n: 'Lazo', p: 90000 }
  ],
  'APERITIVOS': [
    { n: 'Dubonnet', p: 120000 },
    { n: 'Manischewitz', p: 120000 },
    { n: 'Baileys', p: 120000 }
  ],
  'CHAMPAÑAS': [
    { n: 'Piterlongo', p: 220000 },
    { n: 'JP Chenet', p: 100000 },
    { n: 'Champaña Precidencial', p: 90000 }
  ],
  'LICORES (Botellas)': [
    { n: 'Buchanans', p: 190000 },
    { n: 'Chivas Regal', p: 110000 },
    { n: 'Old Parr', p: 110000 },
    { n: 'Sello Rojo', p: 95000 }
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
  if(today !== dailyDate){ 
    dailySales=[]; 
    dispatchedOrders=[]; // Reset monitor de despachados cada día
    dailyDate=today; 
  }
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
      Bill      = mongoose.model('Bill',      new mongoose.Schema({mesa:Number,items:{type:Array,default:[]},total:{type:Number,default:0},abono:{type:Number,default:0},mesero:String,openedAt:String}));
      Sale      = mongoose.model('Sale',      new mongoose.Schema({mesa:Number,mesero:String,items:Array,total:Number,paymentMethod:String,openedAt:String,closedAt:String,timestamp:{type:Number,default:Date.now}}));
      Inventory = mongoose.model('Inventory', new mongoose.Schema({itemName:{type:String,unique:true},stock:{type:Number,default:0}}));
      Config    = mongoose.model('Config',    new mongoose.Schema({key:{type:String,unique:true},value:Object}));
      WaiterCredit = mongoose.model('WaiterCredit', new mongoose.Schema({waiterName:{type:String,unique:true},totalDebt:{type:Number,default:0},items:Array}));

      const splitsForFix = await Sale.find({ "items.name": "Abono dividido (Retroactivo)" });
      for (const sp of splitsForFix) {
        const orig = await Sale.findOne({
          mesa: sp.mesa, openedAt: sp.openedAt, closedAt: sp.closedAt, _id: { $ne: sp._id }
        });
        if (orig && Math.abs(sp.timestamp - orig.timestamp) > 3600000) {
          sp.timestamp = orig.timestamp + 1500;
          await sp.save();
          console.log(`✅ AUTO-FIX: Venta dividida retroactiva de $${sp.total} regresada a su fecha original.`);
        }
      }

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
      // Cargar el menú de la base de datos (para preservar los que el admin agrega manualmente)
      if (cfgMenu && cfgMenu.value) {
        MENU = cfgMenu.value;
      } else {
        // Solo si la base de datos no tiene un menú, guardamos el base
        await Config.findOneAndUpdate({key:'menu'}, {value:MENU}, {upsert:true});
      }
      dailySales = sales.map(s => s.toObject());

      const wCredits = await WaiterCredit.find();
      wCredits.forEach(wc => waiterCredits.set(wc.waiterName, wc.toObject()));

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
    const dateQuery = req.query.date;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'La Reserva';

    let allSales = [];
    if (dbReady) {
      if (dateQuery) {
        const start = new Date(`${dateQuery}T00:00:00-05:00`).getTime();
        const end = start + 86400000;
        allSales = await Sale.find({timestamp: {$gte: start, $lt: end}}).sort({timestamp: 1});
      } else {
        allSales = await Sale.find().sort({timestamp: 1});
      }
    } else {
      resetDailyIfNewDay();
      if (dateQuery) {
        const parts = dateQuery.split('-');
        const reqDate = `${parts[2]}/${parts[1]}/${parts[0]}`;
        if (reqDate === dailyDate) allSales = dailySales;
      } else {
        allSales = dailySales;
      }
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
        
        ws.mergeCells('A1:C1');
        const t = ws.getCell('A1');
        t.value='LA RESERVA — REPORTE DE PRODUCTOS (POR DÍA)'; t.font={bold:true,color:{argb:'FFFFFFFF'},size:15}; t.alignment={horizontal:'center'};
        t.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1a3324'}};

        ws.mergeCells('A2:C2');
        const d = ws.getCell('A2');
        d.value=`Fecha de venta: ${dateStr.replace(/-/g,'/')}`; d.font={bold:true,size:11,color:{argb:'FF8fa89a'}}; d.alignment={horizontal:'center'};
        d.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF0b140f'}};

        ws.addRow([]);
        ws.columns=[{key:'producto',width:42},{key:'cantidad',width:22},{key:'total',width:22}];

        const hRow = ws.addRow(['Producto','Cantidad Vendida','Total Efectivo']);
        hRow.height = 28;
        hRow.eachCell(c=>{c.fill=hFill;c.font=hFont;c.border=bdr;c.alignment={horizontal:'center',vertical:'middle'};});

        let dayTotal = 0;
        const methods = {};
        const productTotals = {};

        sales.forEach(tx => {
          dayTotal += tx.total;
          const m = tx.paymentMethod || 'Sin método';
          methods[m] = (methods[m]||0) + tx.total;

          (tx.items || []).forEach(it => {
            const name = it.name;
            if (name.includes('Abono parcial') || name.includes('Abono dividido')) return;
            if (!productTotals[name]) {
               productTotals[name] = { qty: 0, total: 0 };
            }
            productTotals[name].qty += it.qty;
            productTotals[name].total += ((it.price || 0) * it.qty); // Calcula total del producto
          });
        });

        // Convertir en array y ordenar por cantidad vendida
        const productsArray = Object.entries(productTotals).sort((a,b) => b[1].qty - a[1].qty);

        productsArray.forEach(([name, data], i) => {
          const row = ws.addRow([name, data.qty, data.total]);
          row.getCell('total').numFmt='"$"#,##0';
          row.height = 22;
          row.eachCell(c=>{c.border=bdr;c.alignment={vertical:'middle'};});
          // Fondo gris para filas intercaladas
          if(i%2===0) row.eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF2F2F2'}};});
        });

        ws.addRow([]);
        const totRow = ws.addRow(['','TOTAL VENTAS DESGLOSADAS:',dayTotal]);
        totRow.getCell(2).font=gold; totRow.getCell(3).font=gold;
        totRow.getCell(3).numFmt='"$"#,##0'; totRow.getCell(2).alignment={horizontal:'right'};

        // Breakdown por método en esa hoja
        ws.addRow([]);
        const bh=ws.addRow(['','Método de Pago Ingresado','Total Recibido']);
        bh.getCell(2).font=hFont; bh.getCell(2).fill=hFill;
        bh.getCell(3).font=hFont; bh.getCell(3).fill=hFill;
        
        // Agregar cada método de pago ordenado
        Object.entries(methods)
          .sort((a,b) => b[1] - a[1]) // Mayor a menor
          .forEach(([m,t])=>{ 
             const r=ws.addRow(['',m,t]); 
             r.getCell(3).numFmt='"$"#,##0'; 
             r.getCell(2).border=bdr; r.getCell(3).border=bdr;
          });
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

app.get('/api/fix-retro', async (req, res) => {
  if (!dbReady) return res.send('<h3>DB no lista, espera o revisa logs.</h3>');
  try {
    let count = 0;
    let output = '<h2>Resultado de la Corrección:</h2>';
    const splits = await Sale.find({ "items.name": "Abono dividido (Retroactivo)" });
    
    for (const sp of splits) {
      const orig = await Sale.findOne({
        mesa: sp.mesa, openedAt: sp.openedAt, closedAt: sp.closedAt, _id: { $ne: sp._id }
      });
      if (orig && Math.abs(sp.timestamp - orig.timestamp) > 3600000) { // Mayor a 1h de diferencia real indica que saltó de día.
        sp.timestamp = orig.timestamp + 1500;
        await sp.save();
        output += `<p>✅ Venta dividida de $${sp.total} regresada con éxito al día: ${new Date(orig.timestamp).toLocaleDateString('es-CO')}.</p>`;
        count++;
      }
    }
    if (count === 0) output += '<p>No se encontraron cuentas fuera de su rango de tiempo (o ya fueron arregladas).</p>';
    res.send(output + '<br><button onclick="window.location.href=\'/caja\'" style="padding:10px 20px; font-size:16px;">Volver a Caja</button>');
  } catch (e) { res.send('<h3>Error:</h3> ' + e.message); }
});

/* ══════════════════════════════════════════════
   FILTRO DE COCINA
   Determina qué ítems deben ir a la pantalla de cocina.
   Las bebidas simples, licores, desechables y sumo de limón
   se añaden directo a la cuenta sin pasar por cocina.
   ══════════════════════════════════════════════ */

// Categorías cuyos ítems NUNCA van a cocina
const NON_KITCHEN_CATEGORIES = new Set([
  'CERVEZAS', 'VINOS', 'APERITIVOS', 'CHAMPAÑAS', 'LICORES (Botellas)'
]);

// Ítems específicos dentro de BEBIDAS que SÍ van a cocina (preparación requerida)
const BEBIDAS_TO_KITCHEN = new Set([
  'Jugos Naturales', 'Jugos en Leche',
  'Limonada de Coco', 'Limonada Hierbabuena', 'Limonada Cereza'
]);

// Ítems específicos de cualquier categoría que NUNCA van a cocina
const NON_KITCHEN_ITEMS = new Set([
  'Sumo de Limón', 'Desechable de Caja', 'Desechable Plástico'
]);

/**
 * Retorna true si el ítem debe ir a la cocina.
 * Busca en el menú actual para determinar la categoría del ítem.
 */
function isKitchenItem(itemName) {
  // Primero: si es un ítem explícitamente excluido, no va a cocina
  if (NON_KITCHEN_ITEMS.has(itemName)) return false;

  // Buscar en qué categoría del menú está este ítem
  for (const [cat, items] of Object.entries(MENU)) {
    if (items.some(i => i.n === itemName)) {
      // Si es de una categoría excluida, no va a cocina
      if (NON_KITCHEN_CATEGORIES.has(cat)) return false;
      // Si es de BEBIDAS, solo va a cocina si está en la lista permitida
      if (cat === 'BEBIDAS') return BEBIDAS_TO_KITCHEN.has(itemName);
      // Cualquier otra categoría (ENTRADAS, PARRILLA, PASTAS, etc.) sí va a cocina
      return true;
    }
  }

  // Si el ítem no está en el menú (adición manual), verificar por nombre
  // Si el nombre contiene palabras clave de bebidas/licores, excluir
  const lower = itemName.toLowerCase();
  if (lower.includes('desechable') || lower.includes('sumo de limón') || lower.includes('sumo de limon')) return false;
  // Por defecto: si no se reconoce, SÍ va a cocina (no perder pedidos de comida)
  return true;
}

/* ══════════════════════════════════════════════
   SOCKET.IO  — 100% in-memory, never blocked by DB
   ══════════════════════════════════════════════ */
io.on('connection', (socket) => {
  console.log(`🔌 Cliente: ${socket.id}`);
  // Normalización de emergencia: Asegurar que todas las mesas en memoria sean números
  // Esto arregla el bug de "13" (texto) vs 13 (número)
  for (let [k, v] of tableBills.entries()) {
    if (typeof k !== 'number') {
      const numK = Number(k);
      if (!isNaN(numK)) {
        console.log(`🔧 Normalizando Mesa ${k} -> ${numK}`);
        const existing = tableBills.get(numK);
        if (existing) {
          // Si ya existe el número, fusionar ítems
          existing.items = [...existing.items, ...v.items];
          existing.total += v.total;
          tableBills.set(numK, existing);
        } else {
          v.mesa = numK;
          tableBills.set(numK, v);
        }
        tableBills.delete(k);
      }
    }
  }

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
    const mesaId = Number(data.mesa);
    if (isNaN(mesaId)) return;

    // Separar ítems: cocina vs directo a cuenta
    const isSpecialOrder = data.isYaneth || data.isWaiterCredit;
    const kitchenItems = isSpecialOrder ? data.items : data.items.filter(it => isKitchenItem(it.name));
    const directItems  = isSpecialOrder ? [] : data.items.filter(it => !isKitchenItem(it.name));

    // Abrir cuenta si no existe
    if (!tableBills.has(mesaId)) {
      tableBills.set(mesaId, {
        mesa: mesaId, items: [], total: 0,
        mesero: data.mesero || 'Mesero',
        openedAt: new Date().toLocaleTimeString('es-CO',{timeZone:'America/Bogota',hour:'2-digit',minute:'2-digit',hour12:true})
      });
    }

    const bill = tableBills.get(mesaId);

    // Descontar inventario de TODOS los ítems
    data.items.forEach(it => {
      if (inventory[it.name] !== undefined) {
        inventory[it.name] = Math.max(0, inventory[it.name] - it.qty);
      }
    });

    // Agregar ítems directos a la cuenta SIN pasar por cocina
    if (directItems.length > 0 && bill) {
      directItems.forEach(item => {
        const key = item.note ? `${item.name}_${item.note}` : item.name;
        const ex  = bill.items.find(b => (b.note?`${b.name}_${b.note}`:b.name) === key);
        if (ex) ex.qty += item.qty;
        else bill.items.push({name:item.name, qty:item.qty, price:item.price, note:item.note||''});
        bill.total += item.price * item.qty;
      });
      tableBills.set(mesaId, bill);
      
      // CAPTURAR SNAPSHOT PARA PERSISTENCIA ASÍNCRONA
      const itemsToSave = [...bill.items];
      const totalToSave = bill.total;
      
      persist(async () => {
        await Bill.findOneAndUpdate({mesa:mesaId},{items:itemsToSave, total:totalToSave, mesero:bill.mesero},{upsert:true});
        for(const it of directItems){
          await Inventory.findOneAndUpdate({itemName:it.name},{stock:Math.max(0,(inventory[it.name]||0))},{upsert:true,new:true});
        }
      });
    }

    // Solo crear orden de cocina si hay ítems que requieren preparación
    if (kitchenItems.length > 0) {
      orderCounter++;
      const order = {
        id: orderCounter,
        mesa: mesaId,
        items: kitchenItems,
        allItems: data.items,
        mesero: data.mesero || 'Mesero',
        isYaneth: data.isYaneth || false,
        isWaiterCredit: data.isWaiterCredit || false,
        hora: new Date().toLocaleTimeString('es-CO',{timeZone:'America/Bogota',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}),
        timestamp: Date.now()
      };
      activeOrders.set(order.id, order);

      io.emit('order-received', order);

      // SNAPSHOT PARA SEGUNDA PERSISTENCIA
      const itemsToSaveK = bill ? [...bill.items] : [];
      const totalToSaveK = bill ? bill.total : 0;

      persist(async () => {
        const o = new Order(order); await o.save();
        await Bill.findOneAndUpdate({mesa:mesaId},{$setOnInsert:{mesa:mesaId,items:itemsToSaveK,total:totalToSaveK,mesero:order.mesero,openedAt:new Date().toLocaleTimeString('es-CO',{timeZone:'America/Bogota',hour:'2-digit',minute:'2-digit',hour12:true})}},{upsert:true,new:true});
        for(const it of kitchenItems){
          await Inventory.findOneAndUpdate({itemName:it.name},{stock:Math.max(0,(inventory[it.name]||0))},{upsert:true,new:true});
        }
      });
    }

    io.emit('all-bills',   Object.fromEntries(tableBills));
    io.emit('all-inventory', inventory);
  });

  /* ── Dispatch order → items go to bill ── */
  socket.on('dispatch-order', (orderId) => {
    const order = activeOrders.get(orderId);
    if (!order) return;

    if (order.isYaneth) {
      // Pedidos de Yaneth se cierran AUTOMÁTICAMENTE al despachar
      const finalTotal = order.items.reduce((s,it)=>s+(it.price*it.qty),0);
      const transaction = {
        mesa: 0, mesero: 'ADMIN (Yaneth)',
        items: [...order.items], total: finalTotal,
        paymentMethod: 'Crédito Yaneth', openedAt: order.hora,
        closedAt: new Date().toLocaleTimeString('es-CO',{timeZone:'America/Bogota',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}),
        timestamp: Date.now()
      };
      dailySales.push(transaction);
      activeOrders.delete(orderId);
      
      // Registrar en el monitor de despachados
      dispatchedOrders.unshift({ ...order, closedAt: transaction.closedAt });
      if (dispatchedOrders.length > 20) dispatchedOrders.pop();
      io.emit('all-dispatched-orders', dispatchedOrders);

      io.emit('order-dispatched', {id:orderId, mesa:'Yaneth', mesero:'Yaneth'});
      io.emit('daily-sales-update', {total:getDailyTotal(),count:dailySales.length,date:dailyDate,transactions:dailySales});
      console.log(`💎 Consumo Yaneth registrado — ${formatCOP(finalTotal)}`);
      persist(async () => {
        await Order.deleteOne({id:orderId});
        await new Sale(transaction).save();
      });
      return;
    }

    if (order.isWaiterCredit) {
      const finalTotal = order.items.reduce((s,it)=>s+(it.price*it.qty),0);
      const waiter = order.mesero;
      
      let wc = waiterCredits.get(waiter) || { waiterName: waiter, totalDebt: 0, items: [] };
      wc.totalDebt += finalTotal;
      order.items.forEach(it => {
        wc.items.push({ ...it, timestamp: Date.now() });
      });
      waiterCredits.set(waiter, wc);

      const transaction = {
        mesa: 0, mesero: `CRÉDITO: ${waiter}`,
        items: [...order.items], total: finalTotal,
        paymentMethod: 'Crédito Mesero', openedAt: order.hora,
        closedAt: new Date().toLocaleTimeString('es-CO',{timeZone:'America/Bogota',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}),
        timestamp: Date.now()
      };
      dailySales.push(transaction);
      activeOrders.delete(orderId);

      dispatchedOrders.unshift({ ...order, closedAt: transaction.closedAt });
      if (dispatchedOrders.length > 20) dispatchedOrders.pop();
      
      io.emit('all-dispatched-orders', dispatchedOrders);
      io.emit('order-dispatched', {id:orderId, mesa:'Crédito', mesero:waiter});
      io.emit('daily-sales-update', {total:getDailyTotal(),count:dailySales.length,date:dailyDate,transactions:dailySales});
      io.emit('all-waiter-credits', Object.fromEntries(waiterCredits));

      console.log(`👤 Crédito registrado para ${waiter} — ${formatCOP(finalTotal)}`);
      persist(async () => {
        await Order.deleteOne({id:orderId});
        await new Sale(transaction).save();
        await WaiterCredit.findOneAndUpdate({waiterName:waiter}, wc, {upsert:true});
      });
      return;
    }

    const mesaId = Number(order.mesa);
    const bill = tableBills.get(mesaId);
    if (bill) {
      order.items.forEach(item => {
        const key = item.note ? `${item.name}_${item.note}` : item.name;
        const ex  = bill.items.find(b => (b.note?`${b.name}_${b.note}`:b.name) === key);
        if (ex) ex.qty += item.qty;
        else bill.items.push({name:item.name,qty:item.qty,price:item.price,note:item.note||''});
        bill.total += item.price * item.qty;
      });
      tableBills.set(mesaId, bill);
    }

    activeOrders.delete(orderId);
    
    // Registrar en el monitor de despachados
    dispatchedOrders.unshift({ ...order, closedAt: new Date().toLocaleTimeString('es-CO',{timeZone:'America/Bogota',hour:'2-digit',minute:'2-digit',hour12:true}) });
    if (dispatchedOrders.length > 20) dispatchedOrders.pop();
    io.emit('all-dispatched-orders', dispatchedOrders);

    io.emit('order-dispatched', {id:orderId, mesa:mesaId, mesero:order.mesero});
    io.emit('all-bills', Object.fromEntries(tableBills));
    
    // SNAPSHOT PARA DESPACHO
    const itemsToSaveD = bill ? [...bill.items] : [];
    const totalToSaveD = bill ? bill.total : 0;

    persist(async () => {
      await Order.deleteOne({id:orderId});
      if(bill) await Bill.findOneAndUpdate({mesa:mesaId},{items:itemsToSaveD,total:totalToSaveD},{upsert:true});
    });
  });

  /* ── Remove dispatched order (Admin) ── */
  socket.on('remove-dispatched-order', (id) => {
    dispatchedOrders = dispatchedOrders.filter(o => o.id !== id);
    io.emit('all-dispatched-orders', dispatchedOrders);
    console.log(`🗑️ Pedido despachado #${id} eliminado del monitor`);
  });

  /* ── Cancel order (Admin) ── */
  socket.on('cancel-order', (orderId) => {
    const order = activeOrders.get(orderId);
    if (!order) return;

    // Restaurar inventario
    order.items.forEach(it => {
      if (inventory[it.name] !== undefined) {
        inventory[it.name] += it.qty;
      }
    });

    activeOrders.delete(orderId);
    io.emit('active-orders', Array.from(activeOrders.values()));
    io.emit('all-inventory', inventory);
    console.log(`❌ Pedido #${orderId} cancelado por admin`);

    persist(async () => {
      await Order.deleteOne({id:orderId});
      for(const it of order.items){
        await Inventory.findOneAndUpdate({itemName:it.name},{stock:inventory[it.name]},{upsert:true});
      }
    });
  });

  /* ── Split sale (Retroactive Admin) ── */
  socket.on('split-sale-retroactive', async ({timestamp, amount, newMethod}) => {
    amount = Number(amount);
    if (amount <= 0) return;

    if (dbReady) {
      const orig = await Sale.findOne({timestamp});
      if (!orig || amount >= orig.total) return;

      orig.total -= amount;
      const newSale = {
        mesa: orig.mesa, mesero: orig.mesero,
        items: [{ name: 'Abono dividido (Retroactivo)', qty: 1, price: amount }],
        total: amount, paymentMethod: newMethod,
        openedAt: orig.openedAt, closedAt: orig.closedAt,
        timestamp: orig.timestamp + 1000 + Math.floor(Math.random() * 500)
      };
      await orig.save();
      await new Sale(newSale).save();

      const idx = dailySales.findIndex(s => s.timestamp === timestamp);
      if (idx !== -1) {
        dailySales[idx].total -= amount;
        dailySales.push(newSale);
        io.emit('daily-sales-update', {total:getDailyTotal(),count:dailySales.length,date:dailyDate,transactions:dailySales});
      }
      console.log(`✂️ Venta histórica dividida: Extraídos ${formatCOP(amount)} a ${newMethod}`);
    } else {
      const idx = dailySales.findIndex(s => s.timestamp === timestamp);
      if (idx === -1) return;
      const orig = dailySales[idx];

      if (amount >= orig.total) return;
      orig.total -= amount;
      const newSale = {
        mesa: orig.mesa, mesero: orig.mesero,
        items: [{ name: 'Abono dividido (Retroactivo)', qty: 1, price: amount }],
        total: amount, paymentMethod: newMethod,
        openedAt: orig.openedAt, closedAt: orig.closedAt,
        timestamp: orig.timestamp + 1000 + Math.floor(Math.random() * 500)
      };
      dailySales.push(newSale);
      io.emit('daily-sales-update', {total:getDailyTotal(),count:dailySales.length,date:dailyDate,transactions:dailySales});
      console.log(`✂️ Venta dividida (RAM): Extraídos ${formatCOP(amount)} a ${newMethod}`);
    }
  });

  /* ── Edit sale method (Retroactive Admin) ── */
  socket.on('edit-sale-method', async ({timestamp, newMethod}) => {
    if (dbReady) {
      await Sale.findOneAndUpdate({timestamp}, {paymentMethod: newMethod});
      const idx = dailySales.findIndex(s => s.timestamp === timestamp);
      if (idx !== -1) {
        dailySales[idx].paymentMethod = newMethod;
        io.emit('daily-sales-update', {total:getDailyTotal(),count:dailySales.length,date:dailyDate,transactions:dailySales});
      }
      console.log(`✏️ Método de pago histórico editado a ${newMethod}`);
    } else {
      const idx = dailySales.findIndex(s => s.timestamp === timestamp);
      if (idx !== -1) {
        dailySales[idx].paymentMethod = newMethod;
        io.emit('daily-sales-update', {total:getDailyTotal(),count:dailySales.length,date:dailyDate,transactions:dailySales});
        console.log(`✏️ Método de pago editado a ${newMethod} en RAM`);
      }
    }
  });

  socket.on('get-all-waiter-credits', () => {
    socket.emit('all-waiter-credits', Object.fromEntries(waiterCredits));
  });

  socket.on('pay-waiter-credit', async ({waiterName, amount, method}) => {
    let wc = waiterCredits.get(waiterName);
    if (!wc) return;

    const payAmt = Math.min(amount, wc.totalDebt);
    wc.totalDebt -= payAmt;
    waiterCredits.set(waiterName, wc);

    const transaction = {
      mesa: 0, mesero: `PAGO CRÉDITO: ${waiterName}`,
      items: [{ name: `Pago Crédito Mesero (${waiterName})`, qty: 1, price: payAmt }],
      total: payAmt, paymentMethod: method,
      openedAt: '—',
      closedAt: new Date().toLocaleTimeString('es-CO',{timeZone:'America/Bogota',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}),
      timestamp: Date.now()
    };
    dailySales.push(transaction);
    
    io.emit('daily-sales-update', {total:getDailyTotal(),count:dailySales.length,date:dailyDate,transactions:dailySales});
    io.emit('all-waiter-credits', Object.fromEntries(waiterCredits));
    
    persist(async () => {
      await new Sale(transaction).save();
      await WaiterCredit.findOneAndUpdate({waiterName}, wc, {upsert:true});
    });
  });

  /* ── Remove item from bill (Admin) ── */
  socket.on('remove-item-bill', ({mesa, idx, qty}) => {
    mesa = Number(mesa);
    const bill = tableBills.get(mesa);
    if (!bill || !bill.items[idx]) return;

    const item = bill.items[idx];
    const removeQty = (qty && qty > 0 && qty < item.qty) ? qty : item.qty;

    bill.total -= (item.price * removeQty);

    if (removeQty < item.qty) {
      // Reducir cantidad parcialmente
      item.qty -= removeQty;
      tableBills.set(mesa, bill);
      console.log(`✂️ Mesa ${mesa}: -${removeQty}x ${item.name} (quedan ${item.qty})`);
    } else {
      // Eliminar ítem completo
      bill.items.splice(idx, 1);
      if (bill.items.length === 0 && (bill.abono || 0) <= 0) {
        tableBills.delete(mesa);
      } else {
        tableBills.set(mesa, bill);
      }
      console.log(`🗑️ Item eliminado de Mesa ${mesa}: ${item.name}`);
    }

    io.emit('all-bills', Object.fromEntries(tableBills));

    persist(async () => {
      if (!tableBills.has(mesa)) await Bill.deleteOne({mesa});
      else await Bill.findOneAndUpdate({mesa}, {items: bill.items, total: bill.total});
    });
  });

  /* ── Replace item in bill (Admin) ── */
  socket.on('replace-item-bill', ({mesa, idx, newName, newPrice}) => {
    mesa = Number(mesa);
    const bill = tableBills.get(mesa);
    if (!bill || !bill.items[idx]) return;

    const item = bill.items[idx];
    const oldCost = item.price * item.qty;
    const newCost  = newPrice   * item.qty;

    // Adjust total and replace item fields
    bill.total = bill.total - oldCost + newCost;
    const oldName = item.name;
    item.name  = newName;
    item.price = newPrice;
    // Keep qty and note unchanged

    tableBills.set(mesa, bill);
    io.emit('all-bills', Object.fromEntries(tableBills));
    console.log(`🔄 Mesa ${mesa}: "${oldName}" → "${newName}" (${bill.items[idx].qty}x)`);

    persist(async () => {
      await Bill.findOneAndUpdate({mesa}, {items: bill.items, total: bill.total});
    });
  });

  /* ── Close account ── */
  socket.on('close-account', ({mesa, paymentMethod}) => {
    const bill = tableBills.get(mesa);
    if (!bill) return;

    const finalTotal = Math.max(0, bill.total - (bill.abono || 0));
    const transaction = {
      mesa: bill.mesa, mesero: bill.mesero,
      items: [...bill.items], total: finalTotal,
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

  /* ── Manual amount payment ── */
  socket.on('manual-payment', ({mesa, amount, paymentMethod}) => {
    const bill = tableBills.get(mesa);
    if (!bill || amount <= 0) return;

    const newAbonoTotal = (bill.abono || 0) + amount;
    const isClosed = (newAbonoTotal >= bill.total);

    const transaction = {
      mesa: bill.mesa, mesero: bill.mesero,
      items: isClosed ? [...bill.items] : [{ name: 'Abono parcial', qty: 1, price: amount }],
      total: amount, paymentMethod, openedAt: bill.openedAt,
      closedAt: new Date().toLocaleTimeString('es-CO',{timeZone:'America/Bogota',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}),
      timestamp: Date.now()
    };
    dailySales.push(transaction);
    
    // Update abono
    bill.abono = newAbonoTotal;
    
    // Check if fully paid
    if (isClosed) {
      tableBills.delete(mesa);
      io.emit('account-closed', {mesa, bill:transaction});
    } else {
      tableBills.set(mesa, bill);
    }

    io.emit('all-bills', Object.fromEntries(tableBills));
    io.emit('daily-sales-update', {total:getDailyTotal(),count:dailySales.length,date:dailyDate,transactions:dailySales});

    persist(async () => {
      await new Sale(transaction).save();
      if (isClosed) await Bill.deleteOne({mesa});
      else await Bill.findOneAndUpdate({mesa}, {abono: bill.abono});
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
    dispatchedOrders = []; // También reiniciar monitor al reiniciar manual
    dailyDate = new Date().toLocaleDateString('es-CO',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'});
    io.emit('daily-sales-update', {total:0,count:0,date:dailyDate,transactions:[]});
    io.emit('all-dispatched-orders', dispatchedOrders);
    console.log('🔄 Venta diaria y monitor reiniciados manualmente en memoria');
  });

  /* ── Fetch Historical Sales ── */
  socket.on('fetch-historical-sales', async (dateStr) => {
    const parts = dateStr.split('-');
    if (parts.length !== 3) return;
    const reqDate = `${parts[2]}/${parts[1]}/${parts[0]}`;

    if (!dbReady) {
      if (reqDate === dailyDate) {
        socket.emit('historical-sales-result', {total:getDailyTotal(),count:dailySales.length,date:dailyDate,transactions:dailySales});
      } else {
        socket.emit('historical-sales-result', {total:0,count:0,date:reqDate,transactions:[]});
      }
      return;
    }
    try {
      const start = new Date(`${dateStr}T00:00:00-05:00`).getTime();
      const end = start + 86400000;
      const sales = await Sale.find({timestamp: {$gte: start, $lt: end}}).sort({timestamp: -1});
      const arr = sales.map(s => s.toObject());
      const total = arr.reduce((sum, s) => sum + s.total, 0);
      socket.emit('historical-sales-result', {total, count: arr.length, date: reqDate, transactions: arr});
    } catch(e) {}
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

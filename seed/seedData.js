const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const { connectDB, disconnectDB } = require('../config/db');
const User = require('../modules/auth/userModel');
const Business = require('../modules/auth/businessModel');
const Product = require('../modules/products/productModel');
const StockMovement = require('../modules/inventory/stockMovementModel');
const Sale = require('../modules/sales/saleModel');
const Purchase = require('../modules/purchases/purchaseModel');
const Expense = require('../modules/expenses/expenseModel');
const Customer = require('../modules/debts/customerModel');
const Debt = require('../modules/debts/debtModel');
const Alert = require('../modules/alerts/alertModel');
const AIAction = require('../modules/ai/aiActionModel');
const { generateProactiveAlerts } = require('../modules/alerts/alertService');

const seedDatabase = async () => {
  try {
    await connectDB();
    console.log('Seeding NaijaBiz AI Demo Dataset for Nigerian SME Provisions Shop...');

    // Clear existing data
    await User.deleteMany({});
    await Business.deleteMany({});
    await Product.deleteMany({});
    await StockMovement.deleteMany({});
    await Sale.deleteMany({});
    await Purchase.deleteMany({});
    await Expense.deleteMany({});
    await Customer.deleteMany({});
    await Debt.deleteMany({});
    await Alert.deleteMany({});
    await AIAction.deleteMany({});

    // 1. Create Demo Merchant User
    const merchantUser = await User.create({
      name: 'Alhaja Kudirat Balogun',
      phone: '08023456789',
      password: 'password123',
      preferredLanguage: 'en', // Can be 'yo', 'ha', 'ig'
    });

    // 2. Create Merchant Business
    const business = await Business.create({
      name: 'Kudirat & Sons Provisions Store',
      owner: merchantUser._id,
      category: 'Provisions & Foodstuff',
      currency: 'NGN',
      location: 'Bodija Market, Ibadan / Balogun Market, Lagos',
    });

    merchantUser.business = business._id;
    await merchantUser.save();

    console.log(`Merchant created: ${merchantUser.name} (${merchantUser.phone})`);

    // 3. Create Realistic Nigerian Provision Products
    const productsData = [
      {
        name: 'Mama Gold Rice 50kg',
        category: 'Foodstuff',
        unit: 'bag',
        costPrice: 78000,
        sellingPrice: 85000,
        currentStock: 18,
        minimumStock: 10,
      },
      {
        name: 'Golden Terra Vegetable Oil 25L',
        category: 'Cooking Essentials',
        unit: 'carton',
        costPrice: 45000,
        sellingPrice: 50000,
        currentStock: 8,
        minimumStock: 5,
      },
      {
        name: 'Indomie Super Pack Carton',
        category: 'Packaged Food',
        unit: 'carton',
        costPrice: 8200,
        sellingPrice: 9500,
        currentStock: 12,
        minimumStock: 15, // Currently below minimum stock!
      },
      {
        name: 'Peak Evaporated Milk (Roll of 12)',
        category: 'Dairy & Beverages',
        unit: 'roll',
        costPrice: 6500,
        sellingPrice: 7500,
        currentStock: 25,
        minimumStock: 10,
      },
      {
        name: 'Coca-Cola 50cl Bottle',
        category: 'Drinks & Beverages',
        unit: 'bottle',
        costPrice: 350,
        sellingPrice: 400,
        currentStock: 30,
        minimumStock: 48, // Low stock, and selling fast -> restock suggestion
      },
      {
        name: 'Dangote Sugar 50kg Bag',
        category: 'Foodstuff',
        unit: 'bag',
        costPrice: 72000,
        sellingPrice: 80000,
        currentStock: 0, // OUT OF STOCK!
        minimumStock: 4,
      },
    ];

    const createdProducts = await Product.insertMany(
      productsData.map((p) => ({ ...p, businessId: business._id }))
    );
    console.log(`Loaded ${createdProducts.length} products`);

    // 4. Opening stock movements are recorded in step 6b, once we know how much was sold,
    //    so that current stock = sum of stock movements for every product

    // 5. Create Realistic Customers (for credit sales & debt ledger)
    const customersData = [
      { name: 'Mama Chinedu', phone: '08031112233' },
      { name: 'Alhaji Ibrahim', phone: '08054445566' },
      { name: 'Brother Emeka', phone: '07067778899' },
      { name: 'Madam Bisi Caterer', phone: '08123334455' },
    ];

    const createdCustomers = await Customer.insertMany(
      customersData.map((c) => ({ ...c, businessId: business._id }))
    );
    console.log(`Loaded ${createdCustomers.length} customers`);

    // 6. Generate Past 3 Weeks of Realistic Sales
    const DAY_MS = 24 * 60 * 60 * 1000;
    const daysAgo = (days) => new Date(Date.now() - days * DAY_MS);

    const salesToInsert = [
      {
        businessId: business._id,
        date: daysAgo(16),
        items: [
          {
            productId: createdProducts[0]._id,
            productName: createdProducts[0].name,
            quantity: 2,
            unit: 'bag',
            unitPrice: 85000,
            costPrice: 78000,
            subtotal: 170000,
          },
        ],
        total: 170000,
        amountPaid: 170000,
        paymentStatus: 'paid',
        source: 'manual',
      },
      {
        businessId: business._id,
        date: daysAgo(14),
        items: [
          {
            productId: createdProducts[2]._id,
            productName: createdProducts[2].name,
            quantity: 5,
            unit: 'carton',
            unitPrice: 9500,
            costPrice: 8200,
            subtotal: 47500,
          },
        ],
        total: 47500,
        amountPaid: 47500,
        paymentStatus: 'paid',
        source: 'manual',
      },
      {
        businessId: business._id,
        date: daysAgo(12),
        customerId: createdCustomers[0]._id, // Mama Chinedu credit sale
        items: [
          {
            productId: createdProducts[1]._id,
            productName: createdProducts[1].name,
            quantity: 1,
            unit: 'carton',
            unitPrice: 50000,
            costPrice: 45000,
            subtotal: 50000,
          },
        ],
        total: 50000,
        amountPaid: 20000, // Partial paid
        paymentStatus: 'partial',
        notes: 'Mama Chinedu took oil on credit, paid 20k deposit',
        source: 'voice',
      },
      {
        businessId: business._id,
        date: daysAgo(8),
        customerId: createdCustomers[1]._id, // Alhaji Ibrahim credit sale
        items: [
          {
            productId: createdProducts[0]._id,
            productName: createdProducts[0].name,
            quantity: 1,
            unit: 'bag',
            unitPrice: 85000,
            costPrice: 78000,
            subtotal: 85000,
          },
        ],
        total: 85000,
        amountPaid: 0, // Unpaid
        paymentStatus: 'unpaid',
        notes: 'Alhaji took bag of rice on credit',
        source: 'manual',
      },
      {
        businessId: business._id,
        date: daysAgo(3),
        customerId: createdCustomers[2]._id, // Brother Emeka
        items: [
          {
            productId: createdProducts[3]._id,
            productName: createdProducts[3].name,
            quantity: 4,
            unit: 'roll',
            unitPrice: 7500,
            costPrice: 6500,
            subtotal: 30000,
          },
          {
            productId: createdProducts[4]._id,
            productName: createdProducts[4].name,
            quantity: 36,
            unit: 'bottle',
            unitPrice: 400,
            costPrice: 350,
            subtotal: 14400,
          },
        ],
        total: 44400,
        amountPaid: 24400,
        paymentStatus: 'partial',
        notes: 'Brother Emeka provisions for shop event',
        source: 'voice',
      },
      {
        businessId: business._id,
        date: new Date(), // Today's sale
        items: [
          {
            productId: createdProducts[4]._id,
            productName: createdProducts[4].name,
            quantity: 24,
            unit: 'bottle',
            unitPrice: 400,
            costPrice: 350,
            subtotal: 9600,
          },
        ],
        total: 9600,
        amountPaid: 9600,
        paymentStatus: 'paid',
        source: 'voice',
      },
    ];

    // 6a. Daily walk-in cash sales for the last 20 days. Deterministic (no randomness) so the demo
    //     is repeatable: busier on Fridays and Saturdays (weekend demand), and this week is slower
    //     than last week (sales-drop alert). Sugar sold out 10 days ago.
    const lagosDay = (daysBack) => new Date(Date.now() + 60 * 60 * 1000 - daysBack * DAY_MS).toISOString().slice(0, 10);
    const walkInPlan = [
      // [product index, units on a normal day, Friday, Saturday, last day sold (days ago) or 0]
      [0, 1, 2, 3, 0], // rice (bags)
      [2, 2, 3, 4, 0], // indomie (cartons)
      [4, 12, 18, 24, 0], // coke (bottles)
      [3, 1, 1, 2, 0], // peak milk (rolls)
      [1, 0, 0, 1, 0], // oil (cartons): Saturdays only
      [5, 0, 1, 1, 11], // sugar (bags): Fri/Sat until it ran out
    ];
    for (let back = 20; back >= 1; back--) {
      const day = lagosDay(back);
      const weekday = new Date(`${day}T12:00:00Z`).getUTCDay(); // 5 = Friday, 6 = Saturday
      const thisWeek = back <= 7;
      const items = [];
      for (const [index, normal, friday, saturday, lastSoldBack] of walkInPlan) {
        if (lastSoldBack && back < lastSoldBack) continue;
        const base = weekday === 6 ? saturday : weekday === 5 ? friday : normal;
        const units = thisWeek ? Math.floor(base / 2) : base;
        if (units <= 0) continue;
        const prod = createdProducts[index];
        items.push({
          productId: prod._id,
          productName: prod.name,
          quantity: units,
          unit: prod.unit,
          unitPrice: prod.sellingPrice,
          costPrice: prod.costPrice,
          subtotal: units * prod.sellingPrice,
        });
      }
      if (!items.length) continue;
      const total = items.reduce((sum, it) => sum + it.subtotal, 0);
      salesToInsert.push({
        businessId: business._id,
        date: new Date(`${day}T13:00:00+01:00`),
        items,
        total,
        amountPaid: total,
        paymentStatus: 'paid',
        notes: 'Walk-in customers',
        source: 'manual',
      });
    }

    const insertedSales = await Sale.insertMany(salesToInsert);
    console.log(`Loaded ${insertedSales.length} historical sales`);

    // 6b. Stock movements: one opening purchase 21 days ago (final stock + everything sold since),
    //     then a sale movement for every sale line, so stock = sum of movements and the
    //     sales rate / days-of-stock-left figures are real
    const soldByProduct = new Map();
    const saleMovements = [];
    for (const sale of insertedSales) {
      for (const item of sale.items) {
        const key = String(item.productId);
        soldByProduct.set(key, (soldByProduct.get(key) || 0) + item.quantity);
        saleMovements.push({
          businessId: business._id,
          productId: item.productId,
          type: 'sale',
          quantity: -item.quantity,
          unitCost: item.costPrice,
          note: 'Sale',
          referenceId: sale._id,
          date: sale.date,
        });
      }
    }
    const openingMovements = createdProducts
      .map((prod) => ({
        businessId: business._id,
        productId: prod._id,
        type: 'purchase',
        quantity: prod.currentStock + (soldByProduct.get(String(prod._id)) || 0),
        unitCost: prod.costPrice,
        note: 'Opening stock (3 weeks ago)',
        date: daysAgo(21),
      }))
      .filter((m) => m.quantity > 0);
    await StockMovement.insertMany([...openingMovements, ...saleMovements]);

    // 7. Create Debt Records for the Credit Sales
    // Mama Chinedu: ₦30,000 balance remaining, 12 days old
    await Debt.create({
      businessId: business._id,
      customerId: createdCustomers[0]._id,
      saleId: insertedSales[2]._id,
      amount: 50000,
      amountPaid: 20000,
      status: 'partial',
      createdDate: daysAgo(12),
      dueDate: daysAgo(-2), // 2 days in future
      notes: 'Balance on Golden Terra Oil',
    });

    // Alhaji Ibrahim: ₦85,000 unpaid, 8 days old
    await Debt.create({
      businessId: business._id,
      customerId: createdCustomers[1]._id,
      saleId: insertedSales[3]._id,
      amount: 85000,
      amountPaid: 0,
      status: 'unpaid',
      createdDate: daysAgo(8),
      dueDate: daysAgo(-6),
      notes: 'Mama Gold Rice bag taken on credit',
    });

    // Brother Emeka: ₦20,000 balance remaining, 3 days old
    await Debt.create({
      businessId: business._id,
      customerId: createdCustomers[2]._id,
      saleId: insertedSales[4]._id,
      amount: 45000,
      amountPaid: 25000,
      status: 'partial',
      createdDate: daysAgo(3),
      dueDate: daysAgo(-11),
      notes: 'Peak milk and Coke balance',
    });

    // Madam Bisi: ₦42,000 overdue from 35 days ago (Overdue >30 days for testing ageing!)
    await Debt.create({
      businessId: business._id,
      customerId: createdCustomers[3]._id,
      amount: 42000,
      amountPaid: 0,
      status: 'unpaid',
      createdDate: daysAgo(35),
      dueDate: daysAgo(21),
      notes: 'Catering items for wedding party',
    });

    console.log('Customer debt ledger initialized with realistic Nigerian debts');

    // 8. Create Realistic SME Operating Expenses
    const expensesData = [
      {
        businessId: business._id,
        category: 'rent',
        amount: 50000,
        note: 'Monthly shop lockup stall rent',
        date: daysAgo(25),
      },
      {
        businessId: business._id,
        category: 'transport',
        amount: 15000,
        note: 'Logistics and bus delivery from wholesale warehouse',
        date: daysAgo(15),
      },
      {
        businessId: business._id,
        category: 'power',
        amount: 12000,
        note: 'Generator fuel (PMS petrol) for drinks freezer',
        date: daysAgo(10),
      },
      {
        businessId: business._id,
        category: 'wages',
        amount: 25000,
        note: 'Monthly wage for shop assistant (Sunday boy)',
        date: daysAgo(5),
      },
      {
        businessId: business._id,
        category: 'power',
        amount: 8000,
        note: 'Fuel for generator',
        date: daysAgo(1),
      },
    ];

    await Expense.insertMany(expensesData);
    console.log(`Loaded ${expensesData.length} operating expenses`);

    // 9. Generate Proactive Alerts
    await generateProactiveAlerts(business._id);
    console.log('Proactive alerts generated from inventory and debt thresholds');

    // 10. Sample Completed AI Action in Audit Trail
    await AIAction.create({
      businessId: business._id,
      inputType: 'voice',
      rawInput: 'I just sold 24 bottles of Coke',
      language: 'en',
      transcript: 'I just sold 24 bottles of Coke',
      parsedJSON: {
        intent: 'record_sale',
        confidence: 0.96,
        entities: {
          product: 'Coca-Cola 50cl Bottle',
          quantity: 24,
          unit: 'bottle',
          totalAmount: 9600,
          paymentStatus: 'paid',
        },
        confirmationMessage: 'Record sale of 24 bottle(s) of Coca-Cola 50cl Bottle for ₦9,600?',
      },
      confidence: 0.96,
      status: 'confirmed',
      executedAt: new Date(),
      executionResult: {
        type: 'sale',
        saleId: insertedSales[5]._id,
        total: 9600,
      },
    });

    console.log('Seed completed successfully!');
    return {
      userId: merchantUser._id,
      businessId: business._id,
      userPhone: merchantUser.phone,
    };
  } catch (error) {
    console.error('Error seeding database:', error);
    throw error;
  }
};

// If run directly from terminal
if (require.main === module) {
  seedDatabase()
    .then(async () => {
      console.log('Seeding finished.');
      await disconnectDB();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err);
      await disconnectDB();
      process.exit(1);
    });
}

module.exports = seedDatabase;


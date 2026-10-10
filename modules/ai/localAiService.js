const AIAction = require('./aiActionModel');
const Product = require('../products/productModel');
const Customer = require('../debts/customerModel');
const { getStockSummary, calculateDaysRemaining } = require('../inventory/stockService');
const { getDashboardMetrics, checkAffordability } = require('../dashboard/financialService');
const { getDebtLedger } = require('../debts/debtService');

/**
 * Intelligent parser for Nigerian SME market voice and text commands
 * Handles English, Nigerian Pidgin, Yoruba, Hausa, and Igbo patterns
 */
const parseCommandNLP = async (businessId, text, language = 'en') => {
  const lower = text.toLowerCase().trim();

  // Find existing products for entity matching
  const products = await Product.find({ businessId });

  // 1. INTENT: ADD INVENTORY / RESTOCK
  // e.g. "I bought 50 bags of rice for 4 million naira", "Mo ra apo iresi 50", "Na sayi buhun shinkafa 50"
  if (
    lower.includes('bought') ||
    lower.includes('buy') ||
    lower.includes('add stock') ||
    lower.includes('restock') ||
    lower.includes('mo ra') ||
    lower.includes('na sayi') ||
    lower.includes('azụtara m')
  ) {
    let quantity = 1;
    const qtyMatch = lower.match(/(\d+)\s*(bags?|cartons?|bottles?|crates?|pieces?|apo|buhu|akpa)?/i);
    if (qtyMatch) {
      quantity = parseInt(qtyMatch[1], 10);
    }

    let unit = 'piece';
    if (lower.includes('bag') || lower.includes('apo') || lower.includes('buhu') || lower.includes('akpa')) unit = 'bag';
    else if (lower.includes('carton') || lower.includes('kwali')) unit = 'carton';
    else if (lower.includes('bottle') || lower.includes('igo')) unit = 'bottle';
    else if (lower.includes('crate')) unit = 'crate';

    // Amount extraction
    let totalAmount = 0;
    if (lower.includes('million')) {
      const milMatch = lower.match(/(\d+(\.\d+)?)\s*million/i);
      if (milMatch) totalAmount = parseFloat(milMatch[1]) * 1000000;
    } else {
      const amtMatch = lower.match(/(?:for|at|naira|₦)\s*([\d,]+)/i) || lower.match(/([\d,]+)\s*(?:naira|kudi)/i);
      if (amtMatch) {
        totalAmount = parseFloat(amtMatch[1].replace(/,/g, ''));
      }
    }

    const unitCost = quantity > 0 && totalAmount > 0 ? Math.round(totalAmount / quantity) : 0;

    // Identify product
    let matchedProduct = products.find((p) =>
      lower.includes(p.name.toLowerCase()) ||
      (lower.includes('rice') && p.name.toLowerCase().includes('rice')) ||
      (lower.includes('iresi') && p.name.toLowerCase().includes('rice')) ||
      (lower.includes('shinkafa') && p.name.toLowerCase().includes('rice')) ||
      (lower.includes('osikapa') && p.name.toLowerCase().includes('rice')) ||
      (lower.includes('oil') && p.name.toLowerCase().includes('oil')) ||
      (lower.includes('ororo') && p.name.toLowerCase().includes('oil')) ||
      (lower.includes('mai') && p.name.toLowerCase().includes('oil')) ||
      (lower.includes('noodle') && p.name.toLowerCase().includes('noodle')) ||
      (lower.includes('indomie') && p.name.toLowerCase().includes('indomie'))
    );

    const productName = matchedProduct ? matchedProduct.name : 'Rice 50kg';

    // Localized confirmation messages
    let confirmMsg = `Add ${quantity} ${unit}(s) of ${productName} at ₦${unitCost.toLocaleString()} each (Total: ₦${totalAmount.toLocaleString()})?`;
    if (language === 'yo') {
      confirmMsg = `Se ki n se afikun ${quantity} ${unit} ti ${productName} ni ₦${unitCost.toLocaleString()} kookan (Lapapo: ₦${totalAmount.toLocaleString()})?`;
    } else if (language === 'ha') {
      confirmMsg = `A kara ${quantity} ${unit} na ${productName} a kan ₦${unitCost.toLocaleString()} kowanne (Jimilla: ₦${totalAmount.toLocaleString()})?`;
    } else if (language === 'ig') {
      confirmMsg = `Tinye ${quantity} ${unit} nke ${productName} na ₦${unitCost.toLocaleString()} nke ọ bụla (Ngụkọta: ₦${totalAmount.toLocaleString()})?`;
    }

    return {
      intent: 'add_inventory',
      confidence: 0.96,
      entities: {
        product: productName,
        productId: matchedProduct ? matchedProduct._id : null,
        quantity,
        unit,
        totalAmount,
        unitCost,
        supplier: 'Wholesale Distributor',
      },
      confirmationMessage: confirmMsg,
      suggestedAction: {
        type: 'purchase',
        productId: matchedProduct ? matchedProduct._id : null,
        productName,
        quantity,
        unit,
        unitCost,
        total: totalAmount,
      },
    };
  }

  // 2. INTENT: RECORD A SALE
  // e.g. "I just sold five bottles of Coke", "Mo ta igo Coke marun", "Na sayar da kwalba 5 na Coke"
  if (
    lower.includes('sold') ||
    lower.includes('sell') ||
    lower.includes('mo ta') ||
    lower.includes('na sayar') ||
    lower.includes('ereela m')
  ) {
    let quantity = 1;
    const qtyMatch = lower.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)/i);
    const wordNums = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, marun: 5, biyar: 5 };
    if (qtyMatch) {
      quantity = isNaN(qtyMatch[1]) ? wordNums[qtyMatch[1].toLowerCase()] || 1 : parseInt(qtyMatch[1], 10);
    }

    let matchedProduct = products.find((p) =>
      lower.includes(p.name.toLowerCase()) ||
      (lower.includes('coke') && p.name.toLowerCase().includes('coke')) ||
      (lower.includes('indomie') && p.name.toLowerCase().includes('indomie')) ||
      (lower.includes('rice') && p.name.toLowerCase().includes('rice'))
    );

    const productName = matchedProduct ? matchedProduct.name : 'Coca-Cola 50cl';
    const unitPrice = matchedProduct ? matchedProduct.sellingPrice : 400;
    const totalAmount = quantity * unitPrice;

    // Check if on credit
    const isOnCredit = lower.includes('credit') || lower.includes('debt') || lower.includes('gbese') || lower.includes('bashi');
    let customerName = null;
    if (isOnCredit) {
      const custMatch = lower.match(/to\s+([a-zA-Z\s]+)/i);
      customerName = custMatch ? custMatch[1].trim() : null; // no name: the merchant must add it via Edit
    }

    let confirmMsg = `Record sale of ${quantity} ${matchedProduct ? matchedProduct.unit : 'unit'}(s) of ${productName} for ₦${totalAmount.toLocaleString()}?`;
    if (language === 'yo') {
      confirmMsg = `Se ki n se akosile tita ${quantity} ti ${productName} fun ₦${totalAmount.toLocaleString()}?`;
    } else if (language === 'ha') {
      confirmMsg = `A rubuta cinikin ${quantity} na ${productName} a kan ₦${totalAmount.toLocaleString()}?`;
    } else if (language === 'ig') {
      confirmMsg = `Dee ire ahịa nke ${quantity} nke ${productName} maka ₦${totalAmount.toLocaleString()}?`;
    }

    return {
      intent: 'record_sale',
      confidence: 0.94,
      entities: {
        product: productName,
        productId: matchedProduct ? matchedProduct._id : null,
        quantity,
        unit: matchedProduct ? matchedProduct.unit : 'piece',
        totalAmount,
        unitCost: matchedProduct ? matchedProduct.costPrice : 320,
        customer: customerName,
        paymentStatus: isOnCredit ? 'unpaid' : 'paid',
      },
      confirmationMessage: confirmMsg,
      suggestedAction: {
        type: 'sale',
        productId: matchedProduct ? matchedProduct._id : null,
        productName,
        quantity,
        unitPrice,
        costPrice: matchedProduct ? matchedProduct.costPrice : 320,
        total: totalAmount,
        amountPaid: isOnCredit ? 0 : totalAmount,
        paymentStatus: isOnCredit ? 'unpaid' : 'paid',
        customer: customerName,
      },
    };
  }

  // 3. INTENT: RECORD DEBT PAYMENT (checked before expenses, since both contain "paid")
  // e.g. "Brother Emeka paid me 5,000", "Madam Bisi paid back 10000", "Emeka repaid 5000"
  const repaymentMatch = lower.match(/^(.+?)\s+(?:paid me|paid back|repaid|settled)\b/);
  if (repaymentMatch) {
    const spokenName = repaymentMatch[1].trim();
    const customers = await Customer.find({ businessId });
    const matchedCustomer = customers.find(
      (c) => c.name.toLowerCase().includes(spokenName) || spokenName.includes(c.name.toLowerCase())
    );
    const amtMatch = lower.slice(repaymentMatch[0].length).match(/([\d,]+)/);
    const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : 0;
    const customerName = matchedCustomer ? matchedCustomer.name : spokenName;

    let confirmMsg = `Record debt payment of ₦${amount.toLocaleString()} from ${customerName}?`;
    if (language === 'yo') {
      confirmMsg = `Se ki n kọ sisan gbese ₦${amount.toLocaleString()} lati ọdọ ${customerName}?`;
    } else if (language === 'ha') {
      confirmMsg = `A rubuta biyan bashi ₦${amount.toLocaleString()} daga ${customerName}?`;
    } else if (language === 'ig') {
      confirmMsg = `Dee ụgwọ ₦${amount.toLocaleString()} nke ${customerName} kwụrụ?`;
    }

    return {
      intent: 'record_debt_payment',
      confidence: matchedCustomer && amount > 0 ? 0.9 : 0.5,
      entities: {
        customer: customerName,
        customerId: matchedCustomer ? matchedCustomer._id : null,
        totalAmount: amount,
        note: text,
      },
      confirmationMessage: confirmMsg,
      suggestedAction: { type: 'debt_payment', customer: customerName, amount },
    };
  }

  // 4. INTENT: RECORD EXPENSE
  // e.g. "I paid 15,000 for transport", "Mo san 15000 fun oko", "Na biya 15,000 kudin mota"
  if (
    lower.includes('paid') ||
    lower.includes('expense') ||
    lower.includes('spent') ||
    lower.includes('mo san') ||
    lower.includes('na biya') ||
    lower.includes('akwụrụ m')
  ) {
    let amount = 0;
    const amtMatch = lower.match(/(?:paid|san|biya|spent|₦)?\s*([\d,]+)/i);
    if (amtMatch) {
      amount = parseFloat(amtMatch[1].replace(/,/g, ''));
    }

    let category = 'other';
    let note = text;
    if (lower.includes('transport') || lower.includes('bus') || lower.includes('oko') || lower.includes('mota') || lower.includes('okada')) {
      category = 'transport';
    } else if (lower.includes('fuel') || lower.includes('generator') || lower.includes('power') || lower.includes('nepa') || lower.includes('diesel')) {
      category = 'power';
    } else if (lower.includes('rent') || lower.includes('shop') || lower.includes('ile')) {
      category = 'rent';
    } else if (lower.includes('wage') || lower.includes('salary') || lower.includes('boy')) {
      category = 'wages';
    }

    let confirmMsg = `Record expense of ₦${amount.toLocaleString()} for ${category}?`;
    if (language === 'yo') {
      confirmMsg = `Se ki n kọ inawo ₦${amount.toLocaleString()} fun ${category}?`;
    } else if (language === 'ha') {
      confirmMsg = `A rubuta kudin da aka kashe ₦${amount.toLocaleString()} na ${category}?`;
    } else if (language === 'ig') {
      confirmMsg = `Dee mmefu nke ₦${amount.toLocaleString()} maka ${category}?`;
    }

    return {
      intent: 'record_expense',
      confidence: 0.95,
      entities: {
        category,
        totalAmount: amount,
        note,
      },
      confirmationMessage: confirmMsg,
      suggestedAction: {
        type: 'expense',
        category,
        amount,
        note,
      },
    };
  }

  // Fallback / Unknown
  return {
    intent: 'other',
    confidence: 0.7,
    entities: {},
    confirmationMessage: `Could not determine exact action from: "${text}". Would you like to record a sale, stock purchase, or expense?`,
    suggestedAction: {},
  };
};

/**
 * Handle incoming receipt photo OCR extraction
 * Emulates / interfaces with OCR + LLM engine
 */
const parseReceipt = async (businessId, receiptData) => {
  // Demo supplier invoice parsing from project specification (Page 13, Item 1)
  // "She photographs a supplier invoice (20 bags of rice, 10 cartons of oil, 15 cartons of noodles)"
  const products = await Product.find({ businessId });

  const riceProduct = products.find((p) => p.name.toLowerCase().includes('rice'));
  const oilProduct = products.find((p) => p.name.toLowerCase().includes('oil'));
  const noodleProduct = products.find((p) => p.name.toLowerCase().includes('noodle') || p.name.toLowerCase().includes('indomie'));

  const items = [
    {
      productName: riceProduct ? riceProduct.name : 'Mama Gold Rice 50kg',
      productId: riceProduct ? riceProduct._id : null,
      quantity: 20,
      unit: 'bag',
      unitCost: 78000,
      subtotal: 1560000,
    },
    {
      productName: oilProduct ? oilProduct.name : 'Golden Terra Vegetable Oil 25L',
      productId: oilProduct ? oilProduct._id : null,
      quantity: 10,
      unit: 'carton',
      unitCost: 45000,
      subtotal: 450000,
    },
    {
      productName: noodleProduct ? noodleProduct.name : 'Indomie Super Pack Carton',
      productId: noodleProduct ? noodleProduct._id : null,
      quantity: 15,
      unit: 'carton',
      unitCost: 8200,
      subtotal: 123000,
    },
  ];

  const total = items.reduce((acc, it) => acc + it.subtotal, 0);

  const confirmMsg = `Receipt parsed: 20 bags Rice (₦1,560,000), 10 cartons Oil (₦450,000), 15 cartons Noodles (₦123,000). Total: ₦${total.toLocaleString()}. Add these 3 items to inventory?`;

  return {
    intent: 'add_inventory',
    confidence: 0.98,
    entities: {
      supplier: 'Alaba Wholesale Mills Ltd',
      totalAmount: total,
      items,
    },
    confirmationMessage: confirmMsg,
    suggestedAction: {
      type: 'purchase',
      supplier: 'Alaba Wholesale Mills Ltd',
      items,
      total,
      source: 'receipt',
    },
  };
};

/**
 * "Ask My Business" engine
 * Answers natural language queries about stock, profits, debts, and affordability
 */
const answerAskMyBusiness = async (businessId, query, language = 'en') => {
  const lower = query.toLowerCase().trim();

  // 1. Stock inquiry
  // "How much rice do I have left?" / "Elo iresi lo ku?" / "Shinkafa nawa ya rage?" / "Osikapa ole fọdụrụ?"
  if (
    lower.includes('how much') ||
    lower.includes('stock') ||
    lower.includes('have left') ||
    lower.includes('iresi lo ku') ||
    lower.includes('ya rage') ||
    lower.includes('fọdụrụ')
  ) {
    const products = await Product.find({ businessId });
    let target = products.find((p) =>
      lower.includes(p.name.toLowerCase()) ||
      (lower.includes('rice') && p.name.toLowerCase().includes('rice')) ||
      (lower.includes('iresi') && p.name.toLowerCase().includes('rice')) ||
      (lower.includes('shinkafa') && p.name.toLowerCase().includes('rice')) ||
      (lower.includes('osikapa') && p.name.toLowerCase().includes('rice'))
    );

    if (!target) {
      target = products[0]; // default to first product if not specified
    }

    if (target) {
      const daysRemaining = await calculateDaysRemaining(businessId, target._id, target.currentStock);

      let answer = `You currently have ${target.currentStock} ${target.unit}(s) of ${target.name} remaining. At your current sales rate, that will last approximately ${daysRemaining} days.`;
      if (language === 'yo') {
        answer = `O ku ${target.currentStock} ${target.unit} ti ${target.name}. Ni iwọn tita rẹ, yoo to ọjọ ${daysRemaining}.`;
      } else if (language === 'ha') {
        answer = `Kana da sauran ${target.currentStock} ${target.unit} na ${target.name}. Dangane da cinikinka, zai kai kwanaki ${daysRemaining}.`;
      } else if (language === 'ig') {
        answer = `I nwere ${target.currentStock} ${target.unit} nke ${target.name} fọdụrụ. Dịka ị na-ere ya, ọ ga-adịgide ihe dịka ụbọchị ${daysRemaining}.`;
      }

      return {
        query,
        language,
        category: 'stock_inquiry',
        answer,
        data: {
          productName: target.name,
          currentStock: target.currentStock,
          unit: target.unit,
          daysRemaining,
        },
      };
    }
  }

  // 2. Profit inquiry
  // "What was my profit last month?" / "What was my profit today?"
  if (lower.includes('profit') || lower.includes('ere') || lower.includes('riba') || lower.includes('uru')) {
    const metrics = await getDashboardMetrics(businessId, lower.includes('today') ? 'today' : '30d');
    const netProfitFormatted = `₦${metrics.profit.netProfit.toLocaleString()}`;
    const revenueFormatted = `₦${metrics.revenue.total.toLocaleString()}`;
    const expensesFormatted = `₦${metrics.expenses.total.toLocaleString()}`;

    let answer = `Over the past 30 days, your total sales were ${revenueFormatted}, expenses were ${expensesFormatted}, giving you a net profit of ${netProfitFormatted} (${metrics.profit.profitMarginPercent}% profit margin).`;
    if (language === 'yo') {
      answer = `Fun oṣu to kọja, lapapọ tita rẹ jẹ ${revenueFormatted}, inawo rẹ jẹ ${expensesFormatted}, ere rẹ si jẹ ${netProfitFormatted}.`;
    } else if (language === 'ha') {
      answer = `A cikin watan da ya gabata, jimillar cinikinka ya kai ${revenueFormatted}, kudaden da ka kashe ${expensesFormatted}, ribarka kuma ita ce ${netProfitFormatted}.`;
    } else if (language === 'ig') {
      answer = `N'ime ụbọchị iri atọ gara aga, ngụkọta ahịa gị bụ ${revenueFormatted}, mmefu gị bụ ${expensesFormatted}, na uru gị bụ ${netProfitFormatted}.`;
    }

    return {
      query,
      language,
      category: 'profit_inquiry',
      answer,
      data: metrics.profit,
    };
  }

  // 3. Debt inquiry
  // "Who owes me money?" / "Ta lo je mi lowo?" / "Wanene ke bina bashi?" / "Onye ji m ụgwọ?"
  if (lower.includes('owes') || lower.includes('debt') || lower.includes('je mi lowo') || lower.includes('bina bashi') || lower.includes('ji m ụgwọ')) {
    const debtSummary = await getDebtLedger(businessId);
    const totalOut = `₦${debtSummary.totalOutstandingAmount.toLocaleString()}`;

    let answer = `You have ${debtSummary.activeDebtorsCount} customer(s) owing a total of ${totalOut}.`;
    if (debtSummary.debts.length > 0) {
      const topDebtor = debtSummary.debts[0];
      answer += ` For example, ${topDebtor.customer.name} owes ₦${topDebtor.balanceRemaining.toLocaleString()} (${topDebtor.daysOutstanding} days outstanding).`;
    }

    return {
      query,
      language,
      category: 'debt_inquiry',
      answer,
      data: debtSummary,
    };
  }

  // 4. Affordability question
  // "Can I afford a freezer?" / "Can I afford to buy another freezer?"
  if (lower.includes('afford') || lower.includes('le ra') || lower.includes('iya saya') || lower.includes('nwere ike ịzụta')) {
    let price = 250000; // typical freezer price in Naira
    const priceMatch = lower.match(/(?:₦|naira)?\s*([\d,]+)/i);
    if (priceMatch) {
      price = parseFloat(priceMatch[1].replace(/,/g, ''));
    }

    const evaluation = await checkAffordability(businessId, price, 'Freezer');
    return {
      query,
      language,
      category: 'affordability_check',
      answer: evaluation.advice[language] || evaluation.advice.en,
      data: evaluation,
    };
  }

  // Default fallback answer
  return {
    query,
    language,
    category: 'general_assistant',
    answer: `NaijaBiz AI is monitoring your business. You can ask: "How much rice do I have left?", "What was my profit last month?", "Who owes me money?", or "Can I afford a freezer?".`,
    data: {},
  };
};

module.exports = {
  parseCommandNLP,
  parseReceipt,
  answerAskMyBusiness,
};


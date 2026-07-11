// ============================================================================
// CHECKOUT INTEGRATION
//
// This file bridges your EXISTING checkout form (in burger_king_ghana_v11.html)
// to the new Supabase backend. It does not change your design, layout, cart
// logic, or checkout steps — it only replaces what happens when the customer
// presses the final "Place Order" / "Confirm Order" button: instead of faking
// a reference number in the browser, it now calls the place-order Edge
// Function, saves everything for real, and shows your existing confirmation
// modal populated with the real saved order.
//
// HOW TO INSTALL THIS:
//   1. Fill in checkout-config.js with your Supabase project URL + anon key.
//   2. Add these two lines just before </body> in your main site HTML,
//      after the existing <script>...</script> block:
//        <script src="checkout-config.js"></script>
//        <script src="checkout-integration.js"></script>
//   3. That's it — this file finds and overrides the existing placeOrder()
//      function automatically once the page loads.
// ============================================================================

(function () {
  if (typeof window.CHECKOUT_SUPABASE_CONFIG === "undefined") {
    console.error("checkout-config.js not loaded — backend integration disabled.");
    return;
  }
  if (
    window.CHECKOUT_SUPABASE_CONFIG.url === "YOUR_SUPABASE_PROJECT_URL" ||
    window.CHECKOUT_SUPABASE_CONFIG.anonKey === "YOUR_SUPABASE_ANON_KEY" ||
    !window.CHECKOUT_SUPABASE_CONFIG.url ||
    !window.CHECKOUT_SUPABASE_CONFIG.anonKey
  ) {
    console.warn(
      "checkout-config.js still has placeholder values — backend integration disabled until you fill in your real Supabase URL and anon key. The site's checkout will continue to work without saving orders to a database. See docs/SETUP.md."
    );
    return;
  }

  const FN_BASE = window.CHECKOUT_SUPABASE_CONFIG.url.replace(/\/$/, "") + "/functions/v1";
  const ANON_KEY = window.CHECKOUT_SUPABASE_CONFIG.anonKey;

  // A stable idempotency key per checkout attempt — generated once when the
  // checkout modal opens, so if "Place Order" is pressed twice (e.g. a
  // double-click, or a retry after a slow network), the backend recognises
  // the second submission as the same order instead of creating a duplicate.
  let currentIdempotencyKey = null;

  function newIdempotencyKey() {
    currentIdempotencyKey =
      "web-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
    return currentIdempotencyKey;
  }

  // Maps the exact <option> text used in the existing checkout form's
  // dropdowns to the backend's enum values. If the option text in your
  // site ever changes, update the matching key here.
  const DELIVERY_METHOD_MAP = {
    "Delivery": "delivery",
    "Pick-Up": "pickup",
  };
  const PAYMENT_METHOD_MAP = {
    "MTN MoMo": "mtn_momo",
    "Vodafone Cash": "vodafone_cash",
    "AirtelTigo Money": "airteltigo_money",
    "GhIPSS Instant Pay": "ghipss",
    "Visa / Mastercard": "card",
    "Bank Transfer": "bank_transfer",
    "Cash on Delivery": "cash_on_delivery",
  };

  // ---- Read the existing cart / form fields exactly as your site already
  // ---- stores them. This reads from the same global `cart` array and the
  // ---- same input/select IDs your checkout form already uses (coN, coP,
  // ---- coE, coT, coA, coNote, coPay, coMomo).
  function collectOrderPayload() {
    const deliverySelectText = document.getElementById("coT")?.value || "Delivery";
    const paymentSelectText = document.getElementById("coPay")?.value || "Cash on Delivery";

    const deliveryMethod = DELIVERY_METHOD_MAP[deliverySelectText] || "pickup";
    const paymentMethod = PAYMENT_METHOD_MAP[paymentSelectText] || "cash_on_delivery";

    // NOTE: `cart` and `menuItems` are declared with `const`/`let` at the
    // top level of the main site's inline <script>. Top-level let/const in
    // a classic script do NOT become window properties, but they ARE
    // visible as bare identifiers to any script that runs later in the
    // same document (this file is loaded after that script) — so we
    // reference them directly, not via `window.cart`.
    const cartItems = typeof cart !== "undefined" ? cart : [];
    const items = cartItems.map((item) => {
      const menuList = typeof menuItems !== "undefined" ? menuItems : [];
      const menuEntry = menuList.find((m) => m.id === item.id);
      return {
        name: item.name,
        category: menuEntry ? menuEntry.cat : null,
        quantity: item.qty || item.quantity || 1,
        unitPrice: Number(item.price) || 0,
      };
    });

    return {
      idempotencyKey: currentIdempotencyKey,
      customerName: (document.getElementById("coN")?.value || "").trim(),
      phoneNumber: (document.getElementById("coP")?.value || "").trim(),
      email: (document.getElementById("coE")?.value || "").trim() || null,
      deliveryMethod,
      deliveryAddress: (document.getElementById("coA")?.value || "").trim() || null,
      googleMapsLocation: null,
      paymentMethod,
      paymentMethodLabel: paymentSelectText,
      mobileMoneyNumber: (document.getElementById("coMomo")?.value || "").trim() || null,
      specialInstructions: (document.getElementById("coNote")?.value || "").trim() || null,
      // Your current checkout doesn't charge a separate delivery fee, tax,
      // or discount today, so these correctly default to 0 — this is a
      // hook for later, not a bug. If you add a delivery fee calculation
      // to your site in future, set window.bkDeliveryFee/Discount/Tax
      // before placeOrder() runs and they'll flow through automatically.
      deliveryFee: typeof window.bkDeliveryFee === "number" ? window.bkDeliveryFee : 0,
      discount: typeof window.bkDiscount === "number" ? window.bkDiscount : 0,
      tax: typeof window.bkTax === "number" ? window.bkTax : 0,
      items,
    };
  }

  function validateBeforeSend(payload) {
    const problems = [];
    if (!payload.customerName) problems.push("Please enter your full name.");
    if (!payload.phoneNumber) problems.push("Please enter your phone number.");
    if (payload.deliveryMethod === "delivery" && !payload.deliveryAddress) {
      problems.push("Please enter a delivery address.");
    }
    if (!payload.items.length) problems.push("Your cart is empty.");
    return problems;
  }

  async function submitOrderToBackend() {
    const payload = collectOrderPayload();
    const problems = validateBeforeSend(payload);
    if (problems.length) {
      if (typeof showToast === "function") showToast(problems[0]);
      else alert(problems[0]);
      return null;
    }

    const placeBtn = document.getElementById("placeOrderBtn");
    if (placeBtn) {
      placeBtn.disabled = true;
      placeBtn.dataset.originalText = placeBtn.textContent;
      placeBtn.textContent = "Placing your order…";
    }

    try {
      const res = await fetch(`${FN_BASE}/place-order`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: ANON_KEY,
          Authorization: `Bearer ${ANON_KEY}`,
        },
        body: JSON.stringify(payload),
      });
      const json = await res.json();

      if (!json.success) {
        const msg =
          (json.details && json.details[0]) || json.error || "Could not place your order. Please try again.";
        if (typeof showToast === "function") showToast(msg);
        else alert(msg);
        return null;
      }

      // Successful order: clear the idempotency key so the NEXT order (a
      // genuinely new one) gets its own fresh key rather than reusing this one.
      currentIdempotencyKey = null;
      return json.order;
    } catch (err) {
      console.error("place-order request failed:", err);
      const msg = "Network error — please check your connection and try again.";
      if (typeof showToast === "function") showToast(msg);
      else alert(msg);
      return null;
    } finally {
      if (placeBtn) {
        placeBtn.disabled = false;
        placeBtn.textContent = placeBtn.dataset.originalText || "Place Order";
      }
    }
  }

  // ---- Populate the EXISTING confirmation modal with the real saved order.
  // The original modal only had two dynamic pieces (#oRef and #oLines) and
  // showed a generic "25-35 minutes" estimate. We keep both of those working
  // exactly as before, and add the richer order summary + action buttons
  // into a new #oDetails container (added alongside oRef/oLines — see the
  // confirmModal markup in the main HTML file).
  function populateConfirmModal(order) {
    const refEl = document.getElementById("oRef");
    if (refEl) refEl.textContent = order.order_reference;

    const linesEl = document.getElementById("oLines");
    if (linesEl) {
      const itemLines = (order.items || [])
        .map(
          (i) =>
            `<div class="o-line"><span>${escapeForHtml(i.meal_name)} x${i.quantity}</span><span>GH₵${Number(i.total_price).toFixed(2)}</span></div>`
        )
        .join("");
      linesEl.innerHTML =
        itemLines + `<div class="o-total"><span>Total Paid</span><span>GH₵${Number(order.grand_total).toFixed(2)}</span></div>`;
    }

    const detailsEl = document.getElementById("oDetails");
    if (detailsEl) {
      const etaLabel =
        order.delivery_method === "delivery" ? "Estimated delivery" : "Estimated pickup";
      detailsEl.innerHTML = `
        <div class="o-line"><span>Customer</span><span>${escapeForHtml(order.customer_name)}</span></div>
        <div class="o-line"><span>Phone</span><span>${escapeForHtml(order.phone_number)}</span></div>
        <div class="o-line"><span>Payment</span><span>${escapeForHtml(String(order.payment_method).replace(/_/g, " "))} &middot; ${escapeForHtml(order.payment_status)}</span></div>
        <div class="o-line"><span>${order.delivery_method === "delivery" ? "Delivery to" : "Pickup method"}</span><span>${order.delivery_method === "delivery" ? escapeForHtml(order.delivery_address || "—") : "Collect in restaurant"}</span></div>
        <div class="o-line"><span>${etaLabel}</span><span>25 &ndash; 35 minutes</span></div>
      `;
    }

    // Stash the full order on the modal element so the receipt/print/track
    // buttons (wired below) can read it without re-fetching.
    const modal = document.getElementById("confirmModal");
    if (modal) modal._lastOrder = order;
  }

  function escapeForHtml(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---- Download PDF Receipt --------------------------------------------
  function downloadReceiptPDF() {
    const order = document.getElementById("confirmModal")?._lastOrder;
    if (!order) return;

    // jsPDF is loaded on-demand only when this button is actually pressed,
    // so the main site's load time is never affected by a library most
    // visitors will never trigger.
    function withJsPDF(cb) {
      if (window.jspdf) return cb();
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      script.onload = cb;
      document.head.appendChild(script);
    }

    withJsPDF(() => {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: "pt", format: "a4" });
      const left = 48;
      let y = 56;

      doc.setFont("helvetica", "bold");
      doc.setFontSize(18);
      doc.text("Burger King Ghana", left, y);
      y += 18;
      doc.setFontSize(11);
      doc.setFont("helvetica", "normal");
      doc.text("Order Receipt", left, y);
      y += 28;

      doc.setFont("helvetica", "bold");
      doc.text("Order Reference:", left, y);
      doc.setFont("helvetica", "normal");
      doc.text(order.order_reference, left + 140, y);
      y += 20;

      doc.setFont("helvetica", "bold");
      doc.text("Customer:", left, y);
      doc.setFont("helvetica", "normal");
      doc.text(order.customer_name + "  (" + order.phone_number + ")", left + 140, y);
      y += 20;

      doc.setFont("helvetica", "bold");
      doc.text("Delivery Method:", left, y);
      doc.setFont("helvetica", "normal");
      doc.text(order.delivery_method === "delivery" ? "Delivery" : "Pickup", left + 140, y);
      y += 20;

      if (order.delivery_address) {
        doc.setFont("helvetica", "bold");
        doc.text("Address:", left, y);
        doc.setFont("helvetica", "normal");
        doc.text(doc.splitTextToSize(order.delivery_address, 360), left + 140, y);
        y += 20;
      }

      doc.setFont("helvetica", "bold");
      doc.text("Payment Method:", left, y);
      doc.setFont("helvetica", "normal");
      doc.text(String(order.payment_method).replace(/_/g, " "), left + 140, y);
      y += 20;

      doc.setFont("helvetica", "bold");
      doc.text("Payment Status:", left, y);
      doc.setFont("helvetica", "normal");
      doc.text(String(order.payment_status), left + 140, y);
      y += 30;

      doc.setFont("helvetica", "bold");
      doc.text("Meals Ordered", left, y);
      y += 18;
      doc.setFont("helvetica", "normal");
      (order.items || []).forEach((item) => {
        doc.text(`${item.meal_name}  x${item.quantity}`, left, y);
        doc.text(`GH₵${Number(item.total_price).toFixed(2)}`, left + 400, y);
        y += 18;
      });
      y += 10;

      doc.setLineWidth(0.5);
      doc.line(left, y, left + 470, y);
      y += 20;

      const totalsRow = (label, value, bold) => {
        doc.setFont("helvetica", bold ? "bold" : "normal");
        doc.text(label, left + 300, y);
        doc.text(value, left + 430, y);
        y += 18;
      };
      totalsRow("Subtotal", "GH₵" + Number(order.subtotal).toFixed(2));
      totalsRow("Delivery Fee", "GH₵" + Number(order.delivery_fee).toFixed(2));
      totalsRow("Discount", "-GH₵" + Number(order.discount).toFixed(2));
      totalsRow("Tax", "GH₵" + Number(order.tax).toFixed(2));
      totalsRow("Grand Total", "GH₵" + Number(order.grand_total).toFixed(2), true);

      y += 20;
      doc.setFont("helvetica", "italic");
      doc.setFontSize(9);
      doc.text("Thank you for ordering from Burger King Ghana. For support, call 0244 704 066.", left, y);

      doc.save(`${order.order_reference}-receipt.pdf`);
    });
  }

  function printReceipt() {
    const order = document.getElementById("confirmModal")?._lastOrder;
    if (!order) return;
    const w = window.open("", "_blank");
    const itemsHtml = (order.items || [])
      .map(
        (i) =>
          `<tr><td>${i.meal_name}</td><td>${i.quantity}</td><td>GH₵${Number(i.total_price).toFixed(2)}</td></tr>`
      )
      .join("");
    w.document.write(`
      <html><head><title>${order.order_reference} — Receipt</title>
      <style>
        body{font-family:Arial,sans-serif;padding:32px;color:#222;}
        h1{font-size:20px;margin-bottom:2px;}
        table{width:100%;border-collapse:collapse;margin-top:16px;}
        td,th{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left;font-size:13px;}
        .tot{font-weight:bold;font-size:15px;}
      </style></head><body>
      <h1>Burger King Ghana</h1>
      <p>Order Receipt — ${order.order_reference}</p>
      <p>${order.customer_name} · ${order.phone_number}</p>
      <table><thead><tr><th>Item</th><th>Qty</th><th>Total</th></tr></thead><tbody>${itemsHtml}</tbody></table>
      <p class="tot">Grand Total: GH₵${Number(order.grand_total).toFixed(2)}</p>
      </body></html>
    `);
    w.document.close();
    w.focus();
    w.print();
  }

  function copyOrderReference() {
    const order = document.getElementById("confirmModal")?._lastOrder;
    if (!order) return;
    navigator.clipboard
      .writeText(order.order_reference)
      .then(() => {
        if (typeof showToast === "function") showToast("Order reference copied!");
      })
      .catch(() => {
        if (typeof showToast === "function") showToast("Could not copy — please copy manually.");
      });
  }

  function trackOrder() {
    const order = document.getElementById("confirmModal")?._lastOrder;
    if (!order) return;
    window.open(`track-order.html?ref=${encodeURIComponent(order.order_reference)}`, "_blank");
  }

  // Expose these globally so your existing modal buttons can call them with
  // simple onclick="downloadReceiptPDF()" etc., matching how the rest of
  // your site already wires up buttons.
  window.downloadReceiptPDF = downloadReceiptPDF;
  window.printReceipt = printReceipt;
  window.copyOrderReference = copyOrderReference;
  window.trackOrder = trackOrder;

  // ---- Override the existing placeOrder() function ----------------------
  // We wrap rather than delete: your original placeOrder() still runs the
  // UI side (closing the checkout modal, clearing the cart visually) — we
  // just swap out the fake reference generation for a real backend call.
  function installOverride() {
    const originalPlaceOrder = window.placeOrder;

    window.placeOrder = async function () {
      if (!currentIdempotencyKey) newIdempotencyKey();

      const order = await submitOrderToBackend();
      if (!order) return; // validation or network error already shown to the user

      populateConfirmModal(order);

      // Run your site's original UI behavior (close checkout modal, open
      // confirmation modal, clear cart) but skip its fake-reference logic
      // by calling a lightweight version: just open the confirm modal and
      // clear state, matching what the original function did visually.
      if (typeof closeM === "function") closeM("coModal");
      if (typeof cart !== "undefined") cart.length = 0;
      if (typeof saveCart === "function") saveCart();
      if (typeof renderCart === "function") renderCart();
      const confirmModal = document.getElementById("confirmModal");
      if (confirmModal) confirmModal.classList.add("open");
    };

    // Generate a fresh idempotency key whenever the checkout modal opens,
    // so re-opening checkout for a new order never reuses an old key.
    const originalOpenCheckout = window.openCheckout;
    if (typeof originalOpenCheckout === "function") {
      window.openCheckout = function (...args) {
        newIdempotencyKey();
        return originalOpenCheckout.apply(this, args);
      };
    }
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    installOverride();
  } else {
    document.addEventListener("DOMContentLoaded", installOverride);
  }
})();

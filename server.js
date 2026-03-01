// server.js
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// ==================== MongoDB Connection ====================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.log(err));

// ==================== Models ====================
const serviceSchema = new mongoose.Schema({
  name: String,
  price: Number,
});
const Service = mongoose.model("Service", serviceSchema);

const orderSchema = new mongoose.Schema({
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service" },
  serviceName: String,
  amount: Number,
  username: String,
  email: String,
  phone: String,
  quantity: Number,
  status: { type: String, default: "pending" }, // pending, paid, processing, completed
  ref: String,
  providerId: String,
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model("Order", orderSchema);

// Optional: Admin user (if you want to store in DB)
const adminSchema = new mongoose.Schema({
  email: String,
  password: String, // hashed
});
const Admin = mongoose.model("Admin", adminSchema);

// ==================== Helper Functions ====================
const sendEmail = async (to, subject, text) => {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  await transporter.sendMail({
    from: `FastPlug <${process.env.SMTP_USER}>`,
    to,
    subject,
    text
  });
};

const sendTelegram = async (msg) => {
  await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: process.env.TELEGRAM_CHAT,
    text: msg
  });
};

const sendWhatsApp = async (phone, msg) => {
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: msg }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
};

const fulfillOrder = async (order) => {
  const res = await axios.post("https://exosupplier.com/api/v2", {
    key: process.env.EXO_KEY,
    action: "add",
    service: order.serviceId,
    link: order.username,
    quantity: order.quantity
  });
  return res.data;
};

// ==================== JWT Middleware ====================
const verifyAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token provided" });

  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.admin = decoded;
    next();
  });
};

// ==================== Public Routes ====================
// Get all services
app.get("/api/services", async (req, res) => {
  try {
    const services = await Service.find();
    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create order (public, returns checkout URL)
app.post("/api/orders/create", async (req, res) => {
  try {
    const { serviceId, username, email, phone, quantity } = req.body;
    // Get service details
    const service = await Service.findById(serviceId);
    if (!service) return res.status(404).json({ error: "Service not found" });

    const amount = service.price * quantity;
    const ref = `FP-${Date.now()}`;

    const order = new Order({
      serviceId,
      serviceName: service.name,
      amount,
      username,
      email,
      phone,
      quantity,
      ref
    });
    await order.save();

    // Here you would generate a real Korapay checkout URL
    // For now, we simulate:
    const checkout_url = `https://checkout.korapay.com/pay/${ref}`;

    res.json({ checkout_url, ref });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Korapay webhook (public)
app.post("/api/kora/webhook", async (req, res) => {
  try {
    const event = req.body;
    if (event.event === "charge.success") {
      const ref = event.data.reference;
      const order = await Order.findOne({ ref });
      if (!order) return res.sendStatus(404);

      if (order.status === "paid") return res.sendStatus(200);

      order.status = "paid";
      await order.save();

      // Auto-fulfill
      const exo = await fulfillOrder(order);
      order.providerId = exo.order;
      order.status = "processing";
      await order.save();

      // Notifications
      await sendEmail(order.email, "Payment Received", `Order confirmed. Ref: ${order.ref}`);
      await sendTelegram(`✅ New Paid Order\nService: ${order.serviceName}\nUser: ${order.email}`);
      if (order.phone) {
        await sendWhatsApp(order.phone, `Payment received. Order: ${order.ref}`);
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Get order status by ref (public)
app.get("/api/orders/:ref", async (req, res) => {
  try {
    const order = await Order.findOne({ ref: req.params.ref });
    if (!order) return res.status(404).json({ error: "Not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Admin Routes ====================
// Admin login
app.post("/api/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    // For simplicity, we'll check against a single admin from env
    // Or you can check against Admin collection
    if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASS) {
      const token = jwt.sign({ email, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "7d" });
      return res.json({ success: true, token });
    }
    // If using DB:
    // const admin = await Admin.findOne({ email });
    // if (!admin) return res.json({ success: false, message: "Invalid credentials" });
    // const match = await bcrypt.compare(password, admin.password);
    // if (!match) return res.json({ success: false, message: "Invalid credentials" });
    // const token = jwt.sign({ email: admin.email, role: "admin" }, process.env.JWT_SECRET, { expiresIn: "7d" });
    // res.json({ success: true, token });

    res.json({ success: false, message: "Invalid credentials" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Add new service (protected)
app.post("/api/admin/services", verifyAdmin, async (req, res) => {
  try {
    const { name, price } = req.body;
    const service = new Service({ name, price });
    await service.save();
    res.json({ message: "Service added successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all orders (protected)
app.get("/api/admin/orders", verifyAdmin, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create Korapay payment for an order (protected) – used in dashboard
app.post("/api/pay/kora", verifyAdmin, async (req, res) => {
  try {
    const { orderId, amount } = req.body;
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // In a real scenario, you'd create a Korapay payment intent and get checkout URL
    // For now, simulate:
    const checkout_url = `https://checkout.korapay.com/pay/${order.ref}`;

    res.json({ checkout_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Auto-check ExoSupplier status ====================
async function checkStatus() {
  try {
    const orders = await Order.find({ status: "processing" });
    for (const o of orders) {
      const res = await axios.post("https://exosupplier.com/api/v2", {
        key: process.env.EXO_KEY,
        action: "status",
        order: o.providerId
      });
      if (res.data.status === "Completed") {
        o.status = "completed";
        await o.save();
      }
    }
  } catch (err) {
    console.error("Status check error:", err);
  }
}
setInterval(checkStatus, 600000); // every 10 min

// ==================== Start Server ====================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
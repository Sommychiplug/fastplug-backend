import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

/*
  TEMP STORAGE (replace with DB later)
*/
let users = {};
let orders = {};

/*
  1️⃣ CREATE PAYMENT (Korapay)
*/
app.post("/initialize-payment", async (req, res) => {
  try {
    const { email, amount, userId } = req.body;

    const response = await axios.post(
      "https://api.korapay.com/merchant/api/v1/charges/initialize",
      {
        amount,
        currency: "NGN",
        reference: "FP_" + Date.now(),
        customer: { email },
        notification_url:
          "https://YOUR-RENDER-URL.onrender.com/korapay-webhook"
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.KORAPAY_SECRET_KEY}`
        }
      }
    );

    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*
  2️⃣ KORAPAY WEBHOOK
*/
app.post("/korapay-webhook", async (req, res) => {
  try {
    const event = req.body;

    if (event.event === "charge.success") {
      const amount = event.data.amount;
      const email = event.data.customer.email;

      if (!users[email]) users[email] = { balance: 0 };
      users[email].balance += amount;

      console.log("Balance credited:", email, amount);
    }

    res.sendStatus(200);
  } catch (err) {
    console.log(err);
    res.sendStatus(500);
  }
});

/*
  3️⃣ CREATE ORDER (after balance)
*/
app.post("/create-order", async (req, res) => {
  try {
    const { email, service, link, quantity, price } = req.body;

    if (!users[email] || users[email].balance < price) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // deduct balance
    users[email].balance -= price;

    // send to supplier
    const supplierRes = await axios.post(
      process.env.SUPPLIER_API_URL,
      {
        key: process.env.SUPPLIER_API_KEY,
        action: "add",
        service,
        link,
        quantity
      }
    );

    orders[Date.now()] = {
      email,
      service,
      link,
      quantity
    };

    res.json({
      success: true,
      supplier: supplierRes.data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*
  4️⃣ CHECK BALANCE
*/
app.post("/balance", (req, res) => {
  const { email } = req.body;
  const balance = users[email]?.balance || 0;
  res.json({ balance });
});

app.listen(PORT, () => {
  console.log("FastPlug backend running on", PORT);
});
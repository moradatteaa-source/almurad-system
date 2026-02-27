import fetch from "node-fetch";
import FormData from "form-data";

// 🟢 تسجيل دخول
export async function login(username, password) {

  const formData = new FormData();
  formData.append("username", username);
  formData.append("password", password);

  const response = await fetch(
    "https://api.alwaseet-iq.net/v1/merchant/login",
    {
      method: "POST",
      body: formData
    }
  );

  return await response.json();
}


// 🟢 إنشاء طلب
export async function createOrder(payload, token) {

  payload.promo_code = "الوسيط";

  const formData = new FormData();
  for (const key in payload) {
    formData.append(key, payload[key] ?? "");
  }

  const url = `https://api.alwaseet-iq.net/v1/merchant/create-order?token=${token}`;

  const response = await fetch(url, {
    method: "POST",
    body: formData
  });

  return await response.json();
}